import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { StreamingProcess } from "@chorus/proc";

test("StreamingProcess.stop kills the spawned process group", async () => {
  const childScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  const parentScript = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" });
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `;
  const proc = new StreamingProcess(process.execPath, ["-e", parentScript], {
    rawLogPath: null,
    killGraceMs: 200,
  });

  const childPid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for child pid")), 2000);
    proc.onLine((line) => {
      const pid = Number(line.trim());
      if (Number.isFinite(pid) && pid > 0) {
        clearTimeout(timer);
        resolve(pid);
      }
    });
  });

  await proc.stop();
  const exit = await proc.exit;
  assert.equal(exit.outcome, "killed");
  await wait(100);
  assert.equal(processExists(childPid), false);
});

test(
  "StreamingProcess.stop kills pty-wrapped foreground service process groups",
  { skip: !hasPtyWrapper() ? "host PTY helper not available" : false },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "chorus-proc-pty-"));
    const childPidPath = join(root, "child.pid");
    const childScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const parentScript = `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" });
      writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
      setInterval(() => {}, 1000);
    `;
    const proc = new StreamingProcess(process.execPath, ["-e", parentScript], {
      rawLogPath: null,
      killGraceMs: 200,
      pty: true,
      stdin: "pipe",
    });

    const childPid = await waitForPidFile(childPidPath);
    await proc.stop();
    const exit = await proc.exit;
    assert.equal(exit.outcome, "killed");
    assert.equal(await waitForProcessExit(childPid, 2000), true);
  },
);

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidFile(path: string): Promise<number> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, "utf8").trim());
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
    await wait(25);
  }
  throw new Error("timed out waiting for child pid");
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await wait(50);
  }
  return !processExists(pid);
}

function hasPtyWrapper(): boolean {
  if (process.platform === "win32") return false;
  if (findExecutable("python3")) return true;
  return process.platform !== "darwin" &&
    process.platform !== "freebsd" &&
    (existsSync("/usr/bin/script") || existsSync("/bin/script"));
}

function findExecutable(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
