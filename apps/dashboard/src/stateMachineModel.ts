// Pure helpers that turn the trail (TicketEvent[]) and the live event feed into
// the shapes the per-ticket state-machine views render. Kept dependency-free
// and side-effect-free so they're trivially unit-testable.
import type { Role, TicketEvent } from "./api.js";

export const ORCHESTRATOR = "orchestrator";

/** A live-feed entry as stored in App.tsx (`e` is a ChorusEvent, loosely typed). */
export interface FeedItem {
  e: {
    type?: string;
    role?: string | null;
    ticketId?: string;
    at?: number;
    event?: { kind?: string; [k: string]: unknown };
    [k: string]: unknown;
  };
}

/** One collapsed run in the DAG (consecutive same-actor trail entries merged). */
export interface DagNode {
  actor: string;
  kind: TicketEvent["kind"];
  lastMessage: string;
  firstAt: number;
  lastAt: number;
  count: number;
}

/** A spoke/hub agent box. */
export interface AgentBox {
  name: string;
  /** Editable iff it maps to a real project Role (vs. an internal trail actor). */
  editable: boolean;
  isHub: boolean;
}

export interface ActivityItem {
  at: number;
  kind: string;
  text: string;
  source: "trail" | "live";
}

/** Ordered run sequence for a ticket, collapsing consecutive same-actor steps. */
export function buildDag(events: TicketEvent[], ticketId: string): DagNode[] {
  const steps = events
    .filter((e) => e.ticketId === ticketId && e.actor !== "system")
    .sort((a, b) => a.createdAt - b.createdAt);
  const nodes: DagNode[] = [];
  for (const s of steps) {
    const last = nodes[nodes.length - 1];
    if (last && last.actor === s.actor) {
      last.kind = s.kind;
      last.lastMessage = s.message;
      last.lastAt = s.createdAt;
      last.count += 1;
    } else {
      nodes.push({
        actor: s.actor,
        kind: s.kind,
        lastMessage: s.message,
        firstAt: s.createdAt,
        lastAt: s.createdAt,
        count: 1,
      });
    }
  }
  return nodes;
}

/**
 * Roles currently "lit" for a ticket: only when the ticket is actively being
 * processed AND that role emitted a live agent_event within `windowMs`. Multiple
 * roles can be active at once (parallel spoke agents).
 */
export function activeAgents(
  feed: FeedItem[],
  ticketId: string,
  runningTaskIds: string[],
  now: number,
  windowMs = 12000,
): Set<string> {
  const active = new Set<string>();
  if (!runningTaskIds.includes(ticketId)) return active;
  for (const { e } of feed) {
    if (
      e.type === "agent_event" &&
      e.ticketId === ticketId &&
      e.role &&
      typeof e.at === "number" &&
      e.at >= now - windowMs
    ) {
      active.add(e.role);
    }
  }
  return active;
}

/**
 * The hub + spokes for a ticket: the orchestrator hub, the project's other
 * roles as spokes, plus any actors that only appear in the trail or the live
 * feed (e.g. hybrid-mode evaluator/reviewer, whose gate outcomes are journaled
 * rather than written to the trail) so they still get a node + clickable log —
 * those are marked non-editable.
 */
export function spokeAgents(
  roles: Role[],
  events: TicketEvent[],
  ticketId: string,
  feed: FeedItem[] = [],
): AgentBox[] {
  const roleNames = new Set(roles.map((r) => r.name));
  const names = new Set<string>([ORCHESTRATOR]);
  for (const r of roles) names.add(r.name);
  for (const e of events) {
    if (e.ticketId === ticketId && e.actor && e.actor !== "system") names.add(e.actor);
  }
  for (const { e } of feed) {
    if (e.type === "agent_event" && e.ticketId === ticketId && e.role && e.role !== "system") {
      names.add(e.role);
    }
  }
  return [...names]
    .map((name) => ({ name, editable: roleNames.has(name), isHub: name === ORCHESTRATOR }))
    .sort((a, b) => (a.isHub ? -1 : b.isHub ? 1 : a.name.localeCompare(b.name)));
}

/** Best-effort one-line text for a live AgentEvent. */
export function liveEventText(ev: { kind?: string; [k: string]: unknown }): string {
  switch (ev.kind) {
    case "reasoning":
    case "message":
      return String(ev.text ?? "");
    case "command":
      return String(ev.command ?? "");
    case "file_change":
      return (Array.isArray(ev.files) ? (ev.files as string[]) : []).join(", ");
    case "plan": {
      const items = (Array.isArray(ev.items) ? ev.items : []) as { completed?: boolean; text?: string }[];
      const done = items.filter((i) => i.completed).length;
      const next = items.find((i) => !i.completed);
      return `plan ${done}/${items.length}${next?.text ? ` — ${next.text}` : ""}`;
    }
    case "quota_warning":
      return String(ev.message ?? "");
    case "log":
      return String(ev.line ?? "");
    default:
      return String(ev.kind ?? "");
  }
}

/**
 * The merged activity log for one agent on one ticket: persistent trail entries
 * plus live agent_events, time-ordered (oldest first), capped.
 */
export function agentActivity(
  events: TicketEvent[],
  feed: FeedItem[],
  ticketId: string,
  agent: string,
  cap = 200,
): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const e of events) {
    if (e.ticketId === ticketId && e.actor === agent) {
      items.push({ at: e.createdAt, kind: e.kind, text: e.message, source: "trail" });
    }
  }
  for (const { e } of feed) {
    if (e.type === "agent_event" && e.ticketId === ticketId && e.role === agent && e.event) {
      items.push({
        // Fall back to "now" (not 0/epoch) so a timestamp-less live event sorts
        // to the end of the log, not the start where the cap would drop it.
        at: typeof e.at === "number" ? e.at : Date.now(),
        kind: String(e.event.kind ?? "log"),
        text: liveEventText(e.event),
        source: "live",
      });
    }
  }
  items.sort((a, b) => a.at - b.at);
  return items.slice(-cap);
}
