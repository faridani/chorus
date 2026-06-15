from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from chorus.orchestrator import OrchestrationBlockedError, Orchestrator  # noqa: E402
from chorus.persistence import open_store  # noqa: E402
from chorus.projects import (  # noqa: E402
    ProjectContextError,
    refresh_project_context_from_files,
    require_project_context,
    set_project_context_content,
)


class ProjectContextTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(dir=ROOT)
        self.root = Path(self.tempdir.name)
        self.store = open_store(self.root / "chorus.db")
        self.repo_path = self.root / "repo"
        self.repo_path.mkdir()

    def tearDown(self) -> None:
        self.store.close()
        self.tempdir.cleanup()

    def test_refresh_project_context_finds_common_spec_and_architecture_files(self) -> None:
        docs_path = self.repo_path / "docs"
        docs_path.mkdir()
        (docs_path / "SPEC.md").write_text("# Spec\n", encoding="utf-8")
        (docs_path / "ARCHITECTURE.md").write_text("# Architecture\n", encoding="utf-8")
        project = self.store.projects.create(
            name="Chorus",
            repo_url="https://github.com/faridani/chorus",
            local_path=str(self.repo_path),
            status="needs_context",
        )

        updated = refresh_project_context_from_files(self.store, project["id"])

        self.assertEqual("active", updated["status"])
        self.assertEqual("docs/SPEC.md", updated["spec_path"])
        self.assertEqual("docs/ARCHITECTURE.md", updated["architecture_path"])
        self.assertEqual([], updated["metadata_json"]["context"]["missing"])

    def test_set_project_context_content_stores_pasted_or_uploaded_content(self) -> None:
        project = self.store.projects.create(
            name="Chorus",
            repo_url="https://github.com/faridani/chorus",
            local_path=str(self.repo_path),
            status="needs_context",
        )

        updated = set_project_context_content(
            self.store,
            project["id"],
            spec_content="# Spec\n",
            architecture_content="# Architecture\n",
        )

        spec_path = self.repo_path / ".chorus" / "context" / "SPEC.md"
        architecture_path = self.repo_path / ".chorus" / "context" / "ARCHITECTURE.md"
        self.assertEqual("# Spec\n", spec_path.read_text(encoding="utf-8"))
        self.assertEqual("# Architecture\n", architecture_path.read_text(encoding="utf-8"))
        self.assertEqual(".chorus/context/SPEC.md", updated["spec_path"])
        self.assertEqual(".chorus/context/ARCHITECTURE.md", updated["architecture_path"])
        self.assertEqual("active", updated["status"])

    def test_set_project_context_content_keeps_project_blocked_until_both_required_parts_exist(
        self,
    ) -> None:
        project = self.store.projects.create(
            name="Chorus",
            repo_url="https://github.com/faridani/chorus",
            local_path=str(self.repo_path),
        )

        updated = set_project_context_content(
            self.store,
            project["id"],
            spec_content="# Spec\n",
        )

        self.assertEqual("needs_context", updated["status"])
        self.assertEqual(".chorus/context/SPEC.md", updated["spec_path"])
        self.assertIsNone(updated["architecture_path"])
        self.assertEqual(["architecture"], updated["metadata_json"]["context"]["missing"])

    def test_empty_pasted_context_content_is_rejected(self) -> None:
        project = self.store.projects.create(
            name="Chorus",
            repo_url="https://github.com/faridani/chorus",
            local_path=str(self.repo_path),
        )

        with self.assertRaisesRegex(ProjectContextError, "cannot be empty"):
            set_project_context_content(self.store, project["id"], spec_content="  \n")

    def test_orchestrator_refuses_to_start_agents_without_required_context(self) -> None:
        project = self.store.projects.create(
            name="Chorus",
            repo_url="https://github.com/faridani/chorus",
            local_path=str(self.repo_path),
            status="active",
        )

        with self.assertRaisesRegex(OrchestrationBlockedError, "spec, architecture"):
            Orchestrator(self.store).start_agents(project["id"])

        blocked_project = self.store.projects.require(project["id"])
        self.assertEqual("needs_context", blocked_project["status"])

    def test_orchestrator_allows_agent_start_when_required_context_exists(self) -> None:
        docs_path = self.repo_path / "docs"
        docs_path.mkdir()
        (docs_path / "SPEC.md").write_text("# Spec\n", encoding="utf-8")
        (docs_path / "ARCHITECTURE.md").write_text("# Architecture\n", encoding="utf-8")
        project = self.store.projects.create(
            name="Chorus",
            repo_url="https://github.com/faridani/chorus",
            local_path=str(self.repo_path),
            spec_path="docs/SPEC.md",
            architecture_path="docs/ARCHITECTURE.md",
            status="active",
        )

        started_project = Orchestrator(self.store).start_agents(project["id"])

        self.assertEqual(project["id"], started_project["id"])
        self.assertEqual(project["id"], require_project_context(self.store, project["id"])["id"])


if __name__ == "__main__":
    unittest.main()
