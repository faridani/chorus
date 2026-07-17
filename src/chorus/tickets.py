from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
from typing import Any

from chorus.persistence import ChorusStore


TICKET_STATUS_BACKLOG = "backlog"
TICKET_STATUS_READY = "ready"
TICKET_STATUS_IN_PROGRESS = "in_progress"
TICKET_STATUS_REVIEW = "review"
TICKET_STATUS_MERGED = "merged"
TICKET_STATUS_BLOCKED = "blocked"
TICKET_STATUS_DONE = "done"

TICKET_STATUSES = (
    TICKET_STATUS_BACKLOG,
    TICKET_STATUS_READY,
    TICKET_STATUS_IN_PROGRESS,
    TICKET_STATUS_REVIEW,
    TICKET_STATUS_MERGED,
    TICKET_STATUS_BLOCKED,
    TICKET_STATUS_DONE,
)

TICKET_STATUS_TRANSITIONS: dict[str, frozenset[str]] = {
    TICKET_STATUS_BACKLOG: frozenset(
        {TICKET_STATUS_READY, TICKET_STATUS_BLOCKED, TICKET_STATUS_DONE}
    ),
    TICKET_STATUS_READY: frozenset(
        {
            TICKET_STATUS_BACKLOG,
            TICKET_STATUS_IN_PROGRESS,
            TICKET_STATUS_BLOCKED,
            TICKET_STATUS_DONE,
        }
    ),
    TICKET_STATUS_IN_PROGRESS: frozenset(
        {
            TICKET_STATUS_READY,
            TICKET_STATUS_REVIEW,
            TICKET_STATUS_BLOCKED,
            TICKET_STATUS_DONE,
        }
    ),
    TICKET_STATUS_REVIEW: frozenset(
        {
            TICKET_STATUS_IN_PROGRESS,
            TICKET_STATUS_MERGED,
            TICKET_STATUS_BLOCKED,
            TICKET_STATUS_DONE,
        }
    ),
    TICKET_STATUS_MERGED: frozenset({TICKET_STATUS_DONE, TICKET_STATUS_BLOCKED}),
    TICKET_STATUS_BLOCKED: frozenset(
        {
            TICKET_STATUS_BACKLOG,
            TICKET_STATUS_READY,
            TICKET_STATUS_IN_PROGRESS,
            TICKET_STATUS_REVIEW,
            TICKET_STATUS_DONE,
        }
    ),
    TICKET_STATUS_DONE: frozenset(),
}


class TicketValidationError(ValueError):
    """Raised when a ticket API request contains invalid data."""


class TicketTransitionError(TicketValidationError):
    """Raised when a ticket status change is not allowed."""


def create_ticket(
    store: ChorusStore,
    *,
    project_id: str,
    title: str,
    body: str = "",
    assigned_role_id: str | None = None,
    status: str = TICKET_STATUS_BACKLOG,
    priority: int = 0,
    labels: Iterable[str] | None = None,
    metadata: Mapping[str, Any] | None = None,
    created_by: str | None = None,
) -> dict[str, Any]:
    """Create a built-in ticket for a project."""

    store.projects.require(project_id)
    status = _validate_status(status)
    assigned_role_id = _validate_assigned_role(store, project_id, assigned_role_id)
    record = store.tickets.create(
        project_id=project_id,
        assigned_role_id=assigned_role_id,
        source="built_in",
        title=_validate_title(title),
        body=body,
        description=body,
        status=status,
        priority=_validate_priority(priority),
        labels_json=list(labels or ()),
        metadata_json=dict(metadata or {}),
        created_by=created_by,
        completed_at=_utc_now() if status == TICKET_STATUS_DONE else None,
    )
    return _ticket_response(store, record)


def get_ticket(store: ChorusStore, ticket_id: str) -> dict[str, Any]:
    """Return a ticket with normalized body and linked agent-run references."""

    return _ticket_response(store, store.tickets.require(ticket_id))


def list_project_tickets(
    store: ChorusStore,
    project_id: str,
    *,
    status: str | None = None,
    assigned_role_id: str | None = None,
    order_by: str | None = "created_at",
) -> list[dict[str, Any]]:
    """List built-in tickets for a project."""

    store.projects.require(project_id)
    filters: dict[str, Any] = {"project_id": project_id}
    if status is not None:
        filters["status"] = _validate_status(status)
    if assigned_role_id is not None:
        filters["assigned_role_id"] = _validate_assigned_role(
            store,
            project_id,
            assigned_role_id,
        )

    return [
        _ticket_response(store, ticket)
        for ticket in store.tickets.list(filters=filters, order_by=order_by)
    ]


def edit_ticket(
    store: ChorusStore,
    ticket_id: str,
    *,
    title: str | None = None,
    body: str | None = None,
    labels: Iterable[str] | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Edit ticket text and metadata fields."""

    changes: dict[str, Any] = {}
    if title is not None:
        changes["title"] = _validate_title(title)
    if body is not None:
        changes["body"] = body
        changes["description"] = body
    if labels is not None:
        changes["labels_json"] = list(labels)
    if metadata is not None:
        changes["metadata_json"] = dict(metadata)

    return _ticket_response(store, store.tickets.update(ticket_id, **changes))


def assign_ticket(
    store: ChorusStore,
    ticket_id: str,
    assigned_role_id: str | None,
) -> dict[str, Any]:
    """Assign or unassign a ticket to a project role."""

    ticket = store.tickets.require(ticket_id)
    role_id = _validate_assigned_role(store, str(ticket["project_id"]), assigned_role_id)
    return _ticket_response(
        store,
        store.tickets.update(ticket_id, assigned_role_id=role_id),
    )


def reprioritize_ticket(store: ChorusStore, ticket_id: str, priority: int) -> dict[str, Any]:
    """Update a ticket priority."""

    return _ticket_response(
        store,
        store.tickets.update(ticket_id, priority=_validate_priority(priority)),
    )


def transition_ticket(store: ChorusStore, ticket_id: str, status: str) -> dict[str, Any]:
    """Move a ticket through the built-in lifecycle."""

    ticket = store.tickets.require(ticket_id)
    current_status = _validate_status(str(ticket["status"]))
    next_status = _validate_status(status)
    if current_status == next_status:
        return _ticket_response(store, ticket)

    allowed_statuses = TICKET_STATUS_TRANSITIONS[current_status]
    if next_status not in allowed_statuses:
        raise TicketTransitionError(
            f"Cannot transition ticket {ticket_id} from {current_status} to {next_status}."
        )

    changes: dict[str, Any] = {"status": next_status}
    if next_status == TICKET_STATUS_DONE:
        changes["completed_at"] = _utc_now()

    return _ticket_response(store, store.tickets.update(ticket_id, **changes))


def close_ticket(store: ChorusStore, ticket_id: str) -> dict[str, Any]:
    """Close a ticket as done."""

    return transition_ticket(store, ticket_id, TICKET_STATUS_DONE)


def get_ticket_agent_runs(store: ChorusStore, ticket_id: str) -> list[dict[str, Any]]:
    """Return agent runs connected to a ticket through its tasks."""

    store.tickets.require(ticket_id)
    runs: list[dict[str, Any]] = []
    for task in store.tasks.list(filters={"ticket_id": ticket_id}, order_by="created_at"):
        runs.extend(store.runs.list(filters={"task_id": task["id"]}, order_by="created_at"))
    return runs


def _ticket_response(store: ChorusStore, record: dict[str, Any]) -> dict[str, Any]:
    ticket = dict(record)
    ticket["body"] = _body_for_ticket(ticket)
    ticket.pop("description", None)

    agent_runs = [_agent_run_link(run) for run in get_ticket_agent_runs(store, str(ticket["id"]))]
    ticket["agent_run_ids"] = [run["id"] for run in agent_runs]
    ticket["agent_runs"] = agent_runs
    return ticket


def _agent_run_link(run: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": run["id"],
        "task_id": run["task_id"],
        "agent_id": run["agent_id"],
        "status": run["status"],
        "created_at": run["created_at"],
        "started_at": run["started_at"],
        "finished_at": run["finished_at"],
    }


def _body_for_ticket(ticket: dict[str, Any]) -> str:
    body = ticket.get("body")
    if isinstance(body, str) and body:
        return body

    description = ticket.get("description")
    return description if isinstance(description, str) else ""


def _validate_title(title: str) -> str:
    value = title.strip()
    if not value:
        raise TicketValidationError("Ticket title cannot be empty.")
    return value


def _validate_priority(priority: int) -> int:
    if isinstance(priority, bool) or not isinstance(priority, int):
        raise TicketValidationError("Ticket priority must be an integer.")
    return priority


def _validate_status(status: str) -> str:
    if not isinstance(status, str):
        raise TicketValidationError("Ticket status must be a string.")

    normalized_status = status.strip().lower().replace(" ", "_").replace("-", "_")
    if normalized_status not in TICKET_STATUSES:
        allowed = ", ".join(TICKET_STATUSES)
        raise TicketValidationError(
            f"Unknown ticket status: {status}. Expected one of: {allowed}."
        )
    return normalized_status


def _validate_assigned_role(
    store: ChorusStore,
    project_id: str,
    assigned_role_id: str | None,
) -> str | None:
    if assigned_role_id is None:
        return None

    role = store.roles.require(assigned_role_id)
    if role["project_id"] != project_id:
        raise TicketValidationError("Assigned role must belong to the ticket project.")
    return assigned_role_id


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
