from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from chorus.persistence import NotFoundError, open_store  # noqa: E402


class PersistenceStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(dir=ROOT)
        self.database_path = Path(self.tempdir.name) / "chorus.db"
        self.store = open_store(self.database_path)

    def tearDown(self) -> None:
        self.store.close()
        self.tempdir.cleanup()

    def test_migrations_create_core_tables(self) -> None:
        table_rows = self.store.connection.execute(
            """
            SELECT name FROM sqlite_master
            WHERE type = 'table'
            ORDER BY name
            """
        ).fetchall()
        tables = {row["name"] for row in table_rows}

        self.assertTrue(
            {
                "projects",
                "agents",
                "roles",
                "guardrails",
                "tickets",
                "tasks",
                "runs",
                "quota_samples",
                "branch_states",
                "merges",
                "notifications",
                "changelog_entries",
                "schema_migrations",
            }.issubset(tables)
        )
        migration_rows = self.store.connection.execute(
            "SELECT id FROM schema_migrations ORDER BY id"
        ).fetchall()
        self.assertEqual(
            ["001_core", "002_ticket_body"],
            [row["id"] for row in migration_rows],
        )

    def test_project_role_and_guardrail_create_read_update(self) -> None:
        project = self.store.projects.create(
            name="Chorus",
            repo_url="https://github.com/faridani/chorus",
            status="active",
            metadata_json={"spec": "SPEC.md"},
        )
        self.assertEqual("chorus/integration", project["integration_branch"])
        self.assertEqual({"spec": "SPEC.md"}, project["metadata_json"])

        updated_project = self.store.projects.update(
            project["id"],
            local_path="/worktrees/chorus",
            metadata_json={"spec": "SPEC.md", "architecture": "docs/ARCHITECTURE.md"},
        )
        self.assertEqual("/worktrees/chorus", updated_project["local_path"])
        self.assertEqual("docs/ARCHITECTURE.md", updated_project["metadata_json"]["architecture"])

        role = self.store.roles.create(
            project_id=project["id"],
            name="software dev",
            description="Implements tickets",
            allowed_actions_json=["edit_files", "run_tests", "commit"],
            forbidden_actions_json=["git_push", "merge_main"],
        )
        self.assertEqual(["git_push", "merge_main"], role["forbidden_actions_json"])

        guardrail = self.store.guardrails.create(
            project_id=project["id"],
            role_id=role["id"],
            scope="role",
            name="No direct main writes",
            rules_json=[{"action": "git push", "effect": "deny"}],
        )
        disabled = self.store.guardrails.update(guardrail["id"], is_enabled=0)
        self.assertEqual(0, disabled["is_enabled"])
        self.assertEqual("git push", disabled["rules_json"][0]["action"])

    def test_ticket_task_agent_run_and_branch_state_resume_flow(self) -> None:
        project = self.store.projects.create(name="Chorus", repo_url="https://github.com/faridani/chorus")
        role = self.store.roles.create(project_id=project["id"], name="qa")
        agent = self.store.agents.create(
            project_id=project["id"],
            role_id=role["id"],
            name="qa-1",
            status="idle",
            state_json={"last_seen_ticket": None},
        )
        ticket = self.store.tickets.create(
            project_id=project["id"],
            assigned_role_id=role["id"],
            title="Verify persistence",
            status="ready",
            labels_json=["persistence"],
        )
        task = self.store.tasks.create(
            project_id=project["id"],
            ticket_id=ticket["id"],
            role_id=role["id"],
            assigned_agent_id=agent["id"],
            title="Exercise persistence flows",
            branch_name="chorus/ticket/persistence",
            context_json={"restart_safe": True},
        )
        running_task = self.store.tasks.update(
            task["id"],
            status="running",
            attempt_count=1,
            state_json={"phase": "tests"},
        )
        self.assertEqual("tests", running_task["state_json"]["phase"])

        run = self.store.runs.create(
            project_id=project["id"],
            task_id=task["id"],
            agent_id=agent["id"],
            status="running",
            command="codex exec",
            state_json={"session": "abc"},
        )
        self.store.runs.update(run["id"], status="quota_exhausted", resume_after_at="2026-06-15T12:00:00Z")
        self.store.branch_states.create(
            project_id=project["id"],
            branch_name="chorus/ticket/persistence",
            kind="agent",
            status="clean",
            head_sha="abc123",
        )

        self.store.close()
        self.store = open_store(self.database_path)

        resumed_run = self.store.runs.require(run["id"])
        resumed_tasks = self.store.tasks.list(filters={"project_id": project["id"], "status": "running"})
        branch = self.store.branch_states.list(filters={"project_id": project["id"], "branch_name": "chorus/ticket/persistence"})[0]

        self.assertEqual("quota_exhausted", resumed_run["status"])
        self.assertEqual("2026-06-15T12:00:00Z", resumed_run["resume_after_at"])
        self.assertEqual(task["id"], resumed_tasks[0]["id"])
        self.assertEqual("abc123", branch["head_sha"])

    def test_merge_changelog_notification_and_quota_flows(self) -> None:
        project = self.store.projects.create(name="Chorus", repo_url="https://github.com/faridani/chorus")
        role = self.store.roles.create(project_id=project["id"], name="developer")
        agent = self.store.agents.create(project_id=project["id"], role_id=role["id"], name="dev-1")
        task = self.store.tasks.create(project_id=project["id"], role_id=role["id"], title="Implement schema")
        run = self.store.runs.create(project_id=project["id"], task_id=task["id"], agent_id=agent["id"], status="succeeded")

        sample = self.store.quota_samples.create(
            project_id=project["id"],
            agent_id=agent["id"],
            quota_limit=1000,
            quota_used=125,
            quota_remaining=875,
            raw_json={"source": "codex"},
        )
        self.assertEqual(875, sample["quota_remaining"])
        self.assertEqual({"source": "codex"}, sample["raw_json"])

        merge = self.store.merges.create(
            project_id=project["id"],
            task_id=task["id"],
            run_id=run["id"],
            merged_by_agent_id=agent["id"],
            source_branch="chorus/ticket/schema",
            target_branch="chorus/integration",
            status="pending",
        )
        merged = self.store.merges.update(
            merge["id"],
            status="merged",
            target_sha_after="def456",
            summary="Defined core persistence schema.",
        )
        self.assertEqual("merged", merged["status"])

        changelog = self.store.changelog_entries.create(
            project_id=project["id"],
            merge_id=merge["id"],
            task_id=task["id"],
            agent_id=agent["id"],
            title="Core persistence schema",
            body="Added SQLite-backed state for the orchestrator.",
            metadata_json={"tables": 12},
        )
        notification = self.store.notifications.create(
            project_id=project["id"],
            merge_id=merge["id"],
            changelog_entry_id=changelog["id"],
            channel="email",
            recipient="human@example.com",
            subject="Chorus merge completed",
            payload_json={"template": "merge"},
        )
        sent = self.store.notifications.update(notification["id"], status="sent", sent_at="2026-06-15T13:00:00Z")

        self.assertEqual(12, changelog["metadata_json"]["tables"])
        self.assertEqual("sent", sent["status"])
        self.assertEqual("merge", sent["payload_json"]["template"])

    def test_update_missing_record_raises(self) -> None:
        with self.assertRaises(NotFoundError):
            self.store.projects.update("missing", status="active")


if __name__ == "__main__":
    unittest.main()
