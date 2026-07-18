from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from chorus.persistence import open_store  # noqa: E402
from chorus.resume import build_project_resume_state  # noqa: E402
from chorus.tickets import (  # noqa: E402
    TicketTransitionError,
    TicketValidationError,
    assign_ticket,
    close_ticket,
    create_ticket,
    edit_ticket,
    get_ticket,
    get_ticket_agent_runs,
    list_project_tickets,
    reprioritize_ticket,
    transition_ticket,
)


class TicketLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(dir=ROOT)
        self.database_path = Path(self.tempdir.name) / "chorus.db"
        self.store = open_store(self.database_path)
        self.project = self.store.projects.create(
            name="Chorus",
            repo_url="https://github.com/faridani/chorus",
        )
        self.role = self.store.roles.create(project_id=self.project["id"], name="software dev")

    def tearDown(self) -> None:
        self.store.close()
        self.tempdir.cleanup()

    def test_create_edit_assign_reprioritize_and_close_ticket(self) -> None:
        ticket = create_ticket(
            self.store,
            project_id=self.project["id"],
            title="  Implement ticket tracking  ",
            body="Build the minimal built-in tracker.",
            priority=2,
            labels=["backend"],
            metadata={"source": "user"},
            created_by="human",
        )

        self.assertEqual("Implement ticket tracking", ticket["title"])
        self.assertEqual("Build the minimal built-in tracker.", ticket["body"])
        self.assertEqual("backlog", ticket["status"])
        self.assertEqual(2, ticket["priority"])
        self.assertEqual([], ticket["agent_run_ids"])

        edited = edit_ticket(
            self.store,
            ticket["id"],
            title="Implement built-in ticket tracking",
            body="Drive agent work without an external tracker.",
            labels=["backend", "tickets"],
        )
        assigned = assign_ticket(self.store, ticket["id"], self.role["id"])
        reprioritized = reprioritize_ticket(self.store, ticket["id"], 5)
        closed = close_ticket(self.store, ticket["id"])

        self.assertEqual("Implement built-in ticket tracking", edited["title"])
        self.assertEqual("Drive agent work without an external tracker.", edited["body"])
        self.assertEqual(self.role["id"], assigned["assigned_role_id"])
        self.assertEqual(5, reprioritized["priority"])
        self.assertEqual("done", closed["status"])
        self.assertIsNotNone(closed["completed_at"])

        self.store.close()
        self.store = open_store(self.database_path)
        persisted = get_ticket(self.store, ticket["id"])
        self.assertEqual("done", persisted["status"])
        self.assertEqual("Drive agent work without an external tracker.", persisted["body"])
        self.assertEqual(self.role["id"], persisted["assigned_role_id"])

    def test_ticket_lifecycle_transitions_cover_workflow_statuses(self) -> None:
        ticket = create_ticket(
            self.store,
            project_id=self.project["id"],
            title="Exercise lifecycle",
        )

        ready = transition_ticket(self.store, ticket["id"], "ready")
        in_progress = transition_ticket(self.store, ticket["id"], "in progress")
        blocked = transition_ticket(self.store, ticket["id"], "blocked")
        resumed = transition_ticket(self.store, ticket["id"], "in_progress")
        review = transition_ticket(self.store, ticket["id"], "review")
        merged = transition_ticket(self.store, ticket["id"], "merged")
        done = transition_ticket(self.store, ticket["id"], "done")

        self.assertEqual("ready", ready["status"])
        self.assertEqual("in_progress", in_progress["status"])
        self.assertEqual("blocked", blocked["status"])
        self.assertEqual("in_progress", resumed["status"])
        self.assertEqual("review", review["status"])
        self.assertEqual("merged", merged["status"])
        self.assertEqual("done", done["status"])

    def test_invalid_ticket_updates_are_rejected(self) -> None:
        ticket = create_ticket(
            self.store,
            project_id=self.project["id"],
            title="Validate lifecycle",
        )

        with self.assertRaises(TicketTransitionError):
            transition_ticket(self.store, ticket["id"], "review")
        self.assertEqual("backlog", get_ticket(self.store, ticket["id"])["status"])

        with self.assertRaises(TicketValidationError):
            create_ticket(self.store, project_id=self.project["id"], title=" ")
        with self.assertRaises(TicketValidationError):
            reprioritize_ticket(self.store, ticket["id"], True)

        other_project = self.store.projects.create(
            name="Other",
            repo_url="https://github.com/faridani/other",
        )
        other_role = self.store.roles.create(project_id=other_project["id"], name="qa")
        with self.assertRaises(TicketValidationError):
            assign_ticket(self.store, ticket["id"], other_role["id"])

    def test_ticket_agent_run_links_are_included_in_resume_state(self) -> None:
        ticket = create_ticket(
            self.store,
            project_id=self.project["id"],
            title="Link runs",
            assigned_role_id=self.role["id"],
        )
        agent = self.store.agents.create(
            project_id=self.project["id"],
            role_id=self.role["id"],
            name="dev-1",
        )
        task = self.store.tasks.create(
            project_id=self.project["id"],
            ticket_id=ticket["id"],
            role_id=self.role["id"],
            assigned_agent_id=agent["id"],
            title="Implement ticket",
        )
        run = self.store.runs.create(
            project_id=self.project["id"],
            task_id=task["id"],
            agent_id=agent["id"],
            status="running",
        )
        self.store.tasks.create(project_id=self.project["id"], title="Unlinked task")

        linked_runs = get_ticket_agent_runs(self.store, ticket["id"])
        listed_ticket = list_project_tickets(self.store, self.project["id"])[0]
        resume_state = build_project_resume_state(self.store, self.project["id"])

        self.assertEqual([run["id"]], [linked_run["id"] for linked_run in linked_runs])
        self.assertEqual([run["id"]], listed_ticket["agent_run_ids"])
        self.assertEqual([ticket["id"]], [item["id"] for item in resume_state["tickets"]])
        self.assertEqual([run["id"]], resume_state["tickets"][0]["agent_run_ids"])
        self.assertEqual([run["id"]], [item["id"] for item in resume_state["runs"]])


if __name__ == "__main__":
    unittest.main()
