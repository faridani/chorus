import { useState } from "react";
import { api, type BackendInfo, type ProjectDetail, type TicketEvent, type ToolDef } from "../api.js";
import type { FeedItem } from "../stateMachineModel.js";
import { ActivityTab } from "./ActivityTab.js";
import { AgentsTab } from "./AgentsTab.js";
import { AiALaCarteTab, AI_A_LA_CARTE_HELP } from "./AiALaCarteTab.js";
import { GoalsTab } from "./GoalsTab.js";
import { SettingsTab } from "./SettingsTab.js";
import { StateMachineTab } from "./StateMachineTab.js";
import { SuggestionsTab } from "./SuggestionsTab.js";
import { TicketsTab } from "./TicketsTab.js";

type Tab =
  | "goals"
  | "tickets"
  | "agents"
  | "state"
  | "settings"
  | "activity"
  | "suggestions"
  | "ai-a-la-carte";

/** The project control panel: header + tabbed sections. */
export function ProjectPanel({
  detail,
  backends,
  tools,
  events,
  feed,
  runningTaskIds,
  addressingPrTicketIds,
  onChange,
  onDebugTicket,
  onSelfHeal,
}: {
  detail: ProjectDetail;
  backends: BackendInfo[];
  tools: ToolDef[];
  events: TicketEvent[];
  feed: FeedItem[];
  runningTaskIds: string[];
  addressingPrTicketIds: string[];
  onChange: () => void;
  onDebugTicket: (ticketId: string, ticketTitle: string) => void;
  onSelfHeal: (ticketId: string, ticketTitle: string) => void;
}) {
  const { project, tickets, roles, pullRequests, attemptJournal, changelog, suggestions } = detail;
  const [tab, setTab] = useState<Tab>("tickets");
  // When the state-machine view asks to edit an agent, switch to the Agents tab
  // and tell it which role to open.
  const [editRoleName, setEditRoleName] = useState<string | null>(null);

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
        <TabBtn id="goals" tab={tab} setTab={setTab} label="Goals" />
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
        <TabBtn
          id="ai-a-la-carte"
          tab={tab}
          setTab={setTab}
          label="AI Shell"
          icon=">_"
          helpText={AI_A_LA_CARTE_HELP}
        />
      </nav>

      <div className="tabbody">
        {tab === "goals" && <GoalsTab project={project} onSaved={onChange} />}
        {tab === "tickets" && (
          <TicketsTab
            projectId={project.id}
            tickets={tickets}
            events={events}
            runningTaskIds={runningTaskIds}
            addressingPrTicketIds={addressingPrTicketIds}
            idleIdeation={project.idleIdeation}
            idleIdeationCount={project.idleIdeationCount}
            onChange={onChange}
            onSelfHeal={onSelfHeal}
          />
        )}
        {tab === "agents" && (
          <AgentsTab
            projectId={project.id}
            roles={roles}
            backends={backends}
            tools={tools}
            onChange={onChange}
            openRoleName={editRoleName}
            onOpenConsumed={() => setEditRoleName(null)}
          />
        )}
        {tab === "state" && (
          <StateMachineTab
            tickets={tickets}
            events={events}
            feed={feed}
            roles={roles}
            runningTaskIds={runningTaskIds}
            onDebugTicket={onDebugTicket}
            onEditAgent={(name) => {
              setTab("agents");
              setEditRoleName(name);
            }}
            onSelfHeal={onSelfHeal}
          />
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
        {tab === "ai-a-la-carte" && <AiALaCarteTab project={project} />}
      </div>
    </div>
  );
}

function TabBtn({
  id,
  tab,
  setTab,
  label,
  icon,
  helpText,
}: {
  id: Tab;
  tab: Tab;
  setTab: (t: Tab) => void;
  label: string;
  icon?: string;
  helpText?: string;
}) {
  return (
    <button className={`tabbtn ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
      {icon && <span className="tabicon">{icon}</span>}
      {label}
      {helpText && (
        <span className="tab-help" onClick={(e) => e.stopPropagation()} title={helpText}>
          <span className="tab-help-mark" tabIndex={0} aria-label={helpText}>
            (i)
          </span>
          <span className="tab-help-tooltip" role="tooltip">
            <strong>AI a la carte</strong> — a hands-on terminal for this project. Pick any AI
            installed on this machine (Codex, Claude Code, Gemini, ...) and chat with it directly
            inside a worktree, or just run commands yourself. It's the AI <em>on the worktree</em>:
            it can read and edit the checked-out branch, run builds and tests, and start services
            from a chosen branch so you can try changes live. Use it to explore, debug, prototype,
            or pair with an agent in real time — separate from the autonomous ticket pipeline, with
            you in control of every command.
          </span>
        </span>
      )}
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
