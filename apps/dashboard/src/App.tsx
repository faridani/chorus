import { useCallback, useEffect, useRef, useState } from "react";
import { type AppState, api, type Project, type ProjectDetail, useEvents } from "./api.js";
import { EventFeed, type FeedEntry } from "./components/EventFeed.js";
import { ProjectPanel } from "./components/ProjectPanel.js";

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const seq = useRef(0);

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
    if (e?.type && e.type !== "usage") {
      setFeed((f) => [{ seq: seq.current++, e }, ...f].slice(0, 300));
    }
    void refreshTop();
    if (selected) void refreshDetail(selected);
  });

  return (
    <div className="app">
      <header className="topbar">
        <h1>🎼 Chorus</h1>
        {state?.version && (
          <span
            className="version"
            title={`commit ${state.version.commit}${state.version.dirty ? " (dirty)" : ""} · running since ${new Date(state.version.startedAt).toLocaleString()}`}
          >
            v{state.version.number} · {state.version.commit}
            {state.version.dirty ? "*" : ""}
          </span>
        )}
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
              <li key={p.id} className={selected === p.id ? "active" : ""} onClick={() => setSelected(p.id)}>
                <div className="repo">{shortRepo(p.repoUrl)}</div>
                <div className={`tag status-${p.status}`}>{p.status}</div>
              </li>
            ))}
          </ul>
        </aside>

        <main className="main">
          {detail ? (
            <ProjectPanel
              detail={detail}
              runningTaskIds={state?.runningTasks ?? []}
              onChange={() => selected && refreshDetail(selected)}
            />
          ) : (
            <p className="empty">Select or create a project.</p>
          )}
        </main>

        <aside className="events">
          <h3>Live events</h3>
          <EventFeed entries={feed} />
        </aside>
      </div>
    </div>
  );
}

function NewProject({ onCreated }: { onCreated: (p: Project) => void }) {
  const [repoUrl, setRepoUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [specText, setSpecText] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="newproj">
      <h3>New project</h3>
      <input placeholder="github repo URL or owner/repo" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
      <input placeholder="base branch (default: main)" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
      <textarea placeholder="(optional) spec text if repo has none" value={specText} onChange={(e) => setSpecText(e.target.value)} />
      <button
        className="primary"
        disabled={busy || !repoUrl}
        onClick={async () => {
          setBusy(true);
          try {
            const p = await api.createProject(repoUrl, specText || undefined, baseBranch.trim() || undefined);
            setRepoUrl("");
            setSpecText("");
            setBaseBranch("main");
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

function shortRepo(url: string): string {
  return url.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
}
