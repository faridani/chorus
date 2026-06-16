import { run } from "@chorus/proc";

/**
 * Run a CLI's self-update command to completion. Best-effort and
 * **never throws**: a failed update (offline, non-zero exit, timeout, missing
 * binary) logs a warning and resolves to null so the caller proceeds with the
 * currently installed version.
 *
 * @param cmd     binary to invoke (e.g. "claude", "npm")
 * @param args    arguments (e.g. ["update"], ["install", "-g", "@openai/codex@latest"])
 * @param label   short backend label for log/trail messages (e.g. "claude")
 * @param timeoutMs hard cap on the update command
 * @returns a one-line status to record in the trail when the update ran, or
 *          null when it failed (continue with the installed version)
 */
export async function runCliUpdate(
  cmd: string,
  args: string[],
  label: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const r = await run(cmd, args, { timeoutMs });
    if (r.code === 0) {
      const msg = `Updated ${label} CLI`;
      console.error(`[backend:${label}] ${msg} (\`${cmd} ${args.join(" ")}\`)`);
      return msg;
    }
    const tail = (r.stderr || r.stdout).trim().split("\n").slice(-3).join("\n");
    console.error(
      `[backend:${label}] update exited ${r.code}; continuing with installed version.\n${tail}`,
    );
    return null;
  } catch (err) {
    console.error(
      `[backend:${label}] update failed (${String(err)}); continuing with installed version.`,
    );
    return null;
  }
}
