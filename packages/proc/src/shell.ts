import { run, type RunResult } from "./run.js";

export interface ShellResult extends RunResult {
  /** The command that was run. */
  command: string;
  /** True when the command exited 0. */
  ok: boolean;
  /** Combined stdout+stderr tail, capped for logs/manifests. */
  combined: string;
}

/**
 * Run a shell command line (e.g. `npm install`, `npm run build`) to completion
 * via a login shell, so PATH/nvm/etc. resolve the way the user's terminal does.
 * Never throws on non-zero exit — the caller inspects `ok`/`code`. Used for
 * per-project setup and verify commands, which must be captured, not fatal.
 */
export async function runShell(
  command: string,
  cwd: string,
  opts: { timeoutMs?: number; tailBytes?: number } = {},
): Promise<ShellResult> {
  const r = await run("/bin/sh", ["-lc", command], {
    cwd,
    timeoutMs: opts.timeoutMs,
    throwOnError: false,
  }).catch(
    (err): RunResult =>
      // timeout / spawn error → synthesize a failed result rather than throwing.
      (err?.result as RunResult) ?? {
        code: null,
        signal: null,
        stdout: "",
        stderr: String(err),
      },
  );
  const cap = opts.tailBytes ?? 8000;
  const combinedFull = [r.stdout, r.stderr].filter(Boolean).join("\n");
  const combined =
    combinedFull.length > cap ? combinedFull.slice(combinedFull.length - cap) : combinedFull;
  return { ...r, command, ok: r.code === 0, combined };
}
