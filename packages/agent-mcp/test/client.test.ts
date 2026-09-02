import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { callDaemon } from "../src/client.js";

/** Start a throwaway loopback server with a per-request handler; returns its base URL. */
async function serve(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("no address");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("callDaemon awaits a delayed response instead of timing out", async () => {
  // Simulates a multi-second run_agent: the daemon sends nothing until it's done.
  const { url, close } = await serve((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ worktreeId: "wt_1", ok: true }));
    }, 600);
  });
  try {
    const { ok, text } = await callDaemon(url, "tok", "POST", "/run_agent", { agent: "dev" }, 5000);
    assert.equal(ok, true);
    assert.match(text, /wt_1/);
  } finally {
    await close();
  }
});

test("callDaemon aborts after the timeout when the daemon never responds", async () => {
  // Accept the connection but never reply — the old fetch path would surface
  // undici's ~300s headersTimeout; here we cap explicitly and report it.
  const { url, close } = await serve(() => {
    /* intentionally never responds */
  });
  try {
    const { ok, text } = await callDaemon(url, "tok", "POST", "/run_agent", {}, 250);
    assert.equal(ok, false);
    assert.match(text, /timed out after 250 ms/);
  } finally {
    await close();
  }
});

test("callDaemon reports a non-2xx response as not ok with the body text", async () => {
  const { url, close } = await serve((req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unknown agent" }));
  });
  try {
    const { ok, text } = await callDaemon(url, "tok", "POST", "/run_agent", {}, 5000);
    assert.equal(ok, false);
    assert.match(text, /unknown agent/);
  } finally {
    await close();
  }
});

test("callDaemon reports a connection failure without throwing", async () => {
  // Nothing listening on this port → connection refused, surfaced as ok:false.
  const { ok, text } = await callDaemon("http://127.0.0.1:1", "tok", "GET", "/context", null, 1000);
  assert.equal(ok, false);
  assert.match(text, /bridge could not reach daemon/);
});

test("callDaemon reports a malformed daemon URL without throwing", async () => {
  const { ok, text } = await callDaemon("not-a-url", "tok", "POST", "/run_agent", {}, 1000);
  assert.equal(ok, false);
  assert.match(text, /bridge call setup failed/);
});

test("callDaemon mid-response connection reset is reported, not thrown", async () => {
  // Send headers, then destroy the socket before the body ends → "error" on res.
  const { url, close } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-length": "999" });
    res.write("{");
    res.socket?.destroy();
  });
  try {
    const { ok } = await callDaemon(url, "tok", "POST", "/run_agent", {}, 5000);
    assert.equal(ok, false);
  } finally {
    await close();
  }
});
