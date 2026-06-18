from __future__ import annotations

import sys
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from chorus.backends import RUN_STATUS_SUCCEEDED  # noqa: E402
from chorus.orchestrator import Orchestrator  # noqa: E402
from chorus.persistence import ChorusStore, open_store  # noqa: E402
from chorus.tickets import create_ticket, transition_ticket  # noqa: E402


@dataclass
class FakeRunResult:
    run_id: str
    status: str
    exit_code: int | None = None


class FakeRunHandle:
    def __init__(self, store: ChorusStore, run_id: str) -> None:
        self.store = store
        self.run_id = run_id
        self._result: FakeRunResult | None = None

    @property
    def is_done(self) -> bool:
        return self._result is not None

    def finish(self, status: str, exit_code: int | None = 0) -> None:
        self._result = FakeRunResult(self.run_id, status, exit_code)
        self.store.runs.update(
            self.run_id,
            status=status,
            exit_code=exit_code,
            finished_at="2026-06-15T12:00:00Z",
        )

    def wait(self, timeout: float | None = None) -> FakeRunResult:
        if self._result is None:
            raise TimeoutError("Fake run has not finished.")
        return self._result


class FakeBackend:
    def __init__(self, store: ChorusStore) -> None:
        self.store = store
        self.starts: list[dict[str, Any]] = []
        self.handles: list[FakeRunHandle] = []

    def start_task(
        self,
        *,
        project_id: str,
        prompt: str,
        repo_path: str | Path,
        task_id: str | None = None,
        agent_id: str | None = None,
    ) -> FakeRunHandle:
        run = self.store.runs.create(
            project_id=project_id,
            task_id=task_id,
            agent_id=agent_id,
            backend="fake",
            command="fake-agent",
            status="running",
            log_path=str(Path(repo_path) / ".chorus" / "fake.log"),
            started_at="2026-06-15T12:00:00Z",
        )
        handle = FakeRunHandle(self.store, str(run["id"]))
        self.handles.append(handle)
        self.starts.append(
            {
                "project_id": project_id,
                "prompt": prompt,
                "repo_path": str(repo_path),
                "task_id": task_id,
                "agent_id": agent_id,
                "run_id": run["id"],
            }
        )
        return handle


class OrchestratorLoopTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(dir=ROOT)
        self.root = Path(self.tempdir.name)
        self.repo_path = self.root / "repo"
        docs_path = self.repo_path / "docs"
        docs_path.mkdir(parents=True)
        (docs_path / "SPEC.md").write_text("# Spec\nBuild Chorus.\n", encoding="utf-8")
        (docs_path / "ARCHITECTURE.md").write_text(
            "# Architecture\nHub and spoke.\n",
            encoding="utf-8",
        )

        self.store = open_store(self.root / "chorus.db")
        self.project = self.store.projects.create(
            name="Chorus",
            repo_url="https://github.com/faridani/chorus",
            local_path=str(self.repo_path),
            spec_path="docs/SPEC.md",
            architecture_path="docs/ARCHITECTURE.md",
            status="active",
            default_branch="main",
            integration_branch="chorus/integration",
        )
        self.dev_role = self.store.roles.create(
            project_id=self.project["id"],
            name="software dev",
            description="Implements tickets",
            allowed_actions_json=["edit_files", "run_tests", "commit"],
            forbidden_actions_json=["git_push", "merge_main"],
        )
        self.qa_role = self.store.roles.create(
            project_id=self.project["id"],
            name="qa",
            description="Verifies behavior",
        )
        self.agent = self.store.agents.create(
            project_id=self.project["id"],
            role_id=self.dev_role["id"],
            name="dev-1",
            backend="fake",
            status="idle",
        )
        self.store.guardrails.create(
            project_id=self.project["id"],
            scope="project",
            name="No main writes",
            rules_json=["Never touch main."],
        )
        self.store.guardrails.create(
            project_id=self.project["id"],
            role_id=self.dev_role["id"],
            scope="role",
            name="Commit work",
            rules_json=["Commit all changes before finishing."],
        )
        self.backend = FakeBackend(self.store)

    def tearDown(self) -> None:
        self.store.close()
        self.tempdir.cleanup()

    def test_run_once_dispatches_highest_priority_ready_ticket_with_available_role(self) -> None:
        unavailable_high = create_ticket(
            self.store,
            project_id=self.project["id"],
            title="QA the release",
            body="No QA agent is idle yet.",
            assigned_role_id=self.qa_role["id"],
            status="ready",
            priority=100,
        )
        selected = create_ticket(
            self.store,
            project_id=self.project["id"],
            title="Implement orchestrator task loop",
            body="Turn ready tickets into agent tasks.",
            assigned_role_id=self.dev_role["id"],
            status="ready",
            priority=50,
            labels=["backend"],
        )
        lower = create_ticket(
            self.store,
            project_id=self.project["id"],
            title="Polish dashboard copy",
            assigned_role_id=self.dev_role["id"],
            status="ready",
            priority=1,
        )

        result = Orchestrator(self.store, backends={"fake": self.backend}).run_once(
            self.project["id"]
        )

        self.assertEqual(1, len(result["started"]))
        started = result["started"][0]
        self.assertEqual(selected["id"], started["ticket_id"])
        self.assertEqual("in_progress", self.store.tickets.require(selected["id"])["status"])
        self.assertEqual("ready", self.store.tickets.require(unavailable_high["id"])["status"])
        self.assertEqual("ready", self.store.tickets.require(lower["id"])["status"])

        task = self.store.tasks.require(started["task_id"])
        run = self.store.runs.require(started["run_id"])
        agent = self.store.agents.require(self.agent["id"])
        branch_states = self.store.branch_states.list(
            filters={"project_id": self.project["id"], "branch_name": started["branch_name"]},
            order_by=None,
        )

        self.assertEqual("running", task["status"])
        self.assertEqual(selected["id"], task["ticket_id"])
        self.assertEqual(self.agent["id"], run["agent_id"])
        self.assertEqual("running", run["status"])
        self.assertEqual("running", agent["status"])
        self.assertEqual(started["branch_name"], agent["branch_name"])
        self.assertEqual([started["branch_name"]], [branch["branch_name"] for branch in branch_states])
        self.assertEqual("allocated", branch_states[0]["status"])

        context = task["context_json"]
        self.assertEqual("software dev", context["role"]["name"])
        self.assertEqual(selected["id"], context["ticket"]["id"])
        self.assertEqual(["backend"], context["ticket"]["labels"])
        self.assertEqual(2, len(context["guardrails"]))
        self.assertIn("# Spec", context["project_context"]["spec"]["content"])
        self.assertIn("Hub and spoke.", self.backend.starts[0]["prompt"])
        self.assertIn("Implement orchestrator task loop", self.backend.starts[0]["prompt"])
        self.assertEqual(str(self.repo_path), self.backend.starts[0]["repo_path"])

    def test_task_context_includes_tool_permission_states_from_catalog(self) -> None:
        self.store.projects.update(
            self.project["id"],
            metadata_json={
                "available_actions": [
                    "edit_files",
                    {"name": "git_push"},
                    {"id": "open_pr"},
                ]
            },
        )
        selected = create_ticket(
            self.store,
            project_id=self.project["id"],
            title="Use structured tool permissions",
            assigned_role_id=self.dev_role["id"],
            status="ready",
            priority=1,
        )

        result = Orchestrator(self.store, backends={"fake": self.backend}).run_once(
            self.project["id"]
        )

        self.assertEqual(1, len(result["started"]))
        task = self.store.tasks.require(result["started_task_ids"][0])
        self.assertEqual(selected["id"], task["ticket_id"])

        permissions = task["context_json"]["role"]["tool_permissions"]
        states = {permission["name"]: permission["state"] for permission in permissions}
        self.assertEqual("allowed", states["edit_files"])
        self.assertEqual("disallowed", states["git_push"])
        self.assertEqual("unspecified", states["open_pr"])
        self.assertEqual(
            ["edit_files", "git_push", "open_pr", "run_tests", "commit", "merge_main"],
            [permission["name"] for permission in permissions],
        )
        self.assertIn("Tool permissions: ", self.backend.starts[0]["prompt"])
        self.assertIn(
            '"name": "open_pr", "state": "unspecified"',
            self.backend.starts[0]["prompt"],
        )

    def test_run_once_marks_catalog_tools_unspecified_without_role_action_lists(self) -> None:
        self.store.projects.update(
            self.project["id"],
            metadata_json={"available_actions": [{"action": "open_pr"}]},
        )
        self.store.agents.create(
            project_id=self.project["id"],
            role_id=self.qa_role["id"],
            name="qa-1",
            backend="fake",
            status="idle",
        )
        ticket = create_ticket(
            self.store,
            project_id=self.project["id"],
            title="Verify legacy role actions",
            assigned_role_id=self.qa_role["id"],
            status="ready",
            priority=1,
        )

        result = Orchestrator(self.store, backends={"fake": self.backend}).run_once(
            self.project["id"]
        )

        self.assertEqual(1, len(result["started"]))
        task = self.store.tasks.require(result["started_task_ids"][0])
        self.assertEqual(ticket["id"], task["ticket_id"])
        self.assertEqual(
            [{"name": "open_pr", "state": "unspecified"}],
            task["context_json"]["role"]["tool_permissions"],
        )
        self.assertIn(
            'Tool permissions: [{"name": "open_pr", "state": "unspecified"}]',
            self.backend.starts[0]["prompt"],
        )

    def test_run_once_reconciles_finished_agent_run(self) -> None:
        ticket = create_ticket(
            self.store,
            project_id=self.project["id"],
            title="Finish a task",
            assigned_role_id=self.dev_role["id"],
            status="ready",
            priority=1,
        )
        orchestrator = Orchestrator(self.store, backends={"fake": self.backend})
        first_result = orchestrator.run_once(self.project["id"])
        run_id = first_result["started_run_ids"][0]
        task_id = first_result["started_task_ids"][0]

        self.backend.handles[0].finish(RUN_STATUS_SUCCEEDED)
        second_result = orchestrator.run_once(self.project["id"])

        task = self.store.tasks.require(task_id)
        agent = self.store.agents.require(self.agent["id"])
        self.assertEqual([run_id], second_result["reconciled_run_ids"])
        self.assertEqual("review", self.store.tickets.require(ticket["id"])["status"])
        self.assertEqual("review", task["status"])
        self.assertEqual(RUN_STATUS_SUCCEEDED, task["result_json"]["run_status"])
        self.assertEqual("idle", agent["status"])
        self.assertIsNone(agent["branch_name"])

    def test_run_once_does_not_duplicate_persisted_active_work_after_restart(self) -> None:
        ticket = create_ticket(
            self.store,
            project_id=self.project["id"],
            title="Already running",
            assigned_role_id=self.dev_role["id"],
            status="ready",
            priority=99,
        )
        task = self.store.tasks.create(
            project_id=self.project["id"],
            ticket_id=ticket["id"],
            role_id=self.dev_role["id"],
            assigned_agent_id=self.agent["id"],
            title="Already running",
            status="running",
            branch_name="chorus/agent/software-dev/already-running",
        )
        self.store.runs.create(
            project_id=self.project["id"],
            task_id=task["id"],
            agent_id=self.agent["id"],
            backend="fake",
            command="fake-agent",
            status="running",
        )

        restarted_backend = FakeBackend(self.store)
        result = Orchestrator(self.store, backends={"fake": restarted_backend}).run_once(
            self.project["id"]
        )

        self.assertEqual([], result["started_run_ids"])
        self.assertEqual([], restarted_backend.starts)
        self.assertEqual(1, len(self.store.tasks.list(filters={"ticket_id": ticket["id"]})))
        self.assertEqual(1, len(self.store.runs.list(filters={"task_id": task["id"]})))

    def test_reconciles_terminal_run_persisted_before_restart(self) -> None:
        ticket = create_ticket(
            self.store,
            project_id=self.project["id"],
            title="Terminal before restart",
            assigned_role_id=self.dev_role["id"],
            status="ready",
            priority=1,
        )
        transition_ticket(self.store, ticket["id"], "in_progress")
        task = self.store.tasks.create(
            project_id=self.project["id"],
            ticket_id=ticket["id"],
            role_id=self.dev_role["id"],
            assigned_agent_id=self.agent["id"],
            title="Terminal before restart",
            status="running",
            branch_name="chorus/agent/software-dev/terminal-before-restart",
        )
        run = self.store.runs.create(
            project_id=self.project["id"],
            task_id=task["id"],
            agent_id=self.agent["id"],
            backend="fake",
            command="fake-agent",
            status=RUN_STATUS_SUCCEEDED,
            finished_at="2026-06-15T12:00:00Z",
        )

        result = Orchestrator(self.store, backends={"fake": FakeBackend(self.store)}).run_once(
            self.project["id"]
        )

        self.assertEqual([run["id"]], result["reconciled_run_ids"])
        self.assertEqual("review", self.store.tickets.require(ticket["id"])["status"])
        self.assertEqual("review", self.store.tasks.require(task["id"])["status"])
        self.assertEqual("idle", self.store.agents.require(self.agent["id"])["status"])


if __name__ == "__main__":
    unittest.main()
