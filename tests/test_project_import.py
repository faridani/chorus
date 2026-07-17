from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from typing import Callable, Sequence


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from chorus.persistence import open_store  # noqa: E402
from chorus.projects import (  # noqa: E402
    CloneError,
    CommandResult,
    GitHubAuthError,
    InvalidRepositoryURLError,
    ProjectImporter,
)


CommandHandler = Callable[[tuple[str, ...], Path | None], CommandResult]


class FakeCommandRunner:
    def __init__(self, handler: CommandHandler) -> None:
        self.handler = handler
        self.calls: list[tuple[tuple[str, ...], Path | None]] = []

    def run(self, args: Sequence[str], *, cwd: Path | None = None) -> CommandResult:
        command = tuple(args)
        self.calls.append((command, cwd))
        return self.handler(command, cwd)


class ProjectImportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(dir=ROOT)
        self.root = Path(self.tempdir.name)
        self.store = open_store(self.root / "chorus.db")
        self.projects_dir = self.root / "projects"

    def tearDown(self) -> None:
        self.store.close()
        self.tempdir.cleanup()

    def test_import_project_checks_auth_clones_with_gh_and_persists_metadata(self) -> None:
        repo_url = "https://github.com/faridani/chorus.git"
        expected_path = self.projects_dir / "chorus"

        def handler(command: tuple[str, ...], cwd: Path | None) -> CommandResult:
            if command == ("gh", "auth", "status"):
                return CommandResult(command, 0, stdout="Logged in to github.com\n")
            if command == ("gh", "repo", "clone", repo_url, str(expected_path)):
                expected_path.mkdir(parents=True)
                docs_path = expected_path / "docs"
                docs_path.mkdir()
                (docs_path / "SPEC.md").write_text("# Spec\n", encoding="utf-8")
                (docs_path / "ARCHITECTURE.md").write_text("# Architecture\n", encoding="utf-8")
                return CommandResult(command, 0, stdout="Cloned\n")
            if command == (
                "git",
                "-C",
                str(expected_path),
                "symbolic-ref",
                "--short",
                "refs/remotes/origin/HEAD",
            ):
                return CommandResult(command, 0, stdout="origin/trunk\n")
            return CommandResult(command, 1, stderr=f"unexpected command: {' '.join(command)}")

        runner = FakeCommandRunner(handler)
        project = ProjectImporter(
            self.store,
            projects_dir=self.projects_dir,
            command_runner=runner,
        ).import_from_url(repo_url)

        self.assertEqual("chorus", project["name"])
        self.assertEqual(repo_url, project["repo_url"])
        self.assertEqual(str(expected_path), project["local_path"])
        self.assertEqual("docs/SPEC.md", project["spec_path"])
        self.assertEqual("docs/ARCHITECTURE.md", project["architecture_path"])
        self.assertEqual("trunk", project["default_branch"])
        self.assertEqual("chorus/integration", project["integration_branch"])
        self.assertEqual(
            {
                "imported_via": "gh",
                "context": {
                    "spec_path": "docs/SPEC.md",
                    "architecture_path": "docs/ARCHITECTURE.md",
                    "missing": [],
                },
            },
            project["metadata_json"],
        )
        self.assertEqual("active", project["status"])
        self.assertEqual(
            [
                (("gh", "auth", "status"), None),
                (("gh", "repo", "clone", repo_url, str(expected_path)), None),
                (
                    (
                        "git",
                        "-C",
                        str(expected_path),
                        "symbolic-ref",
                        "--short",
                        "refs/remotes/origin/HEAD",
                    ),
                    None,
                ),
            ],
            runner.calls,
        )

    def test_missing_gh_auth_is_reported_before_clone_or_project_creation(self) -> None:
        def handler(command: tuple[str, ...], cwd: Path | None) -> CommandResult:
            if command == ("gh", "auth", "status"):
                return CommandResult(command, 1, stderr="not logged in to any hosts")
            return CommandResult(command, 0)

        runner = FakeCommandRunner(handler)
        importer = ProjectImporter(
            self.store,
            projects_dir=self.projects_dir,
            command_runner=runner,
        )

        with self.assertRaisesRegex(GitHubAuthError, "gh auth status failed: not logged in"):
            importer.import_from_url("https://github.com/faridani/chorus")

        self.assertEqual([(("gh", "auth", "status"), None)], runner.calls)
        self.assertEqual([], self.store.projects.list(order_by=None))

    def test_invalid_repository_url_is_reported_without_running_commands(self) -> None:
        runner = FakeCommandRunner(lambda command, cwd: CommandResult(command, 0))
        importer = ProjectImporter(
            self.store,
            projects_dir=self.projects_dir,
            command_runner=runner,
        )

        with self.assertRaisesRegex(InvalidRepositoryURLError, "owner/name"):
            importer.import_from_url("https://github.com/faridani")

        self.assertEqual([], runner.calls)
        self.assertEqual([], self.store.projects.list(order_by=None))

    def test_clone_failure_is_reported_without_project_creation(self) -> None:
        repo_url = "git@github.com:faridani/chorus.git"

        def handler(command: tuple[str, ...], cwd: Path | None) -> CommandResult:
            if command == ("gh", "auth", "status"):
                return CommandResult(command, 0)
            if command[:3] == ("gh", "repo", "clone"):
                return CommandResult(command, 128, stderr="repository not found")
            return CommandResult(command, 0)

        importer = ProjectImporter(
            self.store,
            projects_dir=self.projects_dir,
            command_runner=FakeCommandRunner(handler),
        )

        with self.assertRaisesRegex(CloneError, "gh repo clone failed: repository not found"):
            importer.import_from_url(repo_url)

        self.assertEqual([], self.store.projects.list(order_by=None))

    def test_import_marks_project_needs_context_when_required_files_are_absent(self) -> None:
        repo_url = "https://github.com/faridani/chorus"
        expected_path = self.projects_dir / "chorus"

        def handler(command: tuple[str, ...], cwd: Path | None) -> CommandResult:
            if command == ("gh", "auth", "status"):
                return CommandResult(command, 0)
            if command == ("gh", "repo", "clone", repo_url, str(expected_path)):
                expected_path.mkdir(parents=True)
                return CommandResult(command, 0)
            if command == (
                "git",
                "-C",
                str(expected_path),
                "symbolic-ref",
                "--short",
                "refs/remotes/origin/HEAD",
            ):
                return CommandResult(command, 0, stdout="origin/main\n")
            return CommandResult(command, 1, stderr="unexpected command")

        project = ProjectImporter(
            self.store,
            projects_dir=self.projects_dir,
            command_runner=FakeCommandRunner(handler),
        ).import_from_url(repo_url)

        self.assertEqual("needs_context", project["status"])
        self.assertIsNone(project["spec_path"])
        self.assertIsNone(project["architecture_path"])
        self.assertEqual(["spec", "architecture"], project["metadata_json"]["context"]["missing"])

    def test_default_branch_falls_back_to_checked_out_branch(self) -> None:
        repo_url = "https://github.com/faridani/chorus"
        expected_path = self.projects_dir / "chorus"

        def handler(command: tuple[str, ...], cwd: Path | None) -> CommandResult:
            if command == ("gh", "auth", "status"):
                return CommandResult(command, 0)
            if command[:3] == ("gh", "repo", "clone"):
                expected_path.mkdir(parents=True)
                return CommandResult(command, 0)
            if "symbolic-ref" in command:
                return CommandResult(command, 1, stderr="no origin head")
            if command[-2:] == ("branch", "--show-current"):
                return CommandResult(command, 0, stdout="main\n")
            return CommandResult(command, 1, stderr="unexpected command")

        project = ProjectImporter(
            self.store,
            projects_dir=self.projects_dir,
            command_runner=FakeCommandRunner(handler),
        ).import_from_url(repo_url)

        self.assertEqual("main", project["default_branch"])


if __name__ == "__main__":
    unittest.main()
