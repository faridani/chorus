import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { StringDecoder } from "node:string_decoder";

export interface StreamSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Absolute path to write the interleaved raw log. Omit/null for no transcript persistence. */
  rawLogPath?: string | null;
  /** Keep stdin open so callers can drive an interactive process. */
  stdin?: "ignore" | "pipe";
  /** Wrap the command in a host PTY helper so the child sees a TTY. */
  pty?: boolean;
  /**
   * Open an out-of-band control pipe (child fd 3) so the PTY can be resized via
   * {@link StreamingProcess.resize}. Only honored on the python-bridge PTY path;
   * a safe no-op on the `/bin/script`, bare-spawn, and non-PTY paths.
   */
  ptyControl?: boolean;
  /** Hard wall-clock cap (ms). */
  maxWallClockMs?: number;
  /** Kill if no stdout line arrives within this many ms. */
  idleTimeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL on stop (ms). */
  killGraceMs?: number;
  /** How many chars of stderr to retain for classification. */
  stderrTailBytes?: number;
}

export type StopOutcome =
  | "completed"
  | "killed"
  | "timeout"
  | "idle_timeout"
  | "crashed";

export interface StreamExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Tail of stderr captured during the run. */
  stderrTail: string;
  /** Why the process ended, from our point of view. */
  outcome: StopOutcome;
}

/**
 * A long-running child process spawned in its own process group, with
 * line-oriented stdout parsing, a bounded stderr tail, a raw interleaved log,
 * idle + wall-clock timeouts, and group-aware kill.
 *
 * `codex exec` spawns its own children (git, the model transport); killing
 * only the direct child orphans them, so we spawn detached and signal the
 * whole group via `process.kill(-pgid, ...)`.
 */
export class StreamingProcess {
  readonly pid: number | undefined;
  /** Process-group id (== pid when detached succeeds). */
  readonly pgid: number | undefined;

  private readonly child: ChildProcess;
  private readonly rl: Interface;
  private readonly rawLog: WriteStream | undefined;
  private stderrTail = "";
  private readonly stderrTailBytes: number;

  private lineHandlers: Array<(line: string) => void> = [];
  private dataHandlers: Array<(data: string) => void> = [];
  private stderrHandlers: Array<(data: string) => void> = [];
  private idleTimer: NodeJS.Timeout | undefined;
  private wallTimer: NodeJS.Timeout | undefined;
  private outcome: StopOutcome = "completed";
  private settled = false;

  readonly exit: Promise<StreamExit>;

  constructor(cmd: string, args: string[], opts: StreamSpawnOptions) {
    this.stderrTailBytes = opts.stderrTailBytes ?? 16 * 1024;
    this.rawLog = opts.rawLogPath ? createWriteStream(opts.rawLogPath, { flags: "a" }) : undefined;
    this.writeRaw(`$ ${cmd} ${args.join(" ")}\n`);
    const spawnSpec = opts.pty ? ptyWrappedCommand(cmd, args) : { cmd, args, controlFd: false };

    // Open a 4th pipe (child fd 3) only when a resize control channel is both
    // requested and supported by the chosen PTY helper, so it never leaks into
    // bare shells / `/bin/script` / agent runs.
    const useControl = !!opts.ptyControl && spawnSpec.controlFd;
    const stdio: ("pipe" | "ignore")[] = [opts.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"];
    if (useControl) stdio.push("pipe");

    this.child = spawn(spawnSpec.cmd, spawnSpec.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      // Own process group so we can group-kill the process and any children.
      detached: true,
      stdio,
    });
    this.pid = this.child.pid;
    this.pgid = this.child.pid; // leader of its own group

    const stdoutDecoder = new StringDecoder("utf8");
    this.child.stdout!.on("data", (d: Buffer) => {
      this.bumpIdleTimer(opts.idleTimeoutMs);
      const s = stdoutDecoder.write(d);
      if (!s) return;
      this.writeRaw(s);
      for (const h of this.dataHandlers) h(s);
    });

    this.rl = createInterface({ input: this.child.stdout!, crlfDelay: Infinity });
    this.rl.on("line", (line) => {
      for (const h of this.lineHandlers) h(line);
    });

    // Decode stderr through a StringDecoder so a multibyte UTF-8 sequence split
    // across two chunks isn't corrupted (the tail feeds quota classification).
    const stderrDecoder = new StringDecoder("utf8");
    this.child.stderr!.on("data", (d: Buffer) => {
      const s = stderrDecoder.write(d);
      if (!s) return;
      this.writeRaw(s, "stderr");
      this.stderrTail = (this.stderrTail + s).slice(-this.stderrTailBytes);
      for (const h of this.stderrHandlers) h(s);
    });

    if (opts.maxWallClockMs) {
      this.wallTimer = setTimeout(() => {
        this.outcome = "timeout";
        this.forceKill();
      }, opts.maxWallClockMs);
    }
    this.bumpIdleTimer(opts.idleTimeoutMs);

    this.exit = new Promise<StreamExit>((resolve) => {
      this.child.on("error", (err) => {
        this.writeRaw(`\n[spawn error] ${String(err)}\n`, "stderr");
        if (this.outcome === "completed") this.outcome = "crashed";
      });
      // `close` fires after stdio is flushed, so the raw log + tail are complete.
      this.child.on("close", (code, signal) => {
        if (this.settled) return;
        this.settled = true;
        this.cleanup();
        if (signal && this.outcome === "completed") this.outcome = "crashed";
        this.rawLog?.end();
        resolve({ code, signal, stderrTail: this.stderrTail, outcome: this.outcome });
      });
    });
    this.killGraceMs = opts.killGraceMs ?? 10_000;
  }

  private killGraceMs: number;

  /** Register a handler invoked for each complete stdout line. */
  onLine(handler: (line: string) => void): void {
    this.lineHandlers.push(handler);
  }

  /** Register a handler invoked for each stdout data chunk. */
  onData(handler: (data: string) => void): void {
    this.dataHandlers.push(handler);
  }

  /** Register a handler invoked for each stderr data chunk. */
  onStderr(handler: (data: string) => void): void {
    this.stderrHandlers.push(handler);
  }

  /** Write data to the child stdin when spawned with `stdin: "pipe"`. */
  writeStdin(data: string | Buffer): boolean {
    if (!this.child.stdin?.writable) return false;
    return this.child.stdin.write(data);
  }

  /**
   * Resize the PTY to `cols`x`rows`. Only effective when spawned with
   * `pty: true` + `ptyControl: true` on the python-bridge path (the bridge
   * applies the new winsize and signals the child); a safe no-op otherwise.
   */
  resize(cols: number, rows: number): boolean {
    const ctrl = this.child.stdio[3] as NodeJS.WritableStream | undefined;
    if (!ctrl || !ctrl.writable) return false;
    const c = Math.max(1, Math.min(65535, Math.floor(cols) || 0));
    const r = Math.max(1, Math.min(65535, Math.floor(rows) || 0));
    return ctrl.write(`${c} ${r}\n`);
  }

  /** Graceful stop: SIGTERM the group, then SIGKILL after the grace period. */
  async stop(): Promise<void> {
    if (this.settled) return;
    if (this.outcome === "completed") this.outcome = "killed";
    this.signalGroup("SIGTERM");
    const killed = await Promise.race([
      this.exit.then(() => true),
      delay(this.killGraceMs).then(() => false),
    ]);
    if (!killed || this.groupExists()) this.signalGroup("SIGKILL");
    await this.exit;
  }

  private killTimer: NodeJS.Timeout | undefined;

  private forceKill(): void {
    this.signalGroup("SIGTERM");
    // Escalate to SIGKILL after the grace period, but track the timer so it can
    // be cleared on exit — otherwise it fires after the process is gone and may
    // signal a recycled PID/PGID (and keeps the event loop alive).
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => this.signalGroup("SIGKILL"), this.killGraceMs);
  }

  private signalGroup(sig: NodeJS.Signals): void {
    if (this.pgid === undefined) return;
    try {
      // Negative pid → signal the whole process group.
      process.kill(-this.pgid, sig);
    } catch {
      // Group already gone; try the direct child as a fallback.
      try {
        this.child.kill(sig);
      } catch {
        /* already dead */
      }
    }
  }

  private groupExists(): boolean {
    if (this.pgid === undefined) return false;
    try {
      process.kill(-this.pgid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private bumpIdleTimer(idleMs: number | undefined): void {
    if (!idleMs) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.outcome = "idle_timeout";
      this.forceKill();
    }, idleMs);
  }

  private cleanup(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.wallTimer) clearTimeout(this.wallTimer);
    if (this.killTimer && !this.groupExists()) clearTimeout(this.killTimer);
    this.rl.close();
  }

  private writeRaw(text: string, stream: "stdout" | "stderr" = "stdout"): void {
    const prefix = stream === "stderr" ? "[stderr] " : "";
    this.rawLog?.write(prefix + text);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ptyWrappedCommand(cmd: string, args: string[]): { cmd: string; args: string[]; controlFd: boolean } {
  const python = findExecutable("python3");
  // Only the python bridge implements the fd-3 resize/control channel.
  if (python) return { cmd: python, args: ["-c", PYTHON_PTY_BRIDGE, cmd, ...args], controlFd: true };
  if (process.platform === "darwin" || process.platform === "freebsd") return { cmd, args, controlFd: false };
  if (!existsSync("/usr/bin/script") && !existsSync("/bin/script")) return { cmd, args, controlFd: false };
  const script = existsSync("/usr/bin/script") ? "/usr/bin/script" : "/bin/script";
  return { cmd: script, args: ["-q", "-f", "-c", [cmd, ...args].map(shellQuote).join(" "), "/dev/null"], controlFd: false };
}

const PYTHON_PTY_BRIDGE = `
import os
import pty
import select
import signal
import struct
import fcntl
import termios
import time
import subprocess
import sys

def _clamp(value):
    return max(1, min(65535, value))

def _int_env(name, default):
    try:
        return _clamp(int(os.environ.get(name) or default))
    except (TypeError, ValueError):
        return default

cols = _int_env("CHORUS_PTY_COLS", 80)
rows = _int_env("CHORUS_PTY_ROWS", 24)

master_fd, slave_fd = pty.openpty()

def _set_winsize(fd, c, r):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
    except OSError:
        pass

# Size the slave before the child opens it, so the first prompt is correct.
_set_winsize(slave_fd, cols, rows)

def _child_setup():
    # Become a session leader and claim the slave pty as the controlling
    # terminal so the shell gets job control (Ctrl-Z / fg / bg) and the kernel
    # delivers SIGWINCH to the foreground group on resize.
    os.setsid()
    try:
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
    except OSError:
        pass

child = subprocess.Popen(
    sys.argv[1:],
    stdin=slave_fd,
    stdout=slave_fd,
    stderr=slave_fd,
    close_fds=True,
    preexec_fn=_child_setup,
)
os.close(slave_fd)

# The child is its own session leader (see _child_setup), so it is NOT in this
# bridge's process group and StreamingProcess's group-kill cannot reach it.
# When the daemon signals the bridge, tear down the child's group ourselves.
def _terminate(signum, frame):
    try:
        pgid = os.getpgid(child.pid)
    except OSError:
        os._exit(0)
    try:
        os.killpg(pgid, signal.SIGTERM)
    except OSError:
        pass
    deadline = time.time() + 0.08
    while time.time() < deadline:
        if child.poll() is not None:
            os._exit(0)
        time.sleep(0.005)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except OSError:
        pass
    os._exit(0)

signal.signal(signal.SIGTERM, _terminate)
signal.signal(signal.SIGHUP, _terminate)

stdin_fd = sys.stdin.fileno()
stdout_fd = sys.stdout.fileno()
ctrl_fd = 3
watch_stdin = True
try:
    os.fstat(ctrl_fd)
    watch_ctrl = True
except OSError:
    watch_ctrl = False
ctrl_buf = b""

def copy_master():
    try:
        data = os.read(master_fd, 65536)
    except OSError:
        return False
    if not data:
        return False
    os.write(stdout_fd, data)
    return True

def apply_resize(line):
    parts = line.split()
    if len(parts) != 2:
        return
    try:
        c = _clamp(int(parts[0]))
        r = _clamp(int(parts[1]))
    except ValueError:
        return
    _set_winsize(master_fd, c, r)
    try:
        os.kill(child.pid, signal.SIGWINCH)
    except OSError:
        pass

try:
    while child.poll() is None:
        fds = [master_fd]
        if watch_stdin:
            fds.append(stdin_fd)
        if watch_ctrl:
            fds.append(ctrl_fd)
        try:
            ready, _, _ = select.select(fds, [], [], 0.1)
        except OSError:
            ready = []
        if master_fd in ready and not copy_master():
            break
        if watch_stdin and stdin_fd in ready:
            try:
                data = os.read(stdin_fd, 65536)
            except OSError:
                data = b""
            if data:
                try:
                    os.write(master_fd, data)
                except OSError:
                    pass
            else:
                watch_stdin = False
        if watch_ctrl and ctrl_fd in ready:
            try:
                chunk = os.read(ctrl_fd, 4096)
            except OSError:
                chunk = b""
            if not chunk:
                # Control pipe closed: stop watching it so select() does not spin.
                watch_ctrl = False
            else:
                ctrl_buf += chunk
                lines = ctrl_buf.split(b"\\n")
                ctrl_buf = lines.pop()
                if lines:
                    # Coalesce a burst: apply only the most recent size.
                    apply_resize(lines[-1].decode("ascii", "ignore"))
finally:
    while copy_master():
        pass
    try:
        os.close(master_fd)
    except OSError:
        pass

sys.exit(child.wait())
`;

function findExecutable(name: string): string | null {
  if (name.includes("/") && existsSync(name)) return name;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
