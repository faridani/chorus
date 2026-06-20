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

  // 0002 — project-level expectations + ground rules
  `
  ALTER TABLE projects ADD COLUMN expectations TEXT NOT NULL DEFAULT '';
  ALTER TABLE projects ADD COLUMN ground_rules TEXT NOT NULL DEFAULT '[]';
  `,

  // 0003 — per-project dispatch control
  `
  ALTER TABLE projects ADD COLUMN run_state TEXT NOT NULL DEFAULT 'running';
  `,

  // 0004 — global reusable agent templates ("Agent Gallery")
  `
  CREATE TABLE agent_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    allowed TEXT NOT NULL,      -- JSON array
    forbidden TEXT NOT NULL,    -- JSON array
    backend_id TEXT NOT NULL,
    model TEXT,
    created_at INTEGER NOT NULL
  );
  `,

  // 0005 — orchestrator-driven lifecycle: ticket trail, suggestions, per-ticket branch
  `
  ALTER TABLE tickets ADD COLUMN branch TEXT;
  ALTER TABLE tickets ADD COLUMN worktree_path TEXT;

  CREATE TABLE ticket_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    ticket_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_ticket_events_project ON ticket_events(project_id, created_at);
  CREATE INDEX idx_ticket_events_ticket ON ticket_events(ticket_id, created_at);

  CREATE TABLE suggestions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    ticket_id TEXT,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_suggestions_project ON suggestions(project_id, status, created_at);
  `,

  // 0006 — PR flow: drop the integration branch, track per-ticket PRs
  `
  ALTER TABLE projects DROP COLUMN integration_branch;

  ALTER TABLE tickets ADD COLUMN pr_url TEXT;
  ALTER TABLE tickets ADD COLUMN pr_number INTEGER;

  DROP TABLE merges;
  CREATE TABLE pull_requests (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    number INTEGER,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_pull_requests_project ON pull_requests(project_id);

  -- changelog.merge_id is renamed conceptually to pr_id; the column name stays
  -- (no FK constraint existed), repurposed to hold a pull_requests.id.
  ALTER TABLE changelog RENAME COLUMN merge_id TO pr_id;
  `,

  // 0007 — runnable worktrees + reflective memory: per-project commands,
  // attempt journal, and PR→task traceability.
  `
  ALTER TABLE projects ADD COLUMN setup_command TEXT;
  ALTER TABLE projects ADD COLUMN verify_commands TEXT;   -- JSON array

  ALTER TABLE pull_requests ADD COLUMN task_id TEXT;

  CREATE TABLE attempt_journal (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    ticket_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    prompt_hash TEXT,
    diff_hash TEXT,
    verify_passed INTEGER,          -- 0/1/null
    verify_output TEXT,             -- truncated tail of programmatic verify
    diagnosis TEXT,                 -- evaluator's failure diagnosis
    next_action TEXT,               -- what the loop decided to do next
    evaluator_verdict TEXT,         -- JSON
    reviewer_verdict TEXT,          -- JSON
    proof TEXT,                     -- PR url / passing-checks summary on success
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_attempt_journal_ticket ON attempt_journal(ticket_id, created_at);
  CREATE INDEX idx_attempt_journal_project ON attempt_journal(project_id, created_at);
  `,

  // 0008 — first-class tool permissions on roles + agent templates.
  `
  ALTER TABLE roles ADD COLUMN allowed_tool_ids TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE roles ADD COLUMN forbidden_tool_ids TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE agent_templates ADD COLUMN allowed_tool_ids TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE agent_templates ADD COLUMN forbidden_tool_ids TEXT NOT NULL DEFAULT '[]';
  `,

  // 0009 — once-only command-detection gate so the boot backfill never
  // re-clobbers a user who cleared their commands, and skips already-handled
  // projects. Existing rows default to 0 → backfilled once on the next boot.
  `
  ALTER TABLE projects ADD COLUMN commands_detected INTEGER NOT NULL DEFAULT 0;
  `,

  // 0010 — per-project "auto-ideate when idle" control. Off by default; existing
  // rows stop auto-generating tickets until a user enables the toggle.
  `
  ALTER TABLE projects ADD COLUMN idle_ideation INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE projects ADD COLUMN idle_ideation_count INTEGER NOT NULL DEFAULT 1;
  `,

  // 0011 — user-settable "star" flag on tickets (display-only).
  `
  ALTER TABLE tickets ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
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
