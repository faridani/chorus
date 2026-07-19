import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Text piped to stdin then closed. */
  input?: string;
  /** Kill after this many ms. */
  timeoutMs?: number;
  /** Throw on non-zero exit (default false — caller inspects `code`). */
  throwOnError?: boolean;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a short-lived command to completion, buffering output. Suitable for
 * git, gh, and osascript invocations. For long-running streaming processes
 * (the agent CLIs) use {@link spawnStreaming} instead.
 */
export function run(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const result: RunResult = { code, signal, stdout, stderr };
      if (timedOut) {
        reject(
          Object.assign(new Error(`Command timed out: ${cmd} ${args.join(" ")}`), {
            result,
          }),
        );
        return;
      }
      if (opts.throwOnError && code !== 0) {
        reject(
          Object.assign(
            new Error(
              `Command failed (${code}): ${cmd} ${args.join(" ")}\n${stderr}`,
            ),
            { result },
          ),
        );
        return;
      }
      resolve(result);
    });

    // A short-lived child may close stdin before we finish writing; without an
    // error listener the resulting EPIPE becomes an unhandled 'error' and
    // crashes the process.
    child.stdin.on("error", () => {});
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}
