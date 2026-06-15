import type DatabaseType from "better-sqlite3";

/**
 * Ordered, append-only migrations. Each entry's SQL runs once; the index+1 is
 * recorded as the schema version. Never edit a shipped migration — add a new one.
 */
export const MIGRATIONS: string[] = [
  // 0001 — initial schema
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    repo_url TEXT NOT NULL,
    local_path TEXT NOT NULL,
    integration_branch TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    spec_path TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE roles (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    allowed TEXT NOT NULL,      -- JSON array
    forbidden TEXT NOT NULL,    -- JSON array
    backend_id TEXT NOT NULL,
    model TEXT,
    UNIQUE(project_id, name)
  );

  CREATE TABLE tickets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    role_name TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_tickets_project ON tickets(project_id, status);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    backend_id TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    state TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    resume_at INTEGER,
    started_at INTEGER,
    ended_at INTEGER
  );
  CREATE INDEX idx_tasks_ticket ON tasks(ticket_id);
  CREATE INDEX idx_tasks_state ON tasks(state);

  CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    pid INTEGER,
    pgid INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    exit_code INTEGER,
    exit_signal TEXT,
    terminal_reason TEXT,
    raw_log_path TEXT,
    output_file_path TEXT
  );
  CREATE INDEX idx_runs_task ON agent_runs(task_id);

  CREATE TABLE merges (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    integration_branch TEXT NOT NULL,
    merge_commit TEXT,
    status TEXT NOT NULL,
    conflict_files TEXT NOT NULL,   -- JSON array
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_merges_project ON merges(project_id);

  CREATE TABLE changelog (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    ticket_id TEXT,
    merge_id TEXT,
    entry TEXT NOT NULL,
    agent_role TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_changelog_project ON changelog(project_id, created_at);

  CREATE TABLE usage_events (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    project_id TEXT,
    kind TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    detail TEXT,
    observed_at INTEGER NOT NULL
  );
  CREATE INDEX idx_usage_observed ON usage_events(observed_at);

  CREATE TABLE quota_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL,
    resume_at INTEGER,
    consecutive_pauses INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  `,
];

export function runMigrations(db: DatabaseType.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);`);
  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
    | { version: number }
    | undefined;
  let current = row?.version ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();

  for (let i = current; i < MIGRATIONS.length; i++) {
    const sql = MIGRATIONS[i]!;
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare("UPDATE schema_version SET version = ?").run(i + 1);
    });
    apply();
    current = i + 1;
  }
}
