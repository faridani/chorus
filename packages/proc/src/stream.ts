import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { StringDecoder } from "node:string_decoder";

export interface StreamSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Absolute path to write the interleaved raw log. Omit/null for no transcript persistence. */
  rawLogPath?: string | null;
  /** Keep stdin open so callers can drive an interactive process. */
  stdin?: "ignore" | "pipe";
  /** Wrap the command in the host `script` utility so the child sees a TTY. */
  pty?: boolean;
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
    const spawnSpec = opts.pty ? ptyWrappedCommand(cmd, args) : { cmd, args };

    this.child = spawn(spawnSpec.cmd, spawnSpec.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      // Own process group so we can group-kill the process and any children.
      detached: true,
      stdio: [opts.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
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

function ptyWrappedCommand(cmd: string, args: string[]): { cmd: string; args: string[] } {
  if (!existsSync("/usr/bin/script") && !existsSync("/bin/script")) return { cmd, args };
  const script = existsSync("/usr/bin/script") ? "/usr/bin/script" : "/bin/script";
  if (process.platform === "darwin" || process.platform === "freebsd") {
    return { cmd: script, args: ["-q", "/dev/null", cmd, ...args] };
  }
  return { cmd: script, args: ["-q", "-f", "-c", [cmd, ...args].map(shellQuote).join(" "), "/dev/null"] };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
