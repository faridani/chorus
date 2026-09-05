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

/**
 * One step (turn) in the DAG: a contiguous run by a single actor between two
 * hand-offs. Consecutive same-actor trail entries are merged into one step, but
 * each *return* to an actor is its own step with its own `id` — the DAG is a
 * timeline, not a deduplicated participant list.
 *
 * `firstAt`/`lastAt` are the step's first/last *trail* entries. The activity
 * window is `[startAt, endAt)`, which is wider: it opens at the previous step's
 * last trail entry (the hand-off point) — not at this step's trail entry —
 * because agents stream their live events (commands, reasoning) *before* the
 * caller writes the summarizing trail entry. Scoping from `firstAt` would drop
 * that whole live stream; scoping from the prior hand-off captures it. Combined
 * with the actor filter in `stepActivity`, overlapping windows don't double-count.
 */
export interface DagNode {
  /** Stable per-step identity (position in the run sequence). NOT the actor. */
  id: string;
  actor: string;
  kind: TicketEvent["kind"];
  lastMessage: string;
  firstAt: number;
  lastAt: number;
  /** Inclusive lower bound of the activity window: the previous step's lastAt (or -Infinity). */
  startAt: number;
  /** Exclusive upper bound of the activity window: the next step's firstAt (or Infinity). */
  endAt: number;
  count: number;
  /** Whether this step's actor maps to a real, editable project Role. */
  editable: boolean;
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

/**
 * Ordered run sequence for a ticket: one step per hand-off. Consecutive
 * same-actor trail entries collapse into a single step, but every return to an
 * actor (orchestrator → agent → orchestrator → …) is a new step with its own
 * `id`. `roleNames` decides per-step editability — the DAG derives this itself
 * rather than borrowing the hub-and-spoke participant set.
 */
export function buildDag(
  events: TicketEvent[],
  ticketId: string,
  roleNames: Set<string> = new Set(),
): DagNode[] {
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
        id: String(nodes.length),
        actor: s.actor,
        kind: s.kind,
        lastMessage: s.message,
        firstAt: s.createdAt,
        lastAt: s.createdAt,
        startAt: Number.NEGATIVE_INFINITY,
        endAt: Number.POSITIVE_INFINITY,
        count: 1,
        editable: roleNames.has(s.actor),
      });
    }
  }
  // Activity window: a step opens at the previous step's hand-off (prev.lastAt)
  // — so it captures live events streamed before this step's trail summary — and
  // closes when the next step begins (next.firstAt). The last step stays open
  // (Infinity) so a still-running turn keeps absorbing live events.
  for (let i = 0; i < nodes.length; i++) {
    nodes[i]!.startAt = i > 0 ? nodes[i - 1]!.lastAt : Number.NEGATIVE_INFINITY;
    nodes[i]!.endAt = i < nodes.length - 1 ? nodes[i + 1]!.firstAt : Number.POSITIVE_INFINITY;
  }
  return nodes;
}

/**
 * Activity for a single DAG step: trail + live events by this step's actor that
 * fall within the step's `[startAt, endAt)` window. The window opens at the
 * prior hand-off (not this step's trail entry) so a turn's live stream — emitted
 * before its summarizing trail entry — is included. The actor filter keeps the
 * overlapping windows of adjacent (different-actor) steps from double-counting.
 * Unlike `agentActivity` (which aggregates an agent's *entire* ticket history
 * for the hub-and-spoke view), this is scoped to one turn — so two orchestrator
 * steps show different logs.
 */
export function stepActivity(
  events: TicketEvent[],
  feed: FeedItem[],
  ticketId: string,
  node: DagNode,
  cap = 200,
): ActivityItem[] {
  const inWindow = (at: number) => at >= node.startAt && at < node.endAt;
  const items: ActivityItem[] = [];
  for (const e of events) {
    if (e.ticketId === ticketId && e.actor === node.actor && inWindow(e.createdAt)) {
      items.push({ at: e.createdAt, kind: e.kind, text: e.message, source: "trail" });
    }
  }
  for (const { e } of feed) {
    if (e.type === "agent_event" && e.ticketId === ticketId && e.role === node.actor && e.event) {
      const at = typeof e.at === "number" ? e.at : Date.now();
      if (inWindow(at)) {
        items.push({ at, kind: String(e.event.kind ?? "log"), text: liveEventText(e.event), source: "live" });
      }
    }
  }
  items.sort((a, b) => a.at - b.at);
  return items.slice(-cap);
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
