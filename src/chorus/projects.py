from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, Sequence
from urllib.parse import urlparse

from chorus.persistence import ChorusStore


DEFAULT_PROJECTS_DIR = ".chorus/projects"
DEFAULT_INTEGRATION_BRANCH = "chorus/integration"
PROJECT_STATUS_ACTIVE = "active"
PROJECT_STATUS_NEEDS_CONTEXT = "needs_context"
DEFAULT_PASTED_CONTEXT_DIR = ".chorus/context"
DEFAULT_PASTED_SPEC_PATH = f"{DEFAULT_PASTED_CONTEXT_DIR}/SPEC.md"
DEFAULT_PASTED_ARCHITECTURE_PATH = f"{DEFAULT_PASTED_CONTEXT_DIR}/ARCHITECTURE.md"
SPEC_CONTEXT_CANDIDATES = (
    "docs/SPEC.md",
    "docs/spec.md",
    "SPEC.md",
    "spec.md",
    "docs/PROJECT_SPEC.md",
    "PROJECT_SPEC.md",
    "docs/REQUIREMENTS.md",
    "REQUIREMENTS.md",
)
ARCHITECTURE_CONTEXT_CANDIDATES = (
    "docs/ARCHITECTURE.md",
    "docs/architecture.md",
    "ARCHITECTURE.md",
    "architecture.md",
    "docs/ARCH.md",
    "ARCH.md",
    "docs/DESIGN.md",
    "DESIGN.md",
)


class ProjectImportError(RuntimeError):
    """Raised when a project cannot be imported."""


class GitHubAuthError(ProjectImportError):
    """Raised when the gh CLI is missing or unauthenticated."""


class InvalidRepositoryURLError(ProjectImportError):
    """Raised when a submitted repository URL is not a valid GitHub repo URL."""


class CloneError(ProjectImportError):
    """Raised when cloning or inspecting the cloned repository fails."""


class ProjectContextError(RuntimeError):
    """Raised when project context cannot be discovered or stored."""


class ProjectContextMissingError(ProjectContextError):
    """Raised when a project lacks required specification or architecture context."""


@dataclass(frozen=True)
class CommandResult:
    args: tuple[str, ...]
    returncode: int
    stdout: str = ""
    stderr: str = ""


class CommandRunner(Protocol):
    def run(self, args: Sequence[str], *, cwd: Path | None = None) -> CommandResult:
        """Run a command and return captured output without raising on non-zero exit."""


class SubprocessCommandRunner:
    # Default wall-clock cap so a hung `gh`/`git` (e.g. network stall, auth
    # prompt) can't block the importer thread forever.
    def __init__(self, *, timeout_seconds: float | None = 600.0) -> None:
        self.timeout_seconds = timeout_seconds

    def run(self, args: Sequence[str], *, cwd: Path | None = None) -> CommandResult:
        try:
            completed = subprocess.run(
                tuple(args),
                cwd=cwd,
                capture_output=True,
                text=True,
                check=False,
                timeout=self.timeout_seconds,
            )
        except FileNotFoundError:
            return CommandResult(
                args=tuple(args),
                returncode=127,
                stderr=f"Required command not found: {args[0]}",
            )
        except subprocess.TimeoutExpired:
            return CommandResult(
                args=tuple(args),
                returncode=124,
                stderr=f"Command timed out after {self.timeout_seconds}s: {' '.join(args)}",
            )

        return CommandResult(
            args=tuple(args),
            returncode=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
        )


@dataclass(frozen=True)
class RepositoryURL:
    raw: str
    owner: str
    name: str


@dataclass(frozen=True)
class ProjectContextReferences:
    spec_path: str | None = None
    architecture_path: str | None = None

    @property
    def missing(self) -> tuple[str, ...]:
        missing: list[str] = []
        if self.spec_path is None:
            missing.append("spec")
        if self.architecture_path is None:
            missing.append("architecture")
        return tuple(missing)

    @property
    def is_complete(self) -> bool:
        return not self.missing


class ProjectImporter:
    """Import Chorus projects from GitHub repositories using the configured gh CLI."""

    def __init__(
        self,
        store: ChorusStore,
        *,
        projects_dir: str | Path = DEFAULT_PROJECTS_DIR,
        command_runner: CommandRunner | None = None,
        integration_branch: str = DEFAULT_INTEGRATION_BRANCH,
    ) -> None:
        self.store = store
        self.projects_dir = Path(projects_dir)
        self.command_runner = command_runner or SubprocessCommandRunner()
        self.integration_branch = integration_branch

    def import_from_url(
        self,
        repo_url: str,
        *,
        name: str | None = None,
        integration_branch: str | None = None,
    ) -> dict[str, object]:
        repository = validate_github_repo_url(repo_url)
        self._require_gh_auth()

        projects_dir = self.projects_dir.expanduser().resolve()
        local_path = projects_dir / repository.name
        if local_path.exists():
            raise CloneError(f"Local clone path already exists: {local_path}")

        projects_dir.mkdir(parents=True, exist_ok=True)
        clone_result = self.command_runner.run(
            ("gh", "repo", "clone", repository.raw, str(local_path)),
        )
        if clone_result.returncode != 0:
            raise CloneError(f"gh repo clone failed: {_command_error(clone_result)}")

        # If any post-clone step fails, remove the partial clone so the path
        # isn't left behind to block a future re-import.
        try:
            default_branch = self._read_default_branch(local_path)
            branch_name = integration_branch or self.integration_branch
            context = discover_project_context(local_path)

            return self.store.projects.create(
                name=name or repository.name,
                repo_url=repository.raw,
                local_path=str(local_path),
                spec_path=context.spec_path,
                architecture_path=context.architecture_path,
                status=_status_for_context(context),
                default_branch=default_branch,
                integration_branch=branch_name,
                metadata_json=_context_metadata({"imported_via": "gh"}, context),
            )
        except Exception:
            shutil.rmtree(local_path, ignore_errors=True)
            raise

    def _require_gh_auth(self) -> None:
        result = self.command_runner.run(("gh", "auth", "status"))
        if result.returncode != 0:
            raise GitHubAuthError(f"gh auth status failed: {_command_error(result)}")

    def _read_default_branch(self, local_path: Path) -> str:
        result = self.command_runner.run(
            ("git", "-C", str(local_path), "symbolic-ref", "--short", "refs/remotes/origin/HEAD"),
        )
        if result.returncode == 0:
            branch_ref = result.stdout.strip()
            if branch_ref.startswith("origin/"):
                return branch_ref.removeprefix("origin/")
            if branch_ref:
                return branch_ref

        fallback = self.command_runner.run(("git", "-C", str(local_path), "branch", "--show-current"))
        if fallback.returncode == 0 and fallback.stdout.strip():
            return fallback.stdout.strip()

        details = _command_error(fallback if fallback.returncode != 0 else result)
        raise CloneError(f"Unable to determine default branch for cloned repository: {details}")


def import_project_from_github(
    store: ChorusStore,
    repo_url: str,
    *,
    projects_dir: str | Path = DEFAULT_PROJECTS_DIR,
    command_runner: CommandRunner | None = None,
    integration_branch: str = DEFAULT_INTEGRATION_BRANCH,
    name: str | None = None,
) -> dict[str, object]:
    importer = ProjectImporter(
        store,
        projects_dir=projects_dir,
        command_runner=command_runner,
        integration_branch=integration_branch,
    )
    return importer.import_from_url(repo_url, name=name)


def discover_project_context(local_path: str | Path) -> ProjectContextReferences:
    """Find known project specification and architecture files in a cloned repo."""

    root = Path(local_path)
    return ProjectContextReferences(
        spec_path=_first_existing_relative_path(root, SPEC_CONTEXT_CANDIDATES),
        architecture_path=_first_existing_relative_path(root, ARCHITECTURE_CONTEXT_CANDIDATES),
    )


def refresh_project_context_from_files(store: ChorusStore, project_id: str) -> dict[str, object]:
    """Rescan a project's local clone and persist discovered context references."""

    project = store.projects.require(project_id)
    local_path = _require_project_local_path(project)
    context = discover_project_context(local_path)
    return _persist_project_context(store, project, context)


def set_project_context_content(
    store: ChorusStore,
    project_id: str,
    *,
    spec_content: str | None = None,
    architecture_content: str | None = None,
) -> dict[str, object]:
    """Store pasted or uploaded project context content and update project references."""

    if spec_content is None and architecture_content is None:
        raise ProjectContextError("At least one context content value is required.")

    project = store.projects.require(project_id)
    local_path = _require_project_local_path(project)
    spec_path = _string_or_none(project.get("spec_path"))
    architecture_path = _string_or_none(project.get("architecture_path"))

    if spec_content is not None:
        _write_context_file(
            local_path,
            DEFAULT_PASTED_SPEC_PATH,
            _validate_context_content("spec", spec_content),
        )
        spec_path = DEFAULT_PASTED_SPEC_PATH

    if architecture_content is not None:
        _write_context_file(
            local_path,
            DEFAULT_PASTED_ARCHITECTURE_PATH,
            _validate_context_content("architecture", architecture_content),
        )
        architecture_path = DEFAULT_PASTED_ARCHITECTURE_PATH

    context = ProjectContextReferences(
        spec_path=spec_path,
        architecture_path=architecture_path,
    )
    return _persist_project_context(store, project, context)


def require_project_context(store: ChorusStore, project_id: str) -> dict[str, object]:
    """Return the project when required context exists, otherwise mark and raise."""

    project = store.projects.require(project_id)
    context = ProjectContextReferences(
        spec_path=_string_or_none(project.get("spec_path")),
        architecture_path=_string_or_none(project.get("architecture_path")),
    )
    missing = _missing_existing_context_files(project, context)
    if missing:
        incomplete_context = ProjectContextReferences(
            spec_path=None if "spec" in missing else context.spec_path,
            architecture_path=None if "architecture" in missing else context.architecture_path,
        )
        _persist_project_context(store, project, incomplete_context)
        raise ProjectContextMissingError(
            "Project is missing required context: " + ", ".join(missing)
        )
    return project


_REPO_PART = re.compile(r"^[A-Za-z0-9_.-]+$")
_SCP_STYLE_URL = re.compile(r"^[^@]+@(?P<host>[^:]+):(?P<path>[^?#]+)$")


def validate_github_repo_url(repo_url: str) -> RepositoryURL:
    value = repo_url.strip()
    if not value:
        raise InvalidRepositoryURLError("Repository URL is required.")

    scp_match = _SCP_STYLE_URL.match(value)
    if scp_match:
        return _repository_from_path(value, scp_match.group("path"))

    parsed = urlparse(value)
    if parsed.scheme not in {"https", "http", "ssh"} or not parsed.netloc:
        raise InvalidRepositoryURLError(
            "Repository URL must be an HTTPS or SSH GitHub repository URL."
        )

    return _repository_from_path(value, parsed.path)


def _repository_from_path(raw_url: str, raw_path: str) -> RepositoryURL:
    path = raw_path.strip("/")
    if path.endswith(".git"):
        path = path.removesuffix(".git")

    parts = path.split("/")
    if len(parts) != 2 or not all(_is_safe_repo_part(part) for part in parts):
        raise InvalidRepositoryURLError(
            "Repository URL must identify a GitHub repository as owner/name."
        )

    return RepositoryURL(raw=raw_url, owner=parts[0], name=parts[1])


def _is_safe_repo_part(value: str) -> bool:
    return bool(value) and value not in {".", ".."} and _REPO_PART.fullmatch(value) is not None


def _command_error(result: CommandResult) -> str:
    output = result.stderr.strip() or result.stdout.strip()
    return output or f"exit code {result.returncode}"


def _first_existing_relative_path(root: Path, candidates: Sequence[str]) -> str | None:
    for candidate in candidates:
        path = root.joinpath(*candidate.split("/"))
        if path.is_file():
            return candidate
    return None


def _status_for_context(context: ProjectContextReferences) -> str:
    return PROJECT_STATUS_ACTIVE if context.is_complete else PROJECT_STATUS_NEEDS_CONTEXT


def _persist_project_context(
    store: ChorusStore,
    project: dict[str, object],
    context: ProjectContextReferences,
) -> dict[str, object]:
    return store.projects.update(
        str(project["id"]),
        spec_path=context.spec_path,
        architecture_path=context.architecture_path,
        status=_status_for_context(context),
        metadata_json=_context_metadata(_metadata_for_project(project), context),
    )


def _context_metadata(
    metadata: dict[str, Any],
    context: ProjectContextReferences,
) -> dict[str, Any]:
    context_metadata = dict(metadata.get("context") or {})
    context_metadata.update(
        {
            "spec_path": context.spec_path,
            "architecture_path": context.architecture_path,
            "missing": list(context.missing),
        }
    )
    metadata["context"] = context_metadata
    return metadata


def _metadata_for_project(project: dict[str, object]) -> dict[str, Any]:
    metadata = project.get("metadata_json")
    return dict(metadata) if isinstance(metadata, dict) else {}


def _require_project_local_path(project: dict[str, object]) -> Path:
    local_path = _string_or_none(project.get("local_path"))
    if local_path is None:
        raise ProjectContextError("Project has no local clone path for context storage.")

    path = Path(local_path)
    if not path.exists():
        raise ProjectContextError(f"Project local clone path does not exist: {path}")
    return path


def _write_context_file(root: Path, relative_path: str, content: str) -> None:
    path = root.joinpath(*relative_path.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _validate_context_content(kind: str, content: str) -> str:
    if not content.strip():
        raise ProjectContextError(f"Project {kind} content cannot be empty.")
    return content


def _missing_existing_context_files(
    project: dict[str, object],
    context: ProjectContextReferences,
) -> tuple[str, ...]:
    missing = list(context.missing)
    local_path = _string_or_none(project.get("local_path"))
    if local_path is None:
        return tuple(missing)

    root = Path(local_path)
    if context.spec_path is not None and not root.joinpath(*context.spec_path.split("/")).is_file():
        missing.append("spec")
    if (
        context.architecture_path is not None
        and not root.joinpath(*context.architecture_path.split("/")).is_file()
    ):
        missing.append("architecture")
    return tuple(dict.fromkeys(missing))


def _string_or_none(value: object) -> str | None:
    return value if isinstance(value, str) and value else None
