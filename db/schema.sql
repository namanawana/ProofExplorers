-- ============================================================================
-- Proof Explorer - PostgreSQL schema (v1)
-- ----------------------------------------------------------------------------
-- Design notes
--  * Postgres is the permanent source of truth; Redis (if used) is only a cache.
--  * Full proof states are NOT stored for every step. Only transitions (small)
--    are stored per step; full states are stored at checkpoints and recomputed
--    by deterministic replay in between (see CheckpointManager).
--  * `events` is append-only. Never UPDATE or DELETE rows in it.
-- ============================================================================

CREATE TABLE projects (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE files (
  id            UUID PRIMARY KEY,
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  content_hash  TEXT NOT NULL,         -- contents live in object storage / disk
  line_count    INTEGER NOT NULL,
  UNIQUE (project_id, path)
);

-- Hierarchy: adjacency list, so nesting depth is unbounded (Invariant 7).
CREATE TABLE proof_units (
  id            TEXT PRIMARY KEY,
  file_id       UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  parent_id     TEXT REFERENCES proof_units(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  name          TEXT,
  statement     TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  start_line    INTEGER, start_column INTEGER,
  end_line      INTEGER, end_column   INTEGER,
  metadata      JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX proof_units_parent_idx ON proof_units(parent_id);
CREATE INDEX proof_units_file_idx   ON proof_units(file_id);

-- Dependency DAG. Every edge carries evidence (Invariant 4).
CREATE TABLE dependencies (
  id             TEXT PRIMARY KEY,
  from_unit_id   TEXT NOT NULL REFERENCES proof_units(id) ON DELETE CASCADE,
  to_unit_id     TEXT NOT NULL REFERENCES proof_units(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  evidence_kind  TEXT NOT NULL CHECK (evidence_kind IN ('syntactic','elaborated')),
  ev_line        INTEGER NOT NULL,
  ev_column      INTEGER NOT NULL,
  UNIQUE (from_unit_id, to_unit_id, kind, ev_line, ev_column)
);
CREATE INDEX dependencies_from_idx ON dependencies(from_unit_id);
CREATE INDEX dependencies_to_idx   ON dependencies(to_unit_id);

CREATE TABLE sessions (
  id             UUID PRIMARY KEY,
  project_id     UUID NOT NULL REFERENCES projects(id),
  file_id        UUID NOT NULL REFERENCES files(id),
  proof_unit_id  TEXT NOT NULL REFERENCES proof_units(id),
  status         TEXT NOT NULL,
  lean_version   TEXT NOT NULL,
  frontier_step  INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per committed transition. Rejected commands are never inserted
-- (Invariant 3); they only appear in `events` as COMMAND_FAILED.
CREATE TABLE proof_transitions (
  id             TEXT PRIMARY KEY,
  session_id     UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  step           INTEGER NOT NULL,                -- resulting step (>= 1)
  from_state_id  TEXT NOT NULL,
  to_state_id    TEXT NOT NULL,
  command        TEXT NOT NULL,
  duration_ms    INTEGER,
  generated_goals TEXT[] NOT NULL DEFAULT '{}',
  solved_goals    TEXT[] NOT NULL DEFAULT '{}',
  UNIQUE (session_id, step)
);

-- Compact per-step state: just the hash + goal ids. Enough to detect
-- divergence during replay without storing every goal body 10,000 times.
CREATE TABLE proof_states (
  id            TEXT PRIMARY KEY,
  session_id    UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  step          INTEGER NOT NULL,
  state_hash    TEXT NOT NULL,
  parent_state_id TEXT,
  open_goal_ids TEXT[] NOT NULL,
  -- Full body only when this step is a checkpoint (see `checkpoints`).
  full_state    JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, step)
);

-- Goal ledger: lineage of every goal ever created (open or closed).
CREATE TABLE goals (
  id               TEXT NOT NULL,
  session_id       UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_goal_id   TEXT,
  created_at_step  INTEGER NOT NULL,
  solved_at_step   INTEGER,
  status           TEXT NOT NULL,
  case_name        TEXT,
  target           TEXT NOT NULL,
  local_context    JSONB NOT NULL,
  PRIMARY KEY (session_id, id)
);

CREATE TABLE checkpoints (
  id               TEXT PRIMARY KEY,
  session_id       UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  proof_unit_id    TEXT NOT NULL,
  step             INTEGER NOT NULL,
  state_id         TEXT NOT NULL,
  state_hash       TEXT NOT NULL,
  document_version INTEGER NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, step)
);

CREATE TABLE diagnostics (
  id          BIGSERIAL PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  step        INTEGER,
  severity    TEXT NOT NULL,
  message     TEXT NOT NULL,
  start_line  INTEGER, start_column INTEGER,
  end_line    INTEGER, end_column   INTEGER
);

-- Append-only event log.
CREATE TABLE events (
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq         BIGINT NOT NULL,
  type        TEXT NOT NULL,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload     JSONB NOT NULL,
  PRIMARY KEY (session_id, seq)
);
