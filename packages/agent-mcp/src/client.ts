import http from "node:http";
import https from "node:https";

/**
 * Default cap for a single daemon call. A `run_agent`/`run_verify` tool call is
 * a *synchronous* full spoke run: the daemon holds the connection open without
 * sending response headers until the spoke finishes (minutes). Node's global
 * `fetch` (undici) aborts such a call at its ~300s `headersTimeout` with
 * `TypeError: fetch failed`, which the orchestrator mis-reads as a delegation
 * failure and retries — spawning a DUPLICATE worker while the original spoke is
 * still running server-side. `node:http` imposes no headers timeout, so we wait
 * for the real response and only abort after a generous idle/total cap.
 */
export const DEFAULT_CALL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Call the daemon's session-scoped internal API. Returns `{ ok, text }` with the
 * same shape the bridge expects; never throws (transport failures and timeouts
 * are reported as `ok: false` with a descriptive message).
 */
export function callDaemon(
  daemonUrl: string,
  token: string,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS,
): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: { ok: boolean; text: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // URL parsing and serialization can throw synchronously (bad daemonUrl,
    // circular body) — keep the "never throws" contract by reporting instead.
    let url: URL;
    let payload: string | undefined;
    try {
      url = new URL(`${daemonUrl}/api/internal/sessions/${encodeURIComponent(token)}${path}`);
      payload = method === "POST" ? JSON.stringify(body ?? {}) : undefined;
    } catch (err) {
      done({ ok: false, text: `bridge call setup failed: ${String(err)}` });
      return;
    }
    const lib = url.protocol === "https:" ? https : http;

    const req = lib.request(
      url,
      {
        method,
        headers: {
          "content-type": "application/json",
          ...(payload ? { "content-length": String(Buffer.byteLength(payload)) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        // A connection reset mid-response emits "error" on the stream; without a
        // listener that would crash the bridge with an unhandled error event.
        res.on("error", (err) => done({ ok: false, text: `bridge could not read daemon response: ${String(err)}` }));
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          done({ ok: status >= 200 && status < 300, text: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );

    // Idle-socket timeout. The daemon sends no bytes until the spoke completes,
    // so for these single-shot JSON responses this acts as a total-call cap.
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`daemon call timed out after ${timeoutMs} ms`));
    });
    req.on("error", (err) => {
      done({ ok: false, text: `bridge could not reach daemon: ${String(err)}` });
    });

    if (payload) req.write(payload);
    req.end();
  });
}
