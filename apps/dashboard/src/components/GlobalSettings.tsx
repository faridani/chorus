import { useEffect, useState } from "react";
import { api, type GlobalSettings as Settings } from "../api.js";

/**
 * Right-side slide-out drawer for daemon-wide settings. Read-only for now —
 * its first job is to surface where Chorus keeps each project's git worktrees.
 */
export function GlobalSettings({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.settings().then(setSettings).catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h3>Global settings</h3>
          <button className="drawer-close" onClick={onClose} title="Close">
            ✕
          </button>
        </header>

        {error && <p className="empty">{error}</p>}
        {!settings && !error && <p className="empty">Loading…</p>}

        {settings && (
          <div className="settings-list">
            <SettingRow
              label="Worktrees location"
              value={settings.worktreesDir}
              hint="Each ticket's branch gets an isolated git worktree under here: worktrees/<projectId>/<ticketId>."
            />
            <SettingRow
              label="Data directory"
              value={settings.dataDir}
              hint="Root for all runtime state: SQLite db, clones, worktrees, run logs."
            />
            <SettingRow
              label="Repo clones"
              value={settings.reposDir}
              hint="Bare/working clones of each project's GitHub repo."
            />
            <SettingRow label="Bind address" value={`${settings.host}:${settings.port}`} />
            <SettingRow label="Max concurrent agents" value={String(settings.maxConcurrentAgents)} />
          </div>
        )}
      </aside>
    </div>
  );
}

function SettingRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="setting-row">
      <div className="setting-label">{label}</div>
      <code className="setting-value" title={value}>
        {value}
      </code>
      {hint && <div className="setting-hint">{hint}</div>}
    </div>
  );
}
