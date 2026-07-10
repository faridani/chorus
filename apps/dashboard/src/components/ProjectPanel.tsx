import { useState } from "react";
import { api, type ProjectDetail } from "../api.js";
import { ActivityTab } from "./ActivityTab.js";
import { AgentsTab } from "./AgentsTab.js";
import { SettingsTab } from "./SettingsTab.js";
import { TicketsTab } from "./TicketsTab.js";

type Tab = "tickets" | "agents" | "settings" | "activity";

/** The project control panel: header + tabbed sections. */
export function ProjectPanel({
  detail,
  runningTaskIds,
  onChange,
}: {
  detail: ProjectDetail;
  runningTaskIds: string[];
  onChange: () => void;
}) {
  const { project, tickets, roles, merges, changelog } = detail;
  const [tab, setTab] = useState<Tab>("tickets");

  const needsSpec = project.status === "needs_spec";

  return (
    <div className="panel">
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

      {needsSpec && <ProvideSpec id={project.id} onDone={onChange} />}

      <nav className="tabs">
        <TabBtn id="tickets" tab={tab} setTab={setTab} label={`Tickets (${tickets.length})`} />
        <TabBtn id="agents" tab={tab} setTab={setTab} label={`Agents (${roles.length})`} />
        <TabBtn id="settings" tab={tab} setTab={setTab} label="Settings" />
        <TabBtn id="activity" tab={tab} setTab={setTab} label="Activity" />
      </nav>

      <div className="tabbody">
        {tab === "tickets" && (
          <TicketsTab
            projectId={project.id}
            tickets={tickets}
            roles={roles}
            runningTaskIds={runningTaskIds}
            onChange={onChange}
          />
        )}
        {tab === "agents" && <AgentsTab projectId={project.id} roles={roles} onChange={onChange} />}
        {tab === "settings" && <SettingsTab project={project} onSaved={onChange} />}
        {tab === "activity" && <ActivityTab merges={merges} changelog={changelog} />}
      </div>
    </div>
  );
}

function TabBtn({
  id,
  tab,
  setTab,
  label,
}: {
  id: Tab;
  tab: Tab;
  setTab: (t: Tab) => void;
  label: string;
}) {
  return (
    <button className={`tabbtn ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
      {label}
    </button>
  );
}

function ProvideSpec({ id, onDone }: { id: string; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="providespec">
      <h3>This project has no spec — provide one to generate tickets</h3>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} />
      <button
        className="primary"
        disabled={!text || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api.provideSpec(id, text);
            onDone();
          } catch (err) {
            alert(String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Working…" : "Save spec & generate tickets"}
      </button>
    </div>
  );
}

function shortRepo(url: string): string {
  return url.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
}
