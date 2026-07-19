import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { createInterface, type Interface } from "node:readline";

export interface StreamSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Absolute path to write the interleaved raw log. */
  rawLogPath: string;
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
  private readonly rawLog: WriteStream;
  private stderrTail = "";
  private readonly stderrTailBytes: number;

  private lineHandlers: Array<(line: string) => void> = [];
  private idleTimer: NodeJS.Timeout | undefined;
  private wallTimer: NodeJS.Timeout | undefined;
  private outcome: StopOutcome = "completed";
  private settled = false;

  readonly exit: Promise<StreamExit>;

  constructor(cmd: string, args: string[], opts: StreamSpawnOptions) {
    this.stderrTailBytes = opts.stderrTailBytes ?? 16 * 1024;
    this.rawLog = createWriteStream(opts.rawLogPath, { flags: "a" });
    this.writeRaw(`$ ${cmd} ${args.join(" ")}\n`);

    this.child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      // Own process group so we can group-kill; stdin closed (non-interactive).
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.pid = this.child.pid;
    this.pgid = this.child.pid; // leader of its own group

    this.rl = createInterface({ input: this.child.stdout!, crlfDelay: Infinity });
    this.rl.on("line", (line) => {
      this.bumpIdleTimer(opts.idleTimeoutMs);
      this.writeRaw(`${line}\n`);
      for (const h of this.lineHandlers) h(line);
    });

    this.child.stderr!.on("data", (d: Buffer) => {
      const s = d.toString();
      this.writeRaw(s, "stderr");
      this.stderrTail = (this.stderrTail + s).slice(-this.stderrTailBytes);
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
        this.rawLog.end();
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

  /** Graceful stop: SIGTERM the group, then SIGKILL after the grace period. */
  async stop(): Promise<void> {
    if (this.settled) return;
    if (this.outcome === "completed") this.outcome = "killed";
    this.signalGroup("SIGTERM");
    const killed = await Promise.race([
      this.exit.then(() => true),
      delay(this.killGraceMs).then(() => false),
    ]);
    if (!killed) this.signalGroup("SIGKILL");
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
    if (this.killTimer) clearTimeout(this.killTimer);
    this.rl.close();
  }

  private writeRaw(text: string, stream: "stdout" | "stderr" = "stdout"): void {
    const prefix = stream === "stderr" ? "[stderr] " : "";
    this.rawLog.write(prefix + text);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
