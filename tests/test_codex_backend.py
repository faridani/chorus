from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from chorus.backends import (  # noqa: E402
    RUN_STATUS_CANCELLED,
    RUN_STATUS_FAILED,
    RUN_STATUS_QUOTA_EXHAUSTED,
    RUN_STATUS_SUCCEEDED,
    CodexCliBackend,
)
from chorus.persistence import open_store  # noqa: E402


class CodexCliBackendTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(dir=ROOT)
        self.root = Path(self.tempdir.name)
        self.repo_path = self.root / "repo"
        self.repo_path.mkdir()
        self.store = open_store(self.root / "chorus.db")
        self.project = self.store.projects.create(
            name="Chorus",
            repo_url="https://github.com/faridani/chorus",
            local_path=str(self.repo_path),
        )
        self.role = self.store.roles.create(project_id=self.project["id"], name="software dev")
        self.agent = self.store.agents.create(
            project_id=self.project["id"],
            role_id=self.role["id"],
            name="dev-1",
        )
        self.task = self.store.tasks.create(
            project_id=self.project["id"],
            role_id=self.role["id"],
            assigned_agent_id=self.agent["id"],
            title="Run Codex",
        )

    def tearDown(self) -> None:
        self.store.close()
        self.tempdir.cleanup()

    def test_execute_task_captures_stdout_stderr_and_persists_run_record(self) -> None:
        fake_codex = self._fake_codex(
            """
import os
import sys

prompt = sys.stdin.read()
print("cwd=" + os.getcwd())
print("prompt=" + prompt)
print("stderr from codex", file=sys.stderr)
"""
        )
        backend = CodexCliBackend(
            self.store,
            executable=fake_codex,
            log_dir=self.root / "logs",
        )

        result = backend.execute_task(
            project_id=self.project["id"],
            task_id=self.task["id"],
            agent_id=self.agent["id"],
            repo_path=self.repo_path,
            prompt="Implement the ticket.",
        )

        self.assertEqual(RUN_STATUS_SUCCEEDED, result.status)
        self.assertEqual(0, result.exit_code)
        self.assertIn(f"cwd={self.repo_path}", result.stdout)
        self.assertIn("prompt=Implement the ticket.", result.stdout)
        self.assertEqual("stderr from codex\n", result.stderr)

        run = self.store.runs.require(result.run_id)
        self.assertEqual(RUN_STATUS_SUCCEEDED, run["status"])
        self.assertEqual(self.task["id"], run["task_id"])
        self.assertEqual(self.agent["id"], run["agent_id"])
        self.assertIn("exec --color never", run["command"])
        self.assertIn("Implement the ticket.", run["state_json"]["stdout"])
        self.assertEqual("stderr from codex\n", run["state_json"]["stderr"])

        log_payload = json.loads(Path(run["log_path"]).read_text(encoding="utf-8"))
        self.assertEqual(result.run_id, log_payload["run_id"])
        self.assertEqual(result.stdout, log_payload["stdout"])
        self.assertEqual(result.stderr, log_payload["stderr"])

    def test_execute_task_marks_non_zero_exit_as_failed(self) -> None:
        fake_codex = self._fake_codex(
            """
import sys

sys.stdin.read()
print("command failed", file=sys.stderr)
sys.exit(7)
"""
        )
        backend = CodexCliBackend(self.store, executable=fake_codex)

        result = backend.execute_task(
            project_id=self.project["id"],
            repo_path=self.repo_path,
            prompt="Do failing work.",
        )

        run = self.store.runs.require(result.run_id)
        self.assertEqual(RUN_STATUS_FAILED, result.status)
        self.assertEqual(7, result.exit_code)
        self.assertEqual(RUN_STATUS_FAILED, run["status"])
        self.assertEqual("command failed\n", run["state_json"]["stderr"])

    def test_execute_task_detects_quota_exhaustion_output(self) -> None:
        fake_codex = self._fake_codex(
            """
import sys

sys.stdin.read()
print("Usage limit reached. Please try again later.", file=sys.stderr)
sys.exit(1)
"""
        )
        backend = CodexCliBackend(self.store, executable=fake_codex)

        result = backend.execute_task(
            project_id=self.project["id"],
            repo_path=self.repo_path,
            prompt="Do quota-limited work.",
        )

        run = self.store.runs.require(result.run_id)
        self.assertEqual(RUN_STATUS_QUOTA_EXHAUSTED, result.status)
        self.assertTrue(result.quota_exhausted)
        self.assertEqual(RUN_STATUS_QUOTA_EXHAUSTED, run["status"])
        self.assertTrue(run["state_json"]["quota_exhausted"])

    def test_started_task_can_be_cancelled(self) -> None:
        fake_codex = self._fake_codex(
            """
import signal
import sys
import time

def stop(signum, frame):
    sys.exit(143)

signal.signal(signal.SIGTERM, stop)
sys.stdin.read()
print("started", flush=True)
time.sleep(30)
"""
        )
        backend = CodexCliBackend(
            self.store,
            executable=fake_codex,
            terminate_timeout_seconds=0.2,
        )

        handle = backend.start_task(
            project_id=self.project["id"],
            repo_path=self.repo_path,
            prompt="Start and wait.",
        )
        time.sleep(0.2)

        self.assertTrue(handle.cancel())
        result = handle.wait(timeout=5)

        run = self.store.runs.require(result.run_id)
        self.assertEqual(RUN_STATUS_CANCELLED, result.status)
        self.assertEqual(RUN_STATUS_CANCELLED, run["status"])
        self.assertTrue(run["state_json"]["cancel_requested"])

    def _fake_codex(self, body: str) -> str:
        path = self.root / f"fake_codex_{len(list(self.root.glob('fake_codex_*.py')))}.py"
        path.write_text(
            "#!/usr/bin/env python3\n" + body.lstrip(),
            encoding="utf-8",
        )
        path.chmod(0o755)
        return str(path)


if __name__ == "__main__":
    unittest.main()
