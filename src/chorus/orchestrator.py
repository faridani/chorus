from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from chorus.backends import (
    RUN_STATUS_CANCELLED,
    RUN_STATUS_FAILED,
    RUN_STATUS_QUOTA_EXHAUSTED,
    RUN_STATUS_SUCCEEDED,
    CodexCliBackend,
)
from chorus.persistence import ChorusStore
from chorus.projects import ProjectContextMissingError, require_project_context
from chorus.tickets import (
    TICKET_STATUS_BLOCKED,
    TICKET_STATUS_IN_PROGRESS,
    TICKET_STATUS_READY,
    TICKET_STATUS_REVIEW,
    TicketTransitionError,
    transition_ticket,
)


logger = logging.getLogger(__name__)

AGENT_STATUS_IDLE = "idle"
AGENT_STATUS_RUNNING = "running"
AGENT_STATUS_PAUSED = "paused"

TASK_STATUS_QUEUED = "queued"
TASK_STATUS_RUNNING = "running"
TASK_STATUS_REVIEW = "review"
TASK_STATUS_BLOCKED = "blocked"
TASK_STATUS_CANCELLED = "cancelled"
TASK_STATUS_QUOTA_EXHAUSTED = "quota_exhausted"

RUN_STATUS_PENDING = "pending"
ACTIVE_RUN_STATUSES = frozenset({RUN_STATUS_PENDING, "running"})
TERMINAL_RUN_STATUSES = frozenset(
    {
        RUN_STATUS_SUCCEEDED,
        RUN_STATUS_FAILED,
        RUN_STATUS_QUOTA_EXHAUSTED,
        RUN_STATUS_CANCELLED,
    }
)
ACTIVE_TASK_STATUSES = frozenset(
    {TASK_STATUS_QUEUED, TASK_STATUS_RUNNING, TASK_STATUS_QUOTA_EXHAUSTED}
)


class OrchestrationBlockedError(RuntimeError):
    """Raised when orchestration cannot safely start for a project."""


class AgentRunHandle(Protocol):
    """Handle returned by an AI backend after starting a task."""

    @property
    def run_id(self) -> str:
        """Persisted run identifier."""

    @property
    def is_done(self) -> bool:
        """Whether the backend process has finished."""

    def wait(self, timeout: float | None = None) -> object:
        """Return the backend-specific final run result."""


class AgentBackend(Protocol):
    """Backend adapter capable of starting persisted agent runs."""

    def start_task(
        self,
        *,
        project_id: str,
        prompt: str,
        repo_path: str | Path,
        task_id: str | None = None,
        agent_id: str | None = None,
    ) -> AgentRunHandle:
        """Start the agent task and return a cancellable/pollable handle."""


@dataclass(frozen=True)
class StartedAgentTask:
    """Task/run pair started during one orchestrator tick."""

    ticket_id: str
    task_id: str
    run_id: str
    agent_id: str
    branch_name: str

    def to_dict(self) -> dict[str, str]:
        return {
            "ticket_id": self.ticket_id,
            "task_id": self.task_id,
            "run_id": self.run_id,
            "agent_id": self.agent_id,
            "branch_name": self.branch_name,
        }


class Orchestrator:
    """Coordinates project preflight, ticket dispatch, and run reconciliation."""

    def __init__(
        self,
        store: ChorusStore,
        *,
        backends: Mapping[str, AgentBackend] | None = None,
    ) -> None:
        self.store = store
        self.backends: dict[str, AgentBackend] = {"codex": CodexCliBackend(store)}
        if backends is not None:
            self.backends.update(dict(backends))
        self._active_handles: dict[str, AgentRunHandle] = {}

    def start_agents(self, project_id: str) -> dict[str, object]:
        try:
            return require_project_context(self.store, project_id)
        except ProjectContextMissingError as exc:
            raise OrchestrationBlockedError(str(exc)) from exc

    def run_once(self, project_id: str) -> dict[str, object]:
        """Run one durable orchestration tick for a project.

        A tick first reconciles finished runs, then dispatches ready tickets to
        idle workers. All decisions are based on persisted state, so creating a
        new Orchestrator instance after a service restart will not duplicate
        already-active ticket work.
        """

        project = self.start_agents(project_id)
        reconciled_run_ids = self._reconcile_project_runs(project_id)
        started_tasks = self._dispatch_ready_tickets(project)
        reconciled_run_ids.extend(self._reconcile_project_runs(project_id))

        return {
            "project_id": project_id,
            "started_task_ids": [task.task_id for task in started_tasks],
            "started_run_ids": [task.run_id for task in started_tasks],
            "reconciled_run_ids": reconciled_run_ids,
            "started": [task.to_dict() for task in started_tasks],
        }

    def run_loop(
        self,
        project_id: str,
        *,
        poll_interval_seconds: float = 5.0,
        max_ticks: int | None = None,
        stop_when_idle: bool = False,
    ) -> list[dict[str, object]]:
        """Run orchestration ticks until stopped by caller-supplied limits."""

        results: list[dict[str, object]] = []
        tick_count = 0
        while max_ticks is None or tick_count < max_ticks:
            result = self.run_once(project_id)
            results.append(result)
            tick_count += 1
            if (
                stop_when_idle
                and not result["started_run_ids"]
                and not result["reconciled_run_ids"]
                and not self._has_active_work(project_id)
            ):
                break
            if max_ticks is not None and tick_count >= max_ticks:
                break
            time.sleep(poll_interval_seconds)
        return results

    def _dispatch_ready_tickets(self, project: Mapping[str, object]) -> list[StartedAgentTask]:
        project_id = str(project["id"])
        roles = _active_roles_by_id(self.store, project_id)
        available_agents = self._available_agents_by_role(project_id, roles)
        active_ticket_ids = self._active_ticket_ids(project_id)

        started: list[StartedAgentTask] = []
        tickets = self.store.tickets.list(
            filters={"project_id": project_id, "status": TICKET_STATUS_READY},
            order_by="created_at",
        )
        for ticket in sorted(tickets, key=_ticket_priority_key):
            ticket_id = str(ticket["id"])
            if ticket_id in active_ticket_ids:
                continue

            role_id = _string_or_none(ticket.get("assigned_role_id"))
            if role_id is None or role_id not in roles:
                continue

            role_agents = available_agents.get(role_id)
            if not role_agents:
                continue

            agent = role_agents.pop(0)
            started_task = self._start_ticket(project, roles[role_id], agent, ticket)
            started.append(started_task)
            active_ticket_ids.add(ticket_id)

        return started

    def _start_ticket(
        self,
        project: Mapping[str, object],
        role: Mapping[str, object],
        agent: Mapping[str, object],
        ticket: Mapping[str, object],
    ) -> StartedAgentTask:
        project_id = str(project["id"])
        ticket_id = str(ticket["id"])
        agent_id = str(agent["id"])
        role_id = str(role["id"])
        branch = self._allocate_branch(project, role, ticket)
        context = self._build_task_context(project, role, agent, ticket, branch)
        prompt = _build_agent_prompt(context)
        now = _utc_now()
        attempt_count = self._next_attempt_count(ticket_id)

        task = self.store.tasks.create(
            project_id=project_id,
            ticket_id=ticket_id,
            role_id=role_id,
            assigned_agent_id=agent_id,
            title=str(ticket["title"]),
            instructions=prompt,
            status=TASK_STATUS_QUEUED,
            branch_name=branch["branch_name"],
            base_branch=branch["base_branch"],
            integration_branch=branch["integration_branch"],
            priority=int(ticket.get("priority") or 0),
            attempt_count=attempt_count,
            context_json=context,
            scheduled_at=now,
        )
        self._transition_ticket(ticket_id, TICKET_STATUS_IN_PROGRESS)
        self.store.agents.update(
            agent_id,
            status=AGENT_STATUS_RUNNING,
            branch_name=branch["branch_name"],
            worktree_path=branch["worktree_path"],
            last_heartbeat_at=now,
            state_json={
                **_mapping_or_empty(agent.get("state_json")),
                "current_task_id": task["id"],
                "current_ticket_id": ticket_id,
                "current_branch_name": branch["branch_name"],
            },
        )

        backend = self._backend_for_agent(agent)
        try:
            handle = backend.start_task(
                project_id=project_id,
                task_id=str(task["id"]),
                agent_id=agent_id,
                repo_path=branch["worktree_path"],
                prompt=prompt,
            )
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            self._mark_start_failure(task, agent, ticket_id, error)
            raise OrchestrationBlockedError(error) from exc

        run_id = str(handle.run_id)
        self._active_handles[run_id] = handle
        self.store.tasks.update(
            str(task["id"]),
            status=TASK_STATUS_RUNNING,
            started_at=now,
            state_json={
                "run_id": run_id,
                "backend": str(agent.get("backend") or "codex"),
                "branch_state_id": branch.get("branch_state_id"),
            },
        )
        self.store.agents.update(
            agent_id,
            last_heartbeat_at=now,
            state_json={
                **_mapping_or_empty(agent.get("state_json")),
                "current_task_id": task["id"],
                "current_ticket_id": ticket_id,
                "current_run_id": run_id,
                "current_branch_name": branch["branch_name"],
            },
        )
        return StartedAgentTask(
            ticket_id=ticket_id,
            task_id=str(task["id"]),
            run_id=run_id,
            agent_id=agent_id,
            branch_name=str(branch["branch_name"]),
        )

    def _mark_start_failure(
        self,
        task: Mapping[str, object],
        agent: Mapping[str, object],
        ticket_id: str,
        error: str,
    ) -> None:
        now = _utc_now()
        self.store.tasks.update(
            str(task["id"]),
            status=TASK_STATUS_BLOCKED,
            result_json={"error": error},
            finished_at=now,
        )
        self.store.agents.update(
            str(agent["id"]),
            status=AGENT_STATUS_IDLE,
            branch_name=None,
            last_heartbeat_at=now,
            state_json={
                **_mapping_or_empty(agent.get("state_json")),
                "last_error": error,
                "last_task_id": task["id"],
            },
        )
        self._transition_ticket(ticket_id, TICKET_STATUS_BLOCKED)

    def _backend_for_agent(self, agent: Mapping[str, object]) -> AgentBackend:
        backend_name = str(agent.get("backend") or "codex")
        backend = self.backends.get(backend_name)
        if backend is None:
            raise OrchestrationBlockedError(f"No backend configured for agent backend: {backend_name}")
        return backend

    def _available_agents_by_role(
        self,
        project_id: str,
        active_roles: Mapping[str, Mapping[str, object]],
    ) -> dict[str, list[dict[str, object]]]:
        busy_agent_ids = self._busy_agent_ids(project_id)
        agents_by_role: dict[str, list[dict[str, object]]] = {}
        agents = self.store.agents.list(filters={"project_id": project_id}, order_by="created_at")
        for agent in agents:
            agent_id = str(agent["id"])
            role_id = _string_or_none(agent.get("role_id"))
            if (
                role_id is None
                or role_id not in active_roles
                or str(agent.get("status") or AGENT_STATUS_IDLE) != AGENT_STATUS_IDLE
                or agent_id in busy_agent_ids
            ):
                continue
            agents_by_role.setdefault(role_id, []).append(agent)
        return agents_by_role

    def _busy_agent_ids(self, project_id: str) -> set[str]:
        busy: set[str] = set()
        for task in self.store.tasks.list(filters={"project_id": project_id}, order_by=None):
            if str(task.get("status")) in ACTIVE_TASK_STATUSES:
                agent_id = _string_or_none(task.get("assigned_agent_id"))
                if agent_id is not None:
                    busy.add(agent_id)
        for run in self.store.runs.list(filters={"project_id": project_id}, order_by=None):
            if str(run.get("status")) in ACTIVE_RUN_STATUSES:
                agent_id = _string_or_none(run.get("agent_id"))
                if agent_id is not None:
                    busy.add(agent_id)
        return busy

    def _active_ticket_ids(self, project_id: str) -> set[str]:
        active: set[str] = set()
        for task in self.store.tasks.list(filters={"project_id": project_id}, order_by=None):
            if str(task.get("status")) in ACTIVE_TASK_STATUSES:
                ticket_id = _string_or_none(task.get("ticket_id"))
                if ticket_id is not None:
                    active.add(ticket_id)
        return active

    def _has_active_work(self, project_id: str) -> bool:
        for run_id in self._active_handles:
            run = self.store.runs.get(run_id)
            if run is not None and str(run.get("project_id")) == project_id:
                return True
        for task in self.store.tasks.list(filters={"project_id": project_id}, order_by=None):
            if str(task.get("status")) in ACTIVE_TASK_STATUSES:
                return True
        for run in self.store.runs.list(filters={"project_id": project_id}, order_by=None):
            if str(run.get("status")) in ACTIVE_RUN_STATUSES:
                return True
        return False

    def _next_attempt_count(self, ticket_id: str) -> int:
        tasks = self.store.tasks.list(filters={"ticket_id": ticket_id}, order_by=None)
        return len(tasks) + 1

    def _allocate_branch(
        self,
        project: Mapping[str, object],
        role: Mapping[str, object],
        ticket: Mapping[str, object],
    ) -> dict[str, object]:
        project_id = str(project["id"])
        branch_name = _branch_name_for(role, ticket)
        base_branch = str(project.get("integration_branch") or project.get("default_branch") or "main")
        integration_branch = str(project.get("integration_branch") or base_branch)
        worktree_path = _string_or_none(project.get("local_path"))
        if worktree_path is None:
            raise OrchestrationBlockedError("Project has no local path for agent execution.")

        existing = self.store.branch_states.list(
            filters={"project_id": project_id, "branch_name": branch_name},
            order_by=None,
            limit=1,
        )
        branch_state_values = {
            "kind": "agent",
            "status": "allocated",
            "base_branch": base_branch,
            "worktree_path": worktree_path,
            "last_checked_at": _utc_now(),
            "state_json": {
                "ticket_id": ticket["id"],
                "role_id": role["id"],
                "allocated_by": "orchestrator",
            },
        }
        if existing:
            branch_state = self.store.branch_states.update(
                str(existing[0]["id"]),
                **branch_state_values,
            )
        else:
            branch_state = self.store.branch_states.create(
                project_id=project_id,
                branch_name=branch_name,
                **branch_state_values,
            )

        return {
            "branch_state_id": branch_state["id"],
            "branch_name": branch_name,
            "base_branch": base_branch,
            "integration_branch": integration_branch,
            "worktree_path": worktree_path,
        }

    def _build_task_context(
        self,
        project: Mapping[str, object],
        role: Mapping[str, object],
        agent: Mapping[str, object],
        ticket: Mapping[str, object],
        branch: Mapping[str, object],
    ) -> dict[str, object]:
        project_context = _project_context(project)
        return {
            "project": {
                "id": project["id"],
                "name": project["name"],
                "repo_url": project["repo_url"],
                "local_path": project.get("local_path"),
                "default_branch": project.get("default_branch"),
                "integration_branch": project.get("integration_branch"),
                "spec_path": project.get("spec_path"),
                "architecture_path": project.get("architecture_path"),
            },
            "project_context": project_context,
            "role": {
                "id": role["id"],
                "name": role["name"],
                "description": role.get("description") or "",
                "allowed_actions": list(role.get("allowed_actions_json") or []),
                "forbidden_actions": list(role.get("forbidden_actions_json") or []),
            },
            "agent": {
                "id": agent["id"],
                "name": agent["name"],
                "backend": agent.get("backend") or "codex",
            },
            "guardrails": _guardrails_for_role(self.store, str(project["id"]), str(role["id"])),
            "ticket": {
                "id": ticket["id"],
                "title": ticket["title"],
                "body": _ticket_body(ticket),
                "priority": ticket.get("priority") or 0,
                "labels": list(ticket.get("labels_json") or []),
                "metadata": dict(ticket.get("metadata_json") or {}),
            },
            "branch": dict(branch),
        }

    def _reconcile_project_runs(self, project_id: str) -> list[str]:
        reconciled = self._reconcile_finished_handles(project_id)
        reconciled.extend(self._reconcile_terminal_runs(project_id))
        return list(dict.fromkeys(reconciled))

    def _reconcile_finished_handles(self, project_id: str) -> list[str]:
        reconciled: list[str] = []
        for run_id, handle in list(self._active_handles.items()):
            if not handle.is_done:
                continue
            run = self.store.runs.get(run_id)
            if run is None or str(run.get("project_id")) != project_id:
                continue
            # Isolate per-run failures: a single bad result (disk/DB hiccup,
            # missing output) must not abort reconciliation for the whole loop.
            try:
                result = handle.wait(timeout=0)
                self._active_handles.pop(run_id, None)
                status = str(getattr(result, "status"))
                exit_code = getattr(result, "exit_code", None)
                if self._apply_run_status(run_id, status, exit_code=exit_code):
                    reconciled.append(run_id)
            except Exception:  # noqa: BLE001 - defensive: keep the loop alive
                logger.exception("Failed to reconcile run %s", run_id)
                self._active_handles.pop(run_id, None)
        return reconciled

    def _reconcile_terminal_runs(self, project_id: str) -> list[str]:
        reconciled: list[str] = []
        for run in self.store.runs.list(filters={"project_id": project_id}, order_by="created_at"):
            status = str(run.get("status"))
            if status in TERMINAL_RUN_STATUSES and self._apply_run_status(str(run["id"]), status):
                reconciled.append(str(run["id"]))
        return reconciled

    def _apply_run_status(
        self,
        run_id: str,
        status: str,
        *,
        exit_code: int | None = None,
    ) -> bool:
        if status not in TERMINAL_RUN_STATUSES:
            return False

        run = self.store.runs.require(run_id)
        task_id = _string_or_none(run.get("task_id"))
        agent_id = _string_or_none(run.get("agent_id"))
        if task_id is None or agent_id is None:
            return False

        task = self.store.tasks.require(task_id)
        if str(task.get("status")) not in ACTIVE_TASK_STATUSES:
            return False
        task_result = _mapping_or_empty(task.get("result_json"))
        if task_result.get("run_id") == run_id and task_result.get("run_status") == status:
            return False

        now = _utc_now()
        run_changes: dict[str, object] = {}
        if str(run.get("status")) != status:
            run_changes["status"] = status
        if exit_code is not None and run.get("exit_code") is None:
            run_changes["exit_code"] = exit_code
        if run.get("finished_at") is None:
            run_changes["finished_at"] = now
        if run_changes:
            self.store.runs.update(run_id, **run_changes)

        task_status, ticket_status, agent_status = _statuses_for_run(status)
        self.store.tasks.update(
            task_id,
            status=task_status,
            result_json={
                **task_result,
                "run_id": run_id,
                "run_status": status,
                "exit_code": exit_code if exit_code is not None else run.get("exit_code"),
            },
            finished_at=now if task_status != TASK_STATUS_QUOTA_EXHAUSTED else None,
            state_json={
                **_mapping_or_empty(task.get("state_json")),
                "last_run_status": status,
            },
        )

        ticket_id = _string_or_none(task.get("ticket_id"))
        if ticket_id is not None:
            self._transition_ticket(ticket_id, ticket_status)

        agent = self.store.agents.require(agent_id)
        state = {
            **_mapping_or_empty(agent.get("state_json")),
            "last_run_id": run_id,
            "last_task_id": task_id,
            "last_run_status": status,
        }
        for key in ("current_run_id", "current_task_id", "current_ticket_id"):
            state.pop(key, None)
        self.store.agents.update(
            agent_id,
            status=agent_status,
            branch_name=task.get("branch_name") if agent_status == AGENT_STATUS_PAUSED else None,
            last_heartbeat_at=now,
            state_json=state,
        )
        return True

    def _transition_ticket(self, ticket_id: str, target_status: str) -> None:
        ticket = self.store.tickets.require(ticket_id)
        current_status = str(ticket["status"])
        if current_status == target_status:
            return
        try:
            if current_status == TICKET_STATUS_READY and target_status == TICKET_STATUS_REVIEW:
                transition_ticket(self.store, ticket_id, TICKET_STATUS_IN_PROGRESS)
            transition_ticket(self.store, ticket_id, target_status)
        except TicketTransitionError:
            return


def _active_roles_by_id(
    store: ChorusStore,
    project_id: str,
) -> dict[str, dict[str, object]]:
    roles = store.roles.list(filters={"project_id": project_id}, order_by="created_at")
    return {
        str(role["id"]): role
        for role in roles
        if str(role.get("status") or "active") == "active"
    }


def _ticket_priority_key(ticket: Mapping[str, object]) -> tuple[int, str, str]:
    return (
        -int(ticket.get("priority") or 0),
        str(ticket.get("created_at") or ""),
        str(ticket["id"]),
    )


def _statuses_for_run(status: str) -> tuple[str, str, str]:
    if status == RUN_STATUS_SUCCEEDED:
        return TASK_STATUS_REVIEW, TICKET_STATUS_REVIEW, AGENT_STATUS_IDLE
    if status == RUN_STATUS_QUOTA_EXHAUSTED:
        return TASK_STATUS_QUOTA_EXHAUSTED, TICKET_STATUS_IN_PROGRESS, AGENT_STATUS_PAUSED
    if status == RUN_STATUS_CANCELLED:
        return TASK_STATUS_CANCELLED, TICKET_STATUS_BLOCKED, AGENT_STATUS_IDLE
    return TASK_STATUS_BLOCKED, TICKET_STATUS_BLOCKED, AGENT_STATUS_IDLE


def _branch_name_for(role: Mapping[str, object], ticket: Mapping[str, object]) -> str:
    role_slug = _slug(str(role.get("name") or "agent"))
    ticket_slug = _slug(str(ticket.get("title") or "ticket"))
    ticket_prefix = str(ticket["id"]).split("-")[0][:8]
    return f"chorus/agent/{role_slug}/{ticket_slug}-{ticket_prefix}"


def _slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip().lower())
    slug = re.sub(r"-+", "-", slug).strip(".-/")
    return slug[:48] or "item"


def _project_context(project: Mapping[str, object]) -> dict[str, object]:
    return {
        "spec": _read_project_file(project, "spec_path"),
        "architecture": _read_project_file(project, "architecture_path"),
    }


def _read_project_file(project: Mapping[str, object], path_key: str) -> dict[str, object]:
    relative_path = _string_or_none(project.get(path_key))
    local_path = _string_or_none(project.get("local_path"))
    if relative_path is None or local_path is None:
        return {"path": relative_path, "content": ""}

    root = Path(local_path)
    path = root.joinpath(*relative_path.split("/"))
    try:
        content = path.read_text(encoding="utf-8")
    except OSError as exc:
        return {"path": relative_path, "content": "", "error": str(exc)}
    return {"path": relative_path, "content": content}


def _guardrails_for_role(
    store: ChorusStore,
    project_id: str,
    role_id: str,
) -> list[dict[str, object]]:
    guardrails: list[dict[str, object]] = []
    for guardrail in store.guardrails.list(filters={"project_id": project_id}, order_by="created_at"):
        guardrail_role_id = _string_or_none(guardrail.get("role_id"))
        if not guardrail.get("is_enabled") or guardrail_role_id not in {None, role_id}:
            continue
        guardrails.append(
            {
                "id": guardrail["id"],
                "scope": guardrail["scope"],
                "name": guardrail["name"],
                "description": guardrail.get("description") or "",
                "rules": list(guardrail.get("rules_json") or []),
                "severity": guardrail["severity"],
            }
        )
    return guardrails


def _build_agent_prompt(context: Mapping[str, object]) -> str:
    project = _mapping_or_empty(context.get("project"))
    project_context = _mapping_or_empty(context.get("project_context"))
    role = _mapping_or_empty(context.get("role"))
    ticket = _mapping_or_empty(context.get("ticket"))
    branch = _mapping_or_empty(context.get("branch"))

    spec = _mapping_or_empty(project_context.get("spec"))
    architecture = _mapping_or_empty(project_context.get("architecture"))

    return "\n".join(
        (
            "# Chorus Agent Task",
            "",
            "## Project",
            f"Name: {project.get('name')}",
            f"Repository: {project.get('repo_url')}",
            f"Integration branch: {project.get('integration_branch')}",
            "",
            "## Branch",
            f"Work branch: {branch.get('branch_name')}",
            f"Base branch: {branch.get('base_branch')}",
            "",
            "## Role",
            f"Name: {role.get('name')}",
            f"Description: {role.get('description')}",
            f"Allowed actions: {json.dumps(role.get('allowed_actions') or [])}",
            f"Forbidden actions: {json.dumps(role.get('forbidden_actions') or [])}",
            "",
            "## Guardrails",
            json.dumps(context.get("guardrails") or [], indent=2, sort_keys=True),
            "",
            "## Ticket",
            f"ID: {ticket.get('id')}",
            f"Title: {ticket.get('title')}",
            f"Priority: {ticket.get('priority')}",
            f"Labels: {json.dumps(ticket.get('labels') or [])}",
            "",
            str(ticket.get("body") or ""),
            "",
            f"## Project Specification ({spec.get('path')})",
            str(spec.get("content") or ""),
            "",
            f"## Architecture ({architecture.get('path')})",
            str(architecture.get("content") or ""),
            "",
            "## Expected Output",
            "Complete the ticket on the assigned branch, commit your work, and report a concise status.",
        )
    )


def _ticket_body(ticket: Mapping[str, object]) -> str:
    body = ticket.get("body")
    if isinstance(body, str) and body:
        return body
    description = ticket.get("description")
    return description if isinstance(description, str) else ""


def _mapping_or_empty(value: object) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _string_or_none(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
