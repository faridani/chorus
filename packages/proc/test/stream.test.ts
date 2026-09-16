import assert from "node:assert/strict";
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
