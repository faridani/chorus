from __future__ import annotations

import json
import os
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from importlib import resources
from pathlib import Path
from typing import Any, Iterable, Mapping


MIGRATIONS: tuple[tuple[str, str], ...] = (
    ("001_core", "001_core.sql"),
    ("002_ticket_body", "002_ticket_body.sql"),
)
DEFAULT_DATABASE_PATH = ".chorus/chorus.db"


class NotFoundError(LookupError):
    """Raised when a persisted entity cannot be found."""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class RepositoryConfig:
    table: str
    columns: frozenset[str]
    json_columns: frozenset[str]


class EntityRepository:
    """Small repository for a single SQLite-backed entity table."""

    def __init__(
        self,
        store: ChorusStore,
        table: str,
        columns: Iterable[str],
        json_columns: Iterable[str] = (),
    ) -> None:
        self.store = store
        self.config = RepositoryConfig(
            table=table,
            columns=frozenset(columns),
            json_columns=frozenset(json_columns),
        )

    def create(self, **values: Any) -> dict[str, Any]:
        record = dict(values)
        record.setdefault("id", str(uuid.uuid4()))
        now = _utc_now()
        if "created_at" in self.config.columns:
            record.setdefault("created_at", now)
        if "updated_at" in self.config.columns:
            record.setdefault("updated_at", now)
        self._validate_columns(record.keys(), action="create")

        columns = tuple(record.keys())
        placeholders = ", ".join("?" for _ in columns)
        column_sql = ", ".join(columns)
        encoded_values = [self._encode_value(column, record[column]) for column in columns]

        self.store.connection.execute(
            f"INSERT INTO {self.config.table} ({column_sql}) VALUES ({placeholders})",
            encoded_values,
        )
        self.store.connection.commit()
        return self.require(record["id"])

    def get(self, entity_id: str) -> dict[str, Any] | None:
        row = self.store.connection.execute(
            f"SELECT * FROM {self.config.table} WHERE id = ?",
            (entity_id,),
        ).fetchone()
        if row is None:
            return None
        return self._decode_row(row)

    def require(self, entity_id: str) -> dict[str, Any]:
        record = self.get(entity_id)
        if record is None:
            raise NotFoundError(f"{self.config.table} record not found: {entity_id}")
        return record

    def update(self, entity_id: str, **changes: Any) -> dict[str, Any]:
        if not changes:
            return self.require(entity_id)

        forbidden = {"id", "created_at"}
        if forbidden.intersection(changes):
            blocked = ", ".join(sorted(forbidden.intersection(changes)))
            raise ValueError(f"Cannot update immutable columns on {self.config.table}: {blocked}")

        record = dict(changes)
        if "updated_at" in self.config.columns:
            record.setdefault("updated_at", _utc_now())
        self._validate_columns(record.keys(), action="update")

        assignments = ", ".join(f"{column} = ?" for column in record)
        encoded_values = [self._encode_value(column, value) for column, value in record.items()]
        cursor = self.store.connection.execute(
            f"UPDATE {self.config.table} SET {assignments} WHERE id = ?",
            [*encoded_values, entity_id],
        )
        if cursor.rowcount == 0:
            self.store.connection.rollback()
            raise NotFoundError(f"{self.config.table} record not found: {entity_id}")
        self.store.connection.commit()
        return self.require(entity_id)

    def list(
        self,
        *,
        filters: Mapping[str, Any] | None = None,
        order_by: str | None = "created_at",
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        filters = filters or {}
        self._validate_columns(filters.keys(), action="filter")

        clauses = []
        values = []
        for column, value in filters.items():
            clauses.append(f"{column} = ?")
            values.append(self._encode_value(column, value))

        sql = f"SELECT * FROM {self.config.table}"
        if clauses:
            sql = f"{sql} WHERE {' AND '.join(clauses)}"
        if order_by is not None:
            descending = order_by.startswith("-")
            column = order_by[1:] if descending else order_by
            self._validate_columns((column,), action="order")
            direction = "DESC" if descending else "ASC"
            sql = f"{sql} ORDER BY {column} {direction}"
        if limit is not None:
            sql = f"{sql} LIMIT ?"
            values.append(limit)

        rows = self.store.connection.execute(sql, values).fetchall()
        return [self._decode_row(row) for row in rows]

    def _validate_columns(self, columns: Iterable[str], *, action: str) -> None:
        unknown = sorted(set(columns).difference(self.config.columns))
        if unknown:
            raise ValueError(
                f"Unknown columns for {self.config.table} {action}: {', '.join(unknown)}"
            )

    def _encode_value(self, column: str, value: Any) -> Any:
        if column in self.config.json_columns and not isinstance(value, str):
            return json.dumps(value, sort_keys=True)
        return value

    def _decode_row(self, row: sqlite3.Row) -> dict[str, Any]:
        record = dict(row)
        for column in self.config.json_columns:
            value = record.get(column)
            if value is not None:
                record[column] = json.loads(value)
        return record


class ChorusStore:
    """SQLite-backed durable store for orchestrator and dashboard state."""

    def __init__(self, database_path: str | os.PathLike[str] | None = None) -> None:
        configured_path = database_path or os.environ.get("CHORUS_DB_PATH", DEFAULT_DATABASE_PATH)
        self.database_path = str(configured_path) if str(configured_path) == ":memory:" else Path(configured_path)
        self._connection: sqlite3.Connection | None = None

        self.projects = EntityRepository(
            self,
            "projects",
            (
                "id",
                "name",
                "repo_url",
                "local_path",
                "spec_path",
                "architecture_path",
                "status",
                "default_branch",
                "integration_branch",
                "metadata_json",
                "created_at",
                "updated_at",
                "archived_at",
            ),
            json_columns=("metadata_json",),
        )
        self.roles = EntityRepository(
            self,
            "roles",
            (
                "id",
                "project_id",
                "name",
                "description",
                "allowed_actions_json",
                "forbidden_actions_json",
                "status",
                "created_at",
                "updated_at",
            ),
            json_columns=("allowed_actions_json", "forbidden_actions_json"),
        )
        self.guardrails = EntityRepository(
            self,
            "guardrails",
            (
                "id",
                "project_id",
                "role_id",
                "scope",
                "name",
                "description",
                "rules_json",
                "severity",
                "is_enabled",
                "created_at",
                "updated_at",
            ),
            json_columns=("rules_json",),
        )
        self.tickets = EntityRepository(
            self,
            "tickets",
            (
                "id",
                "project_id",
                "assigned_role_id",
                "source",
                "external_id",
                "external_url",
                "title",
                "body",
                "description",
                "status",
                "priority",
                "labels_json",
                "metadata_json",
                "created_by",
                "created_at",
                "updated_at",
                "completed_at",
            ),
            json_columns=("labels_json", "metadata_json"),
        )
        self.agents = EntityRepository(
            self,
            "agents",
            (
                "id",
                "project_id",
                "role_id",
                "name",
                "backend",
                "status",
                "branch_name",
                "worktree_path",
                "last_heartbeat_at",
                "state_json",
                "created_at",
                "updated_at",
            ),
            json_columns=("state_json",),
        )
        self.tasks = EntityRepository(
            self,
            "tasks",
            (
                "id",
                "project_id",
                "ticket_id",
                "role_id",
                "assigned_agent_id",
                "title",
                "instructions",
                "status",
                "branch_name",
                "base_branch",
                "integration_branch",
                "priority",
                "attempt_count",
                "dependencies_json",
                "context_json",
                "result_json",
                "state_json",
                "scheduled_at",
                "started_at",
                "finished_at",
                "created_at",
                "updated_at",
            ),
            json_columns=("dependencies_json", "context_json", "result_json", "state_json"),
        )
        self.runs = EntityRepository(
            self,
            "runs",
            (
                "id",
                "project_id",
                "task_id",
                "agent_id",
                "backend",
                "command",
                "status",
                "pid",
                "exit_code",
                "input_tokens",
                "output_tokens",
                "quota_units",
                "cost_estimate_cents",
                "log_path",
                "state_json",
                "started_at",
                "last_heartbeat_at",
                "finished_at",
                "resume_after_at",
                "created_at",
                "updated_at",
            ),
            json_columns=("state_json",),
        )
        self.quota_samples = EntityRepository(
            self,
            "quota_samples",
            (
                "id",
                "project_id",
                "agent_id",
                "backend",
                "source",
                "quota_limit",
                "quota_used",
                "quota_remaining",
                "input_tokens_total",
                "output_tokens_total",
                "cost_estimate_cents",
                "sampled_at",
                "resets_at",
                "raw_json",
                "created_at",
            ),
            json_columns=("raw_json",),
        )
        self.branch_states = EntityRepository(
            self,
            "branch_states",
            (
                "id",
                "project_id",
                "branch_name",
                "kind",
                "status",
                "head_sha",
                "base_branch",
                "base_sha",
                "worktree_path",
                "is_dirty",
                "ahead_count",
                "behind_count",
                "last_checked_at",
                "state_json",
                "created_at",
                "updated_at",
            ),
            json_columns=("state_json",),
        )
        self.merges = EntityRepository(
            self,
            "merges",
            (
                "id",
                "project_id",
                "task_id",
                "run_id",
                "merged_by_agent_id",
                "source_branch",
                "target_branch",
                "source_sha",
                "target_sha_before",
                "target_sha_after",
                "status",
                "summary",
                "conflict_details",
                "state_json",
                "started_at",
                "completed_at",
                "created_at",
                "updated_at",
            ),
            json_columns=("state_json",),
        )
        self.changelog_entries = EntityRepository(
            self,
            "changelog_entries",
            (
                "id",
                "project_id",
                "merge_id",
                "task_id",
                "agent_id",
                "title",
                "body",
                "category",
                "occurred_at",
                "metadata_json",
                "created_at",
                "updated_at",
            ),
            json_columns=("metadata_json",),
        )
        self.notifications = EntityRepository(
            self,
            "notifications",
            (
                "id",
                "project_id",
                "merge_id",
                "changelog_entry_id",
                "channel",
                "recipient",
                "status",
                "subject",
                "body",
                "error",
                "payload_json",
                "scheduled_at",
                "sent_at",
                "created_at",
                "updated_at",
            ),
            json_columns=("payload_json",),
        )

    @property
    def connection(self) -> sqlite3.Connection:
        if self._connection is None:
            self.connect()
        assert self._connection is not None
        return self._connection

    def connect(self) -> ChorusStore:
        if self._connection is not None:
            return self

        if self.database_path == ":memory:":
            connection = sqlite3.connect(":memory:")
        else:
            path = Path(self.database_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            connection = sqlite3.connect(path)
            connection.execute("PRAGMA journal_mode = WAL")

        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        self._connection = connection
        return self

    def migrate(self) -> ChorusStore:
        connection = self.connection
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL
            )
            """
        )
        connection.commit()

        # Apply each migration and record it atomically. SQLite supports
        # transactional DDL, but Python's sqlite3 auto-commits around DDL unless
        # we drive transactions explicitly (isolation_level=None). Using
        # executescript() would COMMIT mid-migration, so a crash between the
        # schema change and the schema_migrations insert would re-run the
        # migration on next start and fail (e.g. "duplicate column name").
        previous_isolation = connection.isolation_level
        connection.isolation_level = None
        try:
            for migration_id, filename in MIGRATIONS:
                applied = connection.execute(
                    "SELECT 1 FROM schema_migrations WHERE id = ?",
                    (migration_id,),
                ).fetchone()
                if applied:
                    continue

                sql = (
                    resources.files("chorus.persistence.migrations")
                    .joinpath(filename)
                    .read_text(encoding="utf-8")
                )
                statements = [s.strip() for s in sql.split(";") if s.strip()]
                try:
                    connection.execute("BEGIN")
                    for statement in statements:
                        connection.execute(statement)
                    connection.execute(
                        "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
                        (migration_id, _utc_now()),
                    )
                    connection.execute("COMMIT")
                except Exception:
                    connection.execute("ROLLBACK")
                    raise
        finally:
            connection.isolation_level = previous_isolation
        return self

    initialize = migrate

    def close(self) -> None:
        if self._connection is not None:
            self._connection.close()
            self._connection = None

    def __enter__(self) -> ChorusStore:
        return self.connect().migrate()

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.close()


def open_store(database_path: str | os.PathLike[str] | None = None) -> ChorusStore:
    """Open a Chorus store and apply all bundled migrations."""

    return ChorusStore(database_path).connect().migrate()
