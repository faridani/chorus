// Renders the live event stream with agent role, ticket, and event detail.

export interface FeedEntry {
  seq: number;
  e: any;
}

export function EventFeed({ entries }: { entries: FeedEntry[] }) {
  return (
    <ul className="feed">
      {entries.map(({ seq, e }) => (
        <li key={seq} className={`feedline kind-${rowKind(e)}`}>
          <span className="ts">{time(e.at)}</span>
          <Row e={e} />
        </li>
      ))}
    </ul>
  );
}

function Row({ e }: { e: any }) {
  if (e.type === "agent_event") {
    const ev = e.event ?? {};
    return (
      <span className="entry">
        <span className="who">
          {e.role ?? "agent"}
          <span className="muted"> · {short(e.ticketTitle)}</span>
        </span>{" "}
        <AgentBody ev={ev} />
      </span>
    );
  }
  return <span className="entry">{describeSystem(e)}</span>;
}

function AgentBody({ ev }: { ev: any }) {
  switch (ev.kind) {
    case "reasoning":
      return (
        <span>
          <span className="ico">💭</span> <span className="reason">{ev.text}</span>
        </span>
      );
    case "message":
      return (
        <span>
          <span className="ico">💬</span> {ev.text}
        </span>
      );
    case "command":
      return (
        <span>
          <span className="ico">▶</span> <code>{ev.command}</code>{" "}
          {ev.status === "failed" && <span className="bad">✗ ({ev.exitCode})</span>}
        </span>
      );
    case "file_change":
      return (
        <span>
          <span className="ico">✏️</span> {(ev.files ?? []).join(", ")}
        </span>
      );
    case "plan": {
      const items = ev.items ?? [];
      const done = items.filter((i: any) => i.completed).length;
      const next = items.find((i: any) => !i.completed);
      return (
        <span>
          <span className="ico">📋</span> plan {done}/{items.length}
          {next ? ` — ${next.text}` : ""}
        </span>
      );
    }
    case "quota_warning":
      return (
        <span>
          <span className="ico">⚠️</span> {ev.message}
        </span>
      );
    case "log":
      return <span className="muted">{ev.line}</span>;
    default:
      return <span className="muted">{ev.kind}</span>;
  }
}

function describeSystem(e: any): string {
  switch (e.type) {
    case "task_changed":
      return `task ${e.taskId?.slice(0, 12)} → ${e.state}`;
    case "merge":
      return `merge ${e.mergeId?.slice(0, 12)}`;
    case "notification":
      return `🔔 ${e.title}: ${(e.body ?? "").split("\n")[0]}`;
    case "quota":
      return `quota → ${e.state}`;
    case "orchestrator_state":
      return `orchestrator → ${e.state}`;
    case "ticket_changed":
      return `ticket ${e.ticketId?.slice(0, 12)} changed`;
    case "project_changed":
      return `project ${e.projectId?.slice(0, 12)} changed`;
    case "changelog":
      return "changelog updated";
    case "hello":
      return "connected";
    default:
      return e.type ?? "event";
  }
}

function rowKind(e: any): string {
  if (e.type === "agent_event") return e.event?.kind ?? "agent";
  return e.type ?? "sys";
}
function time(at?: number): string {
  return new Date(at ?? Date.now()).toLocaleTimeString();
}
function short(s?: string): string {
  if (!s) return "";
  return s.length > 38 ? s.slice(0, 37) + "…" : s;
}
