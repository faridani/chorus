import { useCallback, useEffect, useState } from "react";
import {
  type AppState,
  api,
  type ProjectDetail,
  type Project,
  useEvents,
} from "./api.js";

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const refreshTop = useCallback(async () => {
    setState(await api.state().catch(() => null));
    setProjects(await api.projects().catch(() => []));
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    setDetail(await api.project(id).catch(() => null));
  }, []);

  useEffect(() => {
    void refreshTop();
  }, [refreshTop]);

  useEffect(() => {
    if (selected) void refreshDetail(selected);
  }, [selected, refreshDetail]);

  useEvents((e) => {
    if (e?.type) {
      const line = `${new Date(e.at ?? Date.now()).toLocaleTimeString()}  ${describe(e)}`;
      setLog((l) => [line, ...l].slice(0, 200));
    }
    void refreshTop();
    if (selected) void refreshDetail(selected);
  });

  return (
    <div className="app">
      <header className="topbar">
        <h1>🎼 Chorus</h1>
        <div className="controls">
          <span className={`pill state-${state?.orchestrator}`}>
            orchestrator: {state?.orchestrator ?? "…"}
          </span>
          <button onClick={() => api.orchestrator("start").then(refreshTop)}>Start</button>
          <button onClick={() => api.orchestrator("pause").then(refreshTop)}>Pause</button>
          <button onClick={() => api.orchestrator("stop").then(refreshTop)}>Stop</button>
        </div>
        <div className="metrics">
          <span className={`pill quota-${state?.quota.state}`}>quota: {state?.quota.state ?? "?"}</span>
          <span className="pill">
            tokens in/out: {state?.usageTotals.inputTokens ?? 0}/{state?.usageTotals.outputTokens ?? 0}
          </span>
          <span className="pill">running: {state?.runningTasks.length ?? 0}</span>
        </div>
      </header>

      <div className="body">
        <aside className="sidebar">
          <NewProject onCreated={(p) => { void refreshTop(); setSelected(p.id); }} />
          <h3>Projects</h3>
          <ul className="projlist">
            {projects.map((p) => (
              <li
                key={p.id}
                className={selected === p.id ? "active" : ""}
                onClick={() => setSelected(p.id)}
              >
                <div className="repo">{shortRepo(p.repoUrl)}</div>
                <div className={`tag status-${p.status}`}>{p.status}</div>
              </li>
            ))}
          </ul>
        </aside>

        <main className="main">
          {detail ? (
            <ProjectView detail={detail} onChange={() => selected && refreshDetail(selected)} />
          ) : (
            <p className="empty">Select or create a project.</p>
          )}
        </main>

        <aside className="events">
          <h3>Live events</h3>
          <ul>
            {log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}

function ProjectView({ detail, onChange }: { detail: ProjectDetail; onChange: () => void }) {
  const { project, tickets, merges, changelog, roles } = detail;
  return (
    <div>
      <div className="projhead">
        <h2>{shortRepo(project.repoUrl)}</h2>
        <span className={`tag status-${project.status}`}>{project.status}</span>
        <span className="muted">
          integration: {project.integrationBranch} · base: {project.baseBranch}
        </span>
        <button
          className="approve"
          onClick={async () => {
            const r = await api.approve(project.id);
            alert(r.message);
          }}
        >
          Approve → {project.baseBranch}
        </button>
      </div>

      {project.status === "needs_spec" && <ProvideSpec id={project.id} onDone={onChange} />}

      <section>
        <h3>Tickets ({tickets.length})</h3>
        <AddTicket id={project.id} onAdded={onChange} />
        <table className="tickets">
          <thead>
            <tr>
              <th>Title</th>
              <th>Role</th>
              <th>Status</th>
              <th>Latest task</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((t) => {
              const last = t.tasks[t.tasks.length - 1];
              return (
                <tr key={t.id}>
                  <td title={t.body}>{t.title}</td>
                  <td>{t.roleName}</td>
                  <td><span className={`tag status-${t.status}`}>{t.status}</span></td>
                  <td>{last ? `${last.state} (a${last.attempt})` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <div className="cols">
        <section>
          <h3>Recent merges</h3>
          <ul className="merges">
            {merges.map((m) => (
              <li key={m.id}>
                <span className={`tag status-${m.status}`}>{m.status}</span>{" "}
                {m.mergeCommit ? m.mergeCommit.slice(0, 8) : m.conflictFiles.join(", ")}
                <span className="muted"> {new Date(m.createdAt).toLocaleString()}</span>
              </li>
            ))}
            {merges.length === 0 && <li className="muted">none yet</li>}
          </ul>
        </section>

        <section>
          <h3>Changelog</h3>
          <ul className="changelog">
            {changelog.map((c) => (
              <li key={c.id}>
                <span className="muted">{new Date(c.createdAt).toLocaleString()}</span> — {c.entry}
                {c.agentRole ? ` (${c.agentRole})` : ""}
              </li>
            ))}
            {changelog.length === 0 && <li className="muted">empty</li>}
          </ul>
        </section>
      </div>

      <section>
        <h3>Roles</h3>
        <ul className="roles">
          {roles.map((r) => (
            <li key={r.id}>
              <strong>{r.name}</strong> <span className="muted">[{r.backendId}]</span> — {r.description}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function NewProject({ onCreated }: { onCreated: (p: Project) => void }) {
  const [repoUrl, setRepoUrl] = useState("");
  const [specText, setSpecText] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="newproj">
      <h3>New project</h3>
      <input
        placeholder="github repo URL or owner/repo"
        value={repoUrl}
        onChange={(e) => setRepoUrl(e.target.value)}
      />
      <textarea
        placeholder="(optional) spec text if repo has none"
        value={specText}
        onChange={(e) => setSpecText(e.target.value)}
      />
      <button
        disabled={busy || !repoUrl}
        onClick={async () => {
          setBusy(true);
          try {
            const p = await api.createProject(repoUrl, specText || undefined);
            setRepoUrl("");
            setSpecText("");
            onCreated(p);
          } catch (err) {
            alert(String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Creating…" : "Create"}
      </button>
    </div>
  );
}

function ProvideSpec({ id, onDone }: { id: string; onDone: () => void }) {
  const [text, setText] = useState("");
  return (
    <div className="providespec">
      <h3>This project has no spec — provide one</h3>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} />
      <button
        disabled={!text}
        onClick={async () => {
          await api.provideSpec(id, text);
          onDone();
        }}
      >
        Save spec & generate tickets
      </button>
    </div>
  );
}

function AddTicket({ id, onAdded }: { id: string; onAdded: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  return (
    <div className="addticket">
      <input placeholder="ticket title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input placeholder="description" value={body} onChange={(e) => setBody(e.target.value)} />
      <button
        disabled={!title || !body}
        onClick={async () => {
          await api.addTicket(id, { title, body });
          setTitle("");
          setBody("");
          onAdded();
        }}
      >
        Add
      </button>
    </div>
  );
}

function describe(e: any): string {
  switch (e.type) {
    case "task_changed":
      return `task ${e.taskId.slice(0, 12)} → ${e.state}`;
    case "merge":
      return `merge ${e.mergeId.slice(0, 12)}`;
    case "notification":
      return `🔔 ${e.title}: ${e.body?.split("\n")[0] ?? ""}`;
    case "agent_event":
      return `agent ${e.taskId.slice(0, 8)}: ${e.event?.message ?? e.event?.kind}`;
    case "quota":
      return `quota → ${e.state}`;
    case "orchestrator_state":
      return `orchestrator → ${e.state}`;
    default:
      return e.type;
  }
}

function shortRepo(url: string): string {
  return url.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
}
