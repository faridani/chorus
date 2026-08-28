import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AgentEvent,
  type AgentResult,
  type AgentRunHandle,
  type AgentRunSpec,
  type AIBackend,
  type BackendCapabilities,
  ChorusBus,
} from "@chorus/core";
import { runAgentProcess } from "../src/spoke-runner.js";

function fakeResult(): AgentResult {
  return {
    payload: { status: "success", summary: "did the thing", filesChanged: ["src/a.ts"], notes: "" },
    exitCode: 0,
    signal: null,
    terminalReason: "completed",
    usage: { totalTokens: 5 },
    rawLogPath: "/tmp/raw.log",
    outputFilePath: "/tmp/result.json",
  };
}

class FakeBackend implements AIBackend {
  readonly id = "fake";
  readonly capabilities: BackendCapabilities = { structuredOutput: true, usageEvents: true, resume: false };
  startRun(_spec: AgentRunSpec): AgentRunHandle {
    const events: AgentEvent[] = [
      { kind: "message", text: "working", at: 1 },
      { kind: "file_change", files: ["src/a.ts"], at: 2 },
    ];
    return {
      pid: 4242,
      pgid: 4242,
      events: (async function* () {
        for (const e of events) yield e;
      })(),
      result: Promise.resolve(fakeResult()),
      stop: async () => {},
    };
  }
}

const baseSpec: AgentRunSpec = {
  taskId: "task-1",
  prompt: "do it",
  worktreePath: "/tmp/wt",
  artifactsDir: "/tmp/art",
};

test("runAgentProcess returns the structured result and streams events to the bus", async () => {
  const bus = new ChorusBus();
  const seen: AgentEvent[] = [];
  bus.on((ev) => {
    if (ev.type === "agent_event") seen.push(ev.event);
  });

  let handlePid: number | undefined;
  const result = await runAgentProcess({
    backend: new FakeBackend(),
    spec: baseSpec,
    bus,
    projectId: "p1",
    ticketId: "t1",
    ticketTitle: "Title",
    roleName: "software-engineer",
    onHandle: (h) => {
      handlePid = h.pid;
    },
  });

  assert.equal(result.payload?.status, "success");
  assert.equal(result.terminalReason, "completed");
  assert.equal(handlePid, 4242, "onHandle receives the live handle before await");
  assert.equal(seen.length, 2, "both agent events were forwarded to the bus");
  assert.ok(seen.some((e) => e.kind === "file_change"));
});

test("runAgentProcess propagates a rejected result promise", async () => {
  const bus = new ChorusBus();
  const backend: AIBackend = {
    id: "boom",
    capabilities: { structuredOutput: true, usageEvents: true, resume: false },
    startRun: () => ({
      pid: 1,
      pgid: 1,
      events: (async function* () {})(),
      result: Promise.reject(new Error("backend died")),
      stop: async () => {},
    }),
  };

  await assert.rejects(
    () =>
      runAgentProcess({
        backend,
        spec: baseSpec,
        bus,
        projectId: "p1",
        ticketId: "t1",
        ticketTitle: "T",
        roleName: "r",
      }),
    /backend died/,
  );
});
