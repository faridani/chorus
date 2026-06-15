"""Regression tests for bugs fixed during review of the agent-generated build."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from typing import Sequence

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from chorus.backends import is_quota_exhaustion  # noqa: E402
from chorus.persistence import open_store  # noqa: E402
from chorus.projects import CloneError, CommandResult, ProjectImporter  # noqa: E402


class QuotaDetectionTests(unittest.TestCase):
    def test_stdout_429_is_not_flagged(self) -> None:
        # A bare "429" in the agent's own output must not be misread as quota.
        self.assertFalse(is_quota_exhaustion("def handle_429(): return 429\n", ""))

    def test_generic_phrase_on_stdout_not_flagged(self) -> None:
        self.assertFalse(is_quota_exhaustion("the rate limit middleware was added", ""))

    def test_rate_limit_on_stderr_is_flagged(self) -> None:
        self.assertTrue(is_quota_exhaustion("", "Error: rate limit exceeded, retry later"))

    def test_specific_phrase_anywhere_is_flagged(self) -> None:
        self.assertTrue(is_quota_exhaustion("insufficient quota for this request", ""))


class MigrationIdempotencyTests(unittest.TestCase):
    def test_migrate_is_repeatable_without_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = open_store(Path(tmp) / "chorus.db")
            try:
                # open_store already migrated; running again must be a safe no-op
                # (the pre-fix code could raise "duplicate column name: body").
                store.migrate()
                ids = [
                    row[0]
                    for row in store.connection.execute(
                        "SELECT id FROM schema_migrations ORDER BY id"
                    ).fetchall()
                ]
                self.assertIn("001_core", ids)
                self.assertIn("002_ticket_body", ids)
            finally:
                store.close()


class _Runner:
    def __init__(self, handler) -> None:
        self.handler = handler

    def run(self, args: Sequence[str], *, cwd: Path | None = None) -> CommandResult:
        return self.handler(tuple(args), cwd)


class CloneCleanupTests(unittest.TestCase):
    def test_partial_clone_removed_when_post_clone_step_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            store = open_store(root / "chorus.db")
            projects_dir = root / "projects"
            repo_url = "https://github.com/faridani/chorus.git"
            expected = projects_dir / "chorus"

            def handler(cmd: tuple[str, ...], cwd: Path | None) -> CommandResult:
                if cmd == ("gh", "auth", "status"):
                    return CommandResult(cmd, 0, stdout="Logged in\n")
                if cmd[:3] == ("gh", "repo", "clone"):
                    expected.mkdir(parents=True)
                    return CommandResult(cmd, 0, stdout="Cloned\n")
                # Every git default-branch probe fails → import raises mid-way.
                return CommandResult(cmd, 1, stderr="boom")

            importer = ProjectImporter(
                store, projects_dir=projects_dir, command_runner=_Runner(handler)
            )
            try:
                with self.assertRaises(CloneError):
                    importer.import_from_url(repo_url)
                self.assertFalse(
                    expected.exists(),
                    "partial clone directory should be cleaned up on failure",
                )
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()
