import { type MouseEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import {
  type AppState,
  api,
  type BackendInfo,
  type Project,
  type ProjectDetail,
  type TicketEvent,
  type ToolDef,
  useEvents,
} from "./api.js";
import { AgentGallery } from "./components/AgentGallery.js";
import { EventFeed, type FeedEntry } from "./components/EventFeed.js";
import { GlobalSettings } from "./components/GlobalSettings.js";
import { LoopGallery } from "./components/LoopGallery.js";
import { ModelsPanel } from "./components/ModelsPanel.js";
import { OpenPrs } from "./components/OpenPrs.js";
import { DebugTracesModal } from "./components/DebugTracesModal.js";
import { SelfHealModal } from "./components/SelfHealModal.js";
import { ProjectPanel } from "./components/ProjectPanel.js";
import { ToolsGallery } from "./components/ToolsGallery.js";

/** Expanded width of the right pane; must match `--events-pane-width` in styles.css. */
const EVENTS_PANE_WIDTH = 320;
const READY_PROJECT_STATUS_DESCRIPTION =
  "Ready means Chorus has loaded this repo's project spec and can work its tickets when the run control is started.";

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [projectEvents, setProjectEvents] = useState<TicketEvent[]>([]);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [debug, setDebug] = useState<{ ticketId: string | null; ticketTitle?: string } | null>(null);
  const [selfHeal, setSelfHeal] = useState<{ ticketId: string; ticketTitle?: string } | null>(null);
  const [leftTab, setLeftTab] = useState<"projects" | "gallery" | "loops" | "tools">("projects");
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [tools, setTools] = useState<ToolDef[]>([]);
  const [refreshingBackends, setRefreshingBackends] = useState(false);
  const [rightPaneOpen, setRightPaneOpen] = useState(true);
  const seq = useRef(0);
  const rightPaneRef = useRef<HTMLElement | null>(null);
  const rightPaneHandleRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    void api.backends().then(setBackends).catch(() => setBackends([]));
    void api.tools().then(setTools).catch(() => setTools([]));
  }, []);

  const refreshBackends = useCallback(async () => {
    setRefreshingBackends(true);
    try {
      setBackends(await api.refreshBackends());
    } catch (err) {
      alert(String(err));
    } finally {
      setRefreshingBackends(false);
    }
  }, []);

  const refreshTop = useCallback(async () => {
    setState(await api.state().catch(() => null));
    setProjects(await api.projects().catch(() => []));
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    setDetail(await api.project(id).catch(() => null));
    setProjectEvents(await api.projectEvents(id).catch(() => []));
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

  useEffect(() => {
    if (rightPaneOpen) return;
    const active = document.activeElement;
    if (active && rightPaneRef.current?.contains(active)) {
      rightPaneHandleRef.current?.focus();
    }
  }, [rightPaneOpen]);

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
          <span
            className={`pill state-${state?.orchestrator}`}
            title="Daemon dispatch loop status. Per-project start/pause/stop controls live next to each project in the left pane."
          >
            orchestrator: {state?.orchestrator ?? "…"}
          </span>
        </div>
        <div className="metrics">
          <span className={`pill quota-${state?.quota.state}`}>quota: {state?.quota.state ?? "?"}</span>
          <span className="pill">
            tokens in/out: {state?.usageTotals.inputTokens ?? 0}/{state?.usageTotals.outputTokens ?? 0}
          </span>
          <span className="pill">running: {state?.runningTasks.length ?? 0}</span>
        </div>
        <button
          className="hamburger"
          onClick={() => setShowSettings(true)}
          title="Global settings"
          aria-label="Global settings"
        >
          ☰
        </button>
      </header>

      <div className={`body ${rightPaneOpen ? "right-pane-open" : "right-pane-collapsed"}`}>
        <aside className="sidebar">
          <nav className="tabs">
            <button
              className={`tabbtn ${leftTab === "projects" ? "active" : ""}`}
              onClick={() => setLeftTab("projects")}
              title="Your projects — each is one GitHub repo Chorus works on. Create a project, then start/pause/stop it and manage its tickets, agents, and settings."
            >
              Projects
            </button>
            <button
              className={`tabbtn ${leftTab === "gallery" ? "active" : ""}`}
              onClick={() => setLeftTab("gallery")}
              title="Reusable agent definitions usable across all projects."
            >
              Agent Gallery
            </button>
            <button
              className={`tabbtn ${leftTab === "loops" ? "active" : ""}`}
              onClick={() => setLeftTab("loops")}
              title="Loops chain Agent Gallery agents into a pipeline (e.g. Orchestrator → Feature Designer → Orchestrator → Software Dev → Test and QA → Orchestrator)."
            >
              Loop Gallery
            </button>
            <button
              className={`tabbtn ${leftTab === "tools" ? "active" : ""}`}
              onClick={() => setLeftTab("tools")}
              title="The source-defined catalog of Chorus tools agents can be granted or denied."
            >
              Tools Gallery
            </button>
          </nav>

          {leftTab === "projects" ? (
            <>
              <button className="primary newproj-btn" onClick={() => setShowNew(true)}>
                + New project
              </button>
              <ul className="projlist">
                {projects.map((p) => (
                  <li key={p.id} className={selected === p.id ? "active" : ""} onClick={() => setSelected(p.id)}>
                    <div className="repo">{shortRepo(p.repoUrl)}</div>
                    <div className="projrow">
                      <ProjectStatusTag status={p.status} />
                      <RunStateControls project={p} onChanged={refreshTop} />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : leftTab === "gallery" ? (
            <AgentGallery backends={backends} projects={projects} tools={tools} />
          ) : leftTab === "loops" ? (
            <LoopGallery />
          ) : (
            <ToolsGallery tools={tools} />
          )}
        </aside>

        <main className="main">
          {detail ? (
            <ProjectPanel
              detail={detail}
              backends={backends}
              tools={tools}
              events={projectEvents}
              feed={feed}
              runningTaskIds={state?.runningTasks ?? []}
              onChange={() => selected && refreshDetail(selected)}
              onDebugTicket={(ticketId, ticketTitle) => setDebug({ ticketId, ticketTitle })}
              onSelfHeal={(ticketId, ticketTitle) => setSelfHeal({ ticketId, ticketTitle })}
            />
          ) : (
            <p className="empty">Select or create a project.</p>
          )}
        </main>

        <div
          className="events-shell"
          onMouseLeave={(e) => {
            if (!rightPaneOpen) return;
            // While expanding, the shell column is still animating wider (the
            // `.body` grid-template-columns transition), so a fast leftward
            // mouse can fire mouseLeave even though the cursor is still within
            // where the expanded pane will sit. Only collapse on a genuine
            // exit: above/below the shell, or left of the fully-expanded edge.
            const rect = e.currentTarget.getBoundingClientRect();
            const exitedVertically = e.clientY < rect.top || e.clientY > rect.bottom;
            const exitedLeft = e.clientX < rect.right - EVENTS_PANE_WIDTH;
            if (exitedVertically || exitedLeft) setRightPaneOpen(false);
          }}
        >
          <button
            ref={rightPaneHandleRef}
            type="button"
            className="events-handle"
            aria-controls="right-side-pane"
            aria-expanded={rightPaneOpen}
            aria-label={rightPaneOpen ? "Hide right pane" : "Show right pane"}
            title={rightPaneOpen ? "Hide right pane" : "Show right pane"}
            onClick={() => setRightPaneOpen((open) => !open)}
          >
            {rightPaneOpen ? ">>" : "<<"}
          </button>
          <aside
            id="right-side-pane"
            ref={rightPaneRef}
            className="events"
            aria-label="Right pane"
            aria-hidden={!rightPaneOpen}
          >
            <div className="events-content">
              <section className="prs-pane">
                <h3>
                  Open PRs
                  {selected && detail ? (
                    <span className="muted"> — {detail.project.baseBranch}</span>
                  ) : null}
                </h3>
                <OpenPrs tickets={detail?.tickets ?? []} hasProject={!!selected} />
              </section>
              <section className="models-pane">
                <h3>
                  Models
                  <button
                    className={`runbtn refresh ${refreshingBackends ? "spinning" : ""}`}
                    onClick={refreshBackends}
                    disabled={refreshingBackends}
                    title="Refresh — re-scan the host for backend CLIs (codex, claude, gemini) and their models. Use this after installing a new CLI."
                  >
                    ↻
                  </button>
                </h3>
                <ModelsPanel backends={backends} />
              </section>
              <section className="feed-pane">
                <h3>
                  Live events
                  {selected ? (
                    <span className="muted"> — {shortRepo(projects.find((p) => p.id === selected)?.repoUrl ?? "")}</span>
                  ) : (
                    <span className="muted"> — all projects</span>
                  )}
                  <button
                    className="debugbtn"
                    disabled={!selected}
                    title={selected ? "Diagnose recent agent/orchestrator activity" : "Select a project first"}
                    onClick={() => setDebug({ ticketId: null })}
                  >
                    Debug Traces
                  </button>
                  <button
                    className="debugbtn"
                    disabled={feed.length === 0}
                    title="Clear the on-screen Live events buffer (does not touch the database; new activity repopulates it)"
                    onClick={() => setFeed([])}
                  >
                    Clear
                  </button>
                </h3>
                <EventFeed
                  entries={
                    selected
                      ? feed.filter(({ e }) => !e.projectId || e.projectId === selected)
                      : feed
                  }
                />
              </section>
            </div>
          </aside>
        </div>
      </div>

      {showSettings && <GlobalSettings onClose={() => setShowSettings(false)} />}

      {debug && selected && (
        <DebugTracesModal
          key={`${selected}-${debug.ticketId ?? "project"}`}
          projectId={selected}
          ticketId={debug.ticketId}
          ticketTitle={debug.ticketTitle}
          liveEvents={feed
            .filter(({ e }) => !e.projectId || e.projectId === selected)
            .slice(0, 200)
            .map(({ e }) => e)}
          onClose={() => setDebug(null)}
          onTicketCreated={() => {
            void refreshTop();
            if (selected) void refreshDetail(selected);
          }}
        />
      )}

      {selfHeal && selected && (
        <SelfHealModal
          key={`${selected}-${selfHeal.ticketId}`}
          projectId={selected}
          ticketId={selfHeal.ticketId}
          ticketTitle={selfHeal.ticketTitle}
          liveEvents={feed
            .filter(({ e }) => !e.projectId || e.projectId === selected)
            .slice(0, 200)
            .map(({ e }) => e)}
          onClose={() => setSelfHeal(null)}
          onApplied={() => {
            if (selected) void refreshDetail(selected);
          }}
        />
      )}

      {showNew && (
        <NewProject
          onClose={() => setShowNew(false)}
          onCreated={(p) => {
            setShowNew(false);
            void refreshTop();
            setSelected(p.id);
          }}
        />
      )}
    </div>
  );
}

function NewProject({
  onCreated,
  onClose,
}: {
  onCreated: (p: Project) => void;
  onClose: () => void;
}) {
  const [repoUrl, setRepoUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [specText, setSpecText] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const p = await api.createProject(repoUrl, specText || undefined, baseBranch.trim() || undefined);
      onCreated(p);
    } catch (err) {
      alert(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New project</h3>

        <label>GitHub repo URL or owner/repo</label>
        <input
          autoFocus
          placeholder="https://github.com/owner/repo  or  owner/repo"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
        />

        <label>Main branch</label>
        <input
          placeholder="main"
          value={baseBranch}
          onChange={(e) => setBaseBranch(e.target.value)}
          title="The repo's base/main branch (default: main). Chorus cuts each ticket's branch from here and opens a GitHub PR against it when the work is ready; you merge the PR manually. It is never modified autonomously."
        />

        <label>Spec text (optional — only if the repo has no docs/SPEC.md)</label>
        <textarea
          rows={6}
          placeholder="Paste a project specification here if the repo doesn't already contain one."
          value={specText}
          onChange={(e) => setSpecText(e.target.value)}
        />

        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !repoUrl.trim()} onClick={create}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectStatusTag({ status }: { status: Project["status"] }) {
  const tooltipId = useId();
  const className = `tag status-${status}`;

  if (status !== "ready") {
    return <span className={className}>{status}</span>;
  }

  return (
    <span className="status-tip">
      <span className={className} tabIndex={0} aria-describedby={tooltipId}>
        {status}
      </span>
      <span id={tooltipId} className="status-tooltip" role="tooltip">
        {READY_PROJECT_STATUS_DESCRIPTION}
      </span>
    </span>
  );
}

function RunStateControls({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const set = async (e: MouseEvent, state: "running" | "paused" | "stopped") => {
    e.stopPropagation(); // don't trigger project selection
    try {
      await api.setProjectRunState(project.id, state);
      onChanged();
    } catch (err) {
      alert(String(err));
    }
  };
  const cur = project.runState;
  return (
    <span className="runctl">
      <button
        className={`runbtn ${cur === "running" ? "on run" : ""}`}
        onClick={(e) => set(e, "running")}
        title="Start — assign this project's tickets to agents and resume work."
      >
        ▶
      </button>
      <button
        className={`runbtn ${cur === "paused" ? "on pause" : ""}`}
        onClick={(e) => set(e, "paused")}
        title="Pause — stop assigning NEW tickets, but let agents already working finish their current ticket. No work is lost; resume by pressing Start."
      >
        ⏸
      </button>
      <button
        className={`runbtn ${cur === "stopped" ? "on stop" : ""}`}
        onClick={(e) => set(e, "stopped")}
        title="Stop — stop assigning new tickets AND immediately halt any agents currently working on this project (their in-progress, uncommitted work is discarded and the ticket is requeued). Use Pause instead if you only want to hold new work."
      >
        ⏹
      </button>
    </span>
  );
}

function shortRepo(url: string): string {
  return url.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
}
