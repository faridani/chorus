PRAGMA foreign_keys = ON;

CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    local_path TEXT,
    spec_path TEXT,
    architecture_path TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    default_branch TEXT NOT NULL DEFAULT 'main',
    integration_branch TEXT NOT NULL DEFAULT 'chorus/integration',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    archived_at TEXT
);

CREATE INDEX idx_projects_status ON projects(status);

CREATE TABLE roles (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    allowed_actions_json TEXT NOT NULL DEFAULT '[]',
    forbidden_actions_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(project_id, name)
);

CREATE INDEX idx_roles_project ON roles(project_id);

CREATE TABLE guardrails (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role_id TEXT REFERENCES roles(id) ON DELETE CASCADE,
    scope TEXT NOT NULL DEFAULT 'project',
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    rules_json TEXT NOT NULL DEFAULT '[]',
    severity TEXT NOT NULL DEFAULT 'error',
    is_enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_guardrails_project ON guardrails(project_id);
CREATE INDEX idx_guardrails_role ON guardrails(role_id);

CREATE TABLE tickets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    assigned_role_id TEXT REFERENCES roles(id) ON DELETE SET NULL,
    source TEXT NOT NULL DEFAULT 'built_in',
    external_id TEXT,
    external_url TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'backlog',
    priority INTEGER NOT NULL DEFAULT 0,
    labels_json TEXT NOT NULL DEFAULT '[]',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at TEXT
);

CREATE INDEX idx_tickets_project_status ON tickets(project_id, status);
CREATE INDEX idx_tickets_assigned_role ON tickets(assigned_role_id);

CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    backend TEXT NOT NULL DEFAULT 'codex',
    status TEXT NOT NULL DEFAULT 'idle',
    branch_name TEXT,
    worktree_path TEXT,
    last_heartbeat_at TEXT,
    state_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(project_id, name)
);

CREATE INDEX idx_agents_project_status ON agents(project_id, status);
CREATE INDEX idx_agents_role ON agents(role_id);

CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
    role_id TEXT REFERENCES roles(id) ON DELETE SET NULL,
    assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    branch_name TEXT,
    base_branch TEXT,
    integration_branch TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    dependencies_json TEXT NOT NULL DEFAULT '[]',
    context_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT NOT NULL DEFAULT '{}',
    state_json TEXT NOT NULL DEFAULT '{}',
    scheduled_at TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX idx_tasks_ticket ON tasks(ticket_id);
CREATE INDEX idx_tasks_assigned_agent ON tasks(assigned_agent_id);

CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    backend TEXT NOT NULL DEFAULT 'codex',
    command TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    pid INTEGER,
    exit_code INTEGER,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    quota_units REAL NOT NULL DEFAULT 0,
    cost_estimate_cents INTEGER NOT NULL DEFAULT 0,
    log_path TEXT,
    state_json TEXT NOT NULL DEFAULT '{}',
    started_at TEXT,
    last_heartbeat_at TEXT,
    finished_at TEXT,
    resume_after_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_runs_project_status ON runs(project_id, status);
CREATE INDEX idx_runs_task ON runs(task_id);
CREATE INDEX idx_runs_agent ON runs(agent_id);

CREATE TABLE quota_samples (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    backend TEXT NOT NULL DEFAULT 'codex',
    source TEXT NOT NULL DEFAULT 'cli',
    quota_limit REAL,
    quota_used REAL,
    quota_remaining REAL,
    input_tokens_total INTEGER NOT NULL DEFAULT 0,
    output_tokens_total INTEGER NOT NULL DEFAULT 0,
    cost_estimate_cents INTEGER NOT NULL DEFAULT 0,
    sampled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    resets_at TEXT,
    raw_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_quota_samples_project_time ON quota_samples(project_id, sampled_at);
CREATE INDEX idx_quota_samples_agent_time ON quota_samples(agent_id, sampled_at);

CREATE TABLE branch_states (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    branch_name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'agent',
    status TEXT NOT NULL DEFAULT 'unknown',
    head_sha TEXT,
    base_branch TEXT,
    base_sha TEXT,
    worktree_path TEXT,
    is_dirty INTEGER NOT NULL DEFAULT 0,
    ahead_count INTEGER NOT NULL DEFAULT 0,
    behind_count INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    state_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(project_id, branch_name)
);

CREATE INDEX idx_branch_states_project_kind ON branch_states(project_id, kind);

CREATE TABLE merges (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    merged_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    source_branch TEXT NOT NULL,
    target_branch TEXT NOT NULL,
    source_sha TEXT,
    target_sha_before TEXT,
    target_sha_after TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    summary TEXT NOT NULL DEFAULT '',
    conflict_details TEXT,
    state_json TEXT NOT NULL DEFAULT '{}',
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_merges_project_status ON merges(project_id, status);
CREATE INDEX idx_merges_task ON merges(task_id);

CREATE TABLE changelog_entries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    merge_id TEXT REFERENCES merges(id) ON DELETE SET NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'change',
    occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_changelog_entries_project_time ON changelog_entries(project_id, occurred_at);
CREATE INDEX idx_changelog_entries_merge ON changelog_entries(merge_id);

CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    merge_id TEXT REFERENCES merges(id) ON DELETE SET NULL,
    changelog_entry_id TEXT REFERENCES changelog_entries(id) ON DELETE SET NULL,
    channel TEXT NOT NULL,
    recipient TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    error TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    scheduled_at TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_notifications_project_status ON notifications(project_id, status);
CREATE INDEX idx_notifications_merge ON notifications(merge_id);
