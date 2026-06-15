from __future__ import annotations

import json
import os
import shlex
import signal
import subprocess
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping, Sequence

from chorus.persistence import ChorusStore


RUN_STATUS_RUNNING = "running"
RUN_STATUS_SUCCEEDED = "succeeded"
RUN_STATUS_FAILED = "failed"
RUN_STATUS_QUOTA_EXHAUSTED = "quota_exhausted"
RUN_STATUS_CANCELLED = "cancelled"

DEFAULT_TERMINATE_TIMEOUT_SECONDS = 5.0

# Markers specific enough to trust anywhere in the output.
_QUOTA_MARKERS_ANYWHERE = (
    "quota exhausted",
    "quota exceeded",
    "exceeded your current quota",
    "insufficient quota",
    "out of credits",
)
# Additional markers only trusted on stderr, where the CLI/API emits errors.
# (Scanning the agent's stdout for these caused false positives — e.g. a bare
# "429" or "limit reached" appearing in normal work output.)
_QUOTA_MARKERS_STDERR = _QUOTA_MARKERS_ANYWHERE + (
    "usage limit",
    "rate limit",
    "rate limited",
    "too many requests",
)


@dataclass(frozen=True)
class CodexRunResult:
    """Final state for a Codex CLI execution."""

    run_id: str
    status: str
    exit_code: int | None
    stdout: str
    stderr: str
    command: tuple[str, ...]
    log_path: str
    quota_exhausted: bool = False


@dataclass(frozen=True)
class _ProcessOutput:
    stdout: str
    stderr: str
    exit_code: int | None


@dataclass
class _RunState:
    run_id: str
    command: tuple[str, ...]
    repo_path: Path
    log_path: Path
    process: subprocess.Popen[str] | None
    done: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)
    cancel_requested: bool = False
    output: _ProcessOutput | None = None
    result: CodexRunResult | None = None


class CodexRunHandle:
    """Cancellable handle for a running Codex CLI task."""

    def __init__(self, backend: CodexCliBackend, state: _RunState) -> None:
        self._backend = backend
        self._state = state

    @property
    def run_id(self) -> str:
        return self._state.run_id

    @property
    def is_done(self) -> bool:
        return self._state.done.is_set()

    def cancel(self) -> bool:
        return self._backend.cancel(self.run_id)

    def wait(self, timeout: float | None = None) -> CodexRunResult:
        return self._backend._wait_for_state(self._state, timeout=timeout)


class CodexCliBackend:
    """Run agent tasks through the Codex CLI in non-interactive mode."""

    def __init__(
        self,
        store: ChorusStore,
        *,
        executable: str | os.PathLike[str] = "codex",
        model: str | None = None,
        profile: str | None = None,
        sandbox: str | None = "workspace-write",
        approval_policy: str | None = "never",
        extra_args: Sequence[str] = (),
        env: Mapping[str, str] | None = None,
        log_dir: str | os.PathLike[str] | None = None,
        terminate_timeout_seconds: float = DEFAULT_TERMINATE_TIMEOUT_SECONDS,
        run_timeout_seconds: float | None = None,
    ) -> None:
        self.store = store
        self.executable = str(executable)
        self.model = model
        self.profile = profile
        self.sandbox = sandbox
        self.approval_policy = approval_policy
        self.extra_args = tuple(extra_args)
        self.env = dict(env or {})
        self.log_dir = Path(log_dir) if log_dir is not None else None
        self.terminate_timeout_seconds = terminate_timeout_seconds
        self.run_timeout_seconds = run_timeout_seconds
        self._runs: dict[str, _RunState] = {}
        self._runs_lock = threading.Lock()

    def execute_task(
        self,
        *,
        project_id: str,
        prompt: str,
        repo_path: str | os.PathLike[str],
        task_id: str | None = None,
        agent_id: str | None = None,
        timeout: float | None = None,
    ) -> CodexRunResult:
        """Start a Codex task and wait for completion."""

        return self.start_task(
            project_id=project_id,
            prompt=prompt,
            repo_path=repo_path,
            task_id=task_id,
            agent_id=agent_id,
        ).wait(timeout=timeout)

    def start_task(
        self,
        *,
        project_id: str,
        prompt: str,
        repo_path: str | os.PathLike[str],
        task_id: str | None = None,
        agent_id: str | None = None,
    ) -> CodexRunHandle:
        """Start a Codex task and return a handle the orchestrator can cancel."""

        resolved_repo_path = Path(repo_path).expanduser().resolve()
        command = self._build_command(resolved_repo_path)
        run = self.store.runs.create(
            project_id=project_id,
            task_id=task_id,
            agent_id=agent_id,
            backend="codex",
            command=shlex.join(command),
            status="pending",
            state_json={
                "command": list(command),
                "repo_path": str(resolved_repo_path),
                "prompt_chars": len(prompt),
            },
        )
        log_path = self._log_path_for_run(str(run["id"]), resolved_repo_path)
        state = _RunState(
            run_id=str(run["id"]),
            command=command,
            repo_path=resolved_repo_path,
            log_path=log_path,
            process=None,
        )
        handle = CodexRunHandle(self, state)

        if not resolved_repo_path.is_dir():
            state.output = _ProcessOutput(
                stdout="",
                stderr=f"Repo working tree does not exist: {resolved_repo_path}",
                exit_code=1,
            )
            state.done.set()
            self._persist_result(state)
            return handle

        try:
            process = subprocess.Popen(
                command,
                cwd=resolved_repo_path,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=self._process_env(),
                # Run in its own process group so cancellation/timeout can signal
                # the whole tree (codex spawns child processes); killing only the
                # leader would orphan them and can hang output collection.
                start_new_session=True,
            )
        except FileNotFoundError:
            state.output = _ProcessOutput(
                stdout="",
                stderr=f"Required command not found: {self.executable}",
                exit_code=127,
            )
            state.done.set()
            self._persist_result(state)
            return handle
        except OSError as exc:
            state.output = _ProcessOutput(
                stdout="",
                stderr=f"Failed to start Codex CLI: {exc}",
                exit_code=1,
            )
            state.done.set()
            self._persist_result(state)
            return handle

        state.process = process
        self.store.runs.update(
            state.run_id,
            status=RUN_STATUS_RUNNING,
            pid=process.pid,
            log_path=str(log_path),
            started_at=_utc_now(),
            last_heartbeat_at=_utc_now(),
            state_json={
                "command": list(command),
                "repo_path": str(resolved_repo_path),
                "prompt_chars": len(prompt),
            },
        )

        with self._runs_lock:
            self._runs[state.run_id] = state

        collector = threading.Thread(
            target=self._collect_output,
            args=(state, prompt),
            name=f"chorus-codex-run-{state.run_id}",
            daemon=True,
        )
        collector.start()
        return handle

    def cancel(self, run_id: str) -> bool:
        """Request cancellation of a running Codex process."""

        with self._runs_lock:
            state = self._runs.get(run_id)
        if state is None:
            return False

        with state.lock:
            process = state.process
            if process is None or process.poll() is not None:
                return False
            state.cancel_requested = True

        if not _signal_process_group(process, signal.SIGTERM):
            return False

        timer = threading.Timer(
            self.terminate_timeout_seconds,
            self._kill_if_still_running,
            args=(process,),
        )
        timer.daemon = True
        timer.start()
        return True

    def wait(self, run_id: str, *, timeout: float | None = None) -> CodexRunResult:
        """Wait for a run to finish and persist its final captured output."""

        with self._runs_lock:
            state = self._runs.get(run_id)
        if state is None:
            raise KeyError(f"Codex run is not active in this backend: {run_id}")

        return self._wait_for_state(state, timeout=timeout)

    def _wait_for_state(self, state: _RunState, *, timeout: float | None = None) -> CodexRunResult:
        if not state.done.wait(timeout):
            raise TimeoutError(
                f"Codex run did not finish within {timeout} seconds: {state.run_id}"
            )
        return self._persist_result(state)

    def _collect_output(self, state: _RunState, prompt: str) -> None:
        process = state.process
        if process is None:
            return

        try:
            stdout, stderr = process.communicate(
                input=prompt, timeout=self.run_timeout_seconds
            )
            output = _ProcessOutput(
                stdout=stdout or "",
                stderr=stderr or "",
                exit_code=process.returncode,
            )
        except subprocess.TimeoutExpired:
            # Hard wall-clock cap exceeded: kill the whole group and reap.
            _signal_process_group(process, signal.SIGKILL)
            try:
                stdout, stderr = process.communicate()
            except OSError:
                stdout, stderr = "", ""
            output = _ProcessOutput(
                stdout=stdout or "",
                stderr=(stderr or "")
                + f"\nCodex run exceeded {self.run_timeout_seconds}s timeout and was terminated.",
                exit_code=process.returncode if process.returncode is not None else 124,
            )
        except OSError as exc:
            output = _ProcessOutput(
                stdout="",
                stderr=f"Failed while communicating with Codex CLI: {exc}",
                exit_code=1,
            )

        with state.lock:
            state.output = output
            state.done.set()

    def _persist_result(self, state: _RunState) -> CodexRunResult:
        with state.lock:
            if state.result is not None:
                return state.result
            if state.output is None:
                raise RuntimeError(f"Codex run finished without captured output: {state.run_id}")

            output = state.output
            quota_exhausted = is_quota_exhaustion(output.stdout, output.stderr)
            status = _status_for_output(
                exit_code=output.exit_code,
                quota_exhausted=quota_exhausted,
                cancel_requested=state.cancel_requested,
            )
            result = CodexRunResult(
                run_id=state.run_id,
                status=status,
                exit_code=output.exit_code,
                stdout=output.stdout,
                stderr=output.stderr,
                command=state.command,
                log_path=str(state.log_path),
                quota_exhausted=quota_exhausted,
            )
            state_json = {
                "command": list(state.command),
                "repo_path": str(state.repo_path),
                "stdout": output.stdout,
                "stderr": output.stderr,
                "quota_exhausted": quota_exhausted,
                "cancel_requested": state.cancel_requested,
                "log_path": str(state.log_path),
            }
            self._write_log(state, result, state_json)
            now = _utc_now()
            self.store.runs.update(
                state.run_id,
                status=status,
                exit_code=output.exit_code,
                log_path=str(state.log_path),
                state_json=state_json,
                last_heartbeat_at=now,
                finished_at=now,
            )
            state.result = result

        with self._runs_lock:
            self._runs.pop(state.run_id, None)
        return result

    def _write_log(
        self,
        state: _RunState,
        result: CodexRunResult,
        state_json: dict[str, object],
    ) -> None:
        payload = {
            "run_id": result.run_id,
            "backend": "codex",
            "status": result.status,
            "exit_code": result.exit_code,
            **state_json,
        }
        state.log_path.parent.mkdir(parents=True, exist_ok=True)
        state.log_path.write_text(
            json.dumps(payload, indent=2, sort_keys=True),
            encoding="utf-8",
        )

    def _build_command(self, repo_path: Path) -> tuple[str, ...]:
        command: list[str] = [self.executable, "exec", "--color", "never"]
        if self.model is not None:
            command.extend(("--model", self.model))
        if self.profile is not None:
            command.extend(("--profile", self.profile))
        if self.sandbox is not None:
            command.extend(("--sandbox", self.sandbox))
        if self.approval_policy is not None:
            command.extend(("--ask-for-approval", self.approval_policy))
        command.extend(("--cd", str(repo_path)))
        command.extend(self.extra_args)
        command.append("-")
        return tuple(command)

    def _log_path_for_run(self, run_id: str, repo_path: Path) -> Path:
        if self.log_dir is not None:
            base_dir = self.log_dir
        elif self.store.database_path == ":memory:":
            base_dir = repo_path / ".chorus" / "runs"
        else:
            base_dir = Path(self.store.database_path).parent / "runs"
        return base_dir / f"{run_id}.codex.json"

    def _process_env(self) -> dict[str, str]:
        process_env = os.environ.copy()
        process_env.update(self.env)
        return process_env

    def _kill_if_still_running(self, process: subprocess.Popen[str]) -> None:
        if process.poll() is not None:
            return
        _signal_process_group(process, signal.SIGKILL)


def _signal_process_group(process: subprocess.Popen[str], sig: int) -> bool:
    """Signal the process's whole group; fall back to the leader. Returns False
    only if the process is already gone."""

    if process.poll() is not None:
        return False
    try:
        os.killpg(os.getpgid(process.pid), sig)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        # getpgid/killpg may fail (e.g. group already reaped); try the leader.
        try:
            process.send_signal(sig)
            return True
        except ProcessLookupError:
            return False


def is_quota_exhaustion(stdout: str, stderr: str) -> bool:
    """Return whether Codex output contains a recognizable quota exhaustion marker.

    Quota/rate-limit errors are emitted on stderr, so generic markers are only
    matched there. Only highly specific phrases are trusted on stdout to avoid
    misclassifying ordinary agent output (e.g. code mentioning "429") as a
    quota exhaustion.
    """

    err = stderr.lower()
    if any(marker in err for marker in _QUOTA_MARKERS_STDERR):
        return True
    out = stdout.lower()
    return any(marker in out for marker in _QUOTA_MARKERS_ANYWHERE)


def _status_for_output(
    *,
    exit_code: int | None,
    quota_exhausted: bool,
    cancel_requested: bool,
) -> str:
    if cancel_requested:
        return RUN_STATUS_CANCELLED
    if quota_exhausted:
        return RUN_STATUS_QUOTA_EXHAUSTED
    if exit_code == 0:
        return RUN_STATUS_SUCCEEDED
    return RUN_STATUS_FAILED


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
