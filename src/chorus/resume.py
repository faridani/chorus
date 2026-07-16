from __future__ import annotations

from typing import Any

from chorus.persistence import ChorusStore
from chorus.tickets import list_project_tickets


def build_project_resume_state(store: ChorusStore, project_id: str) -> dict[str, Any]:
    """Collect persisted project state needed to resume orchestration."""

    project = store.projects.require(project_id)
    return {
        "project": project,
        "roles": store.roles.list(filters={"project_id": project_id}, order_by="created_at"),
        "agents": store.agents.list(filters={"project_id": project_id}, order_by="created_at"),
        "tickets": list_project_tickets(store, project_id, order_by="created_at"),
        "tasks": store.tasks.list(filters={"project_id": project_id}, order_by="created_at"),
        "runs": store.runs.list(filters={"project_id": project_id}, order_by="created_at"),
        "branch_states": store.branch_states.list(
            filters={"project_id": project_id},
            order_by="created_at",
        ),
    }
