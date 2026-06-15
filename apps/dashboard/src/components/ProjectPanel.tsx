import { useState } from "react";
import { api, type BackendInfo, type ProjectDetail, type TicketEvent, type ToolDef } from "../api.js";
import { ActivityTab } from "./ActivityTab.js";
import { AgentsTab } from "./AgentsTab.js";
import { SettingsTab } from "./SettingsTab.js";
import { StateMachineTab } from "./StateMachineTab.js";
import { SuggestionsTab } from "./SuggestionsTab.js";
import { TicketsTab } from "./TicketsTab.js";

type Tab = "tickets" | "agents" | "state" | "settings" | "activity" | "suggestions";

/** The project control panel: header + tabbed sections. */
export function ProjectPanel({
  detail,
  backends,
  tools,
  events,
  runningTaskIds,
  onChange,
}: {
  detail: ProjectDetail;
  backends: BackendInfo[];
  tools: ToolDef[];
  events: TicketEvent[];
  runningTaskIds: string[];
  onChange: () => void;
}) {
  const { project, tickets, roles, pullRequests, attemptJournal, changelog, suggestions } = detail;
  const [tab, setTab] = useState<Tab>("tickets");

  const needsSpec = project.status === "needs_spec";

  return (
    <div className="panel">
      <div className="projhead">
        <h2>{shortRepo(project.repoUrl)}</h2>
        <span className={`tag status-${project.status}`}>{project.status}</span>
        <span className="muted">base: {project.baseBranch} · PRs target this branch</span>
      </div>

      {needsSpec && <ProvideSpec id={project.id} onDone={onChange} />}

      <nav className="tabs">
        <TabBtn id="tickets" tab={tab} setTab={setTab} label={`Tickets (${tickets.length})`} />
        <TabBtn id="agents" tab={tab} setTab={setTab} label={`Agents (${roles.length})`} />
        <TabBtn id="state" tab={tab} setTab={setTab} label="State Machine" />
        <TabBtn id="settings" tab={tab} setTab={setTab} label="Settings" />
        <TabBtn id="activity" tab={tab} setTab={setTab} label="Activity" />
        <TabBtn
          id="suggestions"
          tab={tab}
          setTab={setTab}
          label={`Suggestions${suggestions.length ? ` (${suggestions.length})` : ""}`}
        />
      </nav>

      <div className="tabbody">
        {tab === "tickets" && (
          <TicketsTab
            projectId={project.id}
            tickets={tickets}
            events={events}
            runningTaskIds={runningTaskIds}
            onChange={onChange}
          />
        )}
        {tab === "agents" && (
          <AgentsTab
            projectId={project.id}
            roles={roles}
            backends={backends}
            tools={tools}
            onChange={onChange}
          />
        )}
        {tab === "state" && (
          <StateMachineTab tickets={tickets} events={events} runningTaskIds={runningTaskIds} />
        )}
        {tab === "settings" && <SettingsTab project={project} onSaved={onChange} />}
        {tab === "activity" && (
          <ActivityTab
            pullRequests={pullRequests}
            attemptJournal={attemptJournal}
            changelog={changelog}
          />
        )}
        {tab === "suggestions" && (
          <SuggestionsTab projectId={project.id} suggestions={suggestions} onChange={onChange} />
        )}
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
