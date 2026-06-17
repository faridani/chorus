import type { AgentResult, AgentRunSpec, AIBackend, ChorusBus } from "@chorus/core";

/**
 * Shared "run one agent process to completion" core, used by both the hybrid
 * worker path (`runWorker`) and the autonomous session (`run_agent` tool).
 *
 * It owns the backend lifecycle that is identical in both modes: start the run,
 * stream its normalized events to the bus (scoped to the ticket/task so the
 * dashboard shows them), and await the structured result. Everything mode-
 * specific — worktree creation, db task/run records, journaling, commit
 * counting — stays with the caller.
 */
export async function runAgentProcess(args: {
  backend: AIBackend;
  spec: AgentRunSpec;
  bus: ChorusBus;
  projectId: string;
  ticketId: string;
  ticketTitle: string;
  roleName: string;
  /** Receives the live handle right after start (record pid/pgid, register Stop). */
  onHandle?: (handle: { pid?: number; pgid?: number; stop: (r: "killed") => Promise<void> }) => void;
}): Promise<AgentResult> {
  const handle = args.backend.startRun(args.spec);
  args.onHandle?.(handle);
  const drain = (async () => {
    for await (const ev of handle.events) {
      args.bus.emit({
        type: "agent_event",
        projectId: args.projectId,
        taskId: args.spec.taskId,
        role: args.roleName,
        ticketId: args.ticketId,
        ticketTitle: args.ticketTitle,
        event: ev,
        at: Date.now(),
      });
    }
  })();
  const [result] = await Promise.all([handle.result, drain]);
  return result;
}
