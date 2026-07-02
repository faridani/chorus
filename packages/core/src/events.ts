import { EventEmitter } from "node:events";
import type { AgentEvent } from "./agent.js";
import type { OrchestratorState, TaskState } from "./state.js";

/**
 * Events the orchestrator broadcasts. The web layer subscribes and forwards
 * to dashboard clients over WebSocket. This is a one-way feed: state flows
 * orchestrator → bus → web → UI. The UI sends commands back over HTTP.
 */
export type ChorusEvent =
  | { type: "orchestrator_state"; state: OrchestratorState; at: number }
  | { type: "project_changed"; projectId: string; at: number }
  | { type: "ticket_changed"; projectId: string; ticketId: string; at: number }
  | {
      type: "task_changed";
      projectId: string;
      ticketId: string;
      taskId: string;
      state: TaskState;
      at: number;
    }
  | {
      type: "agent_event";
      projectId: string;
      taskId: string;
      /** Role/agent name working the ticket (null if unassigned). */
      role: string | null;
      ticketId: string;
      ticketTitle: string;
      event: AgentEvent;
      at: number;
    }
  | { type: "pr"; projectId: string; ticketId: string; prId: string; at: number }
  | { type: "changelog"; projectId: string; entryId: string; at: number }
  | { type: "usage"; projectId: string | null; at: number }
  | { type: "quota"; state: "available" | "exhausted"; resumeAt: number | null; at: number }
  | { type: "notification"; projectId: string; kind: string; title: string; body: string; at: number };

/**
 * Public/live AgentEvents are allowed onto the shared bus. Raw backend event
 * streams and durable records keep their original data; this only guards the
 * live feed consumed by WebSocket/dashboard clients.
 */
export function sanitizePublicAgentEvent(event: AgentEvent): AgentEvent | null {
  if (event.kind === "reasoning") return null;
  return event;
}

export function sanitizePublicChorusEvent(event: ChorusEvent): ChorusEvent | null {
  if (event.type !== "agent_event") return event;
  const publicEvent = sanitizePublicAgentEvent(event.event);
  if (!publicEvent) return null;
  return event;
}

/**
 * Minimal typed wrapper over EventEmitter. A single shared instance is the
 * pub/sub backbone between the orchestrator and the web layer.
 */
export class ChorusBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many subscribers (every WS client) — lift the default cap.
    this.emitter.setMaxListeners(0);
  }

  emit(event: ChorusEvent): void {
    const publicEvent = sanitizePublicChorusEvent(event);
    if (!publicEvent) return;
    this.emitter.emit("event", publicEvent);
  }

  on(listener: (event: ChorusEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
