// Schema changes, applied in order exactly once. Never edit a released migration; add a new one.
export const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    email         TEXT,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'builder', 'operator', 'viewer')),
    source        TEXT NOT NULL CHECK (source IN ('local', 'ldap')),
    password_hash TEXT,
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    client     TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE flows (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    latest_version  INTEGER NOT NULL DEFAULT 0,
    minutes_saved   REAL NOT NULL DEFAULT 0,
    created_by      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    archived        INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE flow_versions (
    flow_id       TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
    version       INTEGER NOT NULL,
    definition    TEXT NOT NULL,
    notes         TEXT NOT NULL DEFAULT '',
    published_by  TEXT,
    published_at  TEXT NOT NULL,
    PRIMARY KEY (flow_id, version)
  );

  CREATE TABLE robots (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    machine       TEXT NOT NULL DEFAULT '',
    pool          TEXT NOT NULL DEFAULT 'default',
    token_hash    TEXT NOT NULL UNIQUE,
    capabilities  TEXT NOT NULL DEFAULT '[]',
    version       TEXT NOT NULL DEFAULT '',
    enabled       INTEGER NOT NULL DEFAULT 1,
    enrolled_at   TEXT NOT NULL,
    last_seen_at  TEXT
  );

  CREATE TABLE enrollment_keys (
    key_hash    TEXT PRIMARY KEY,
    pool        TEXT NOT NULL DEFAULT 'default',
    created_by  TEXT,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used_at     TEXT,
    robot_id    TEXT
  );

  CREATE TABLE queues (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description  TEXT NOT NULL DEFAULT '',
    flow_id      TEXT REFERENCES flows(id) ON DELETE SET NULL,
    max_retries  INTEGER NOT NULL DEFAULT 2,
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE queue_items (
    id           TEXT PRIMARY KEY,
    queue_id     TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    reference    TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL CHECK (status IN ('new', 'in_progress', 'done', 'failed')),
    priority     INTEGER NOT NULL DEFAULT 0,
    data         TEXT NOT NULL DEFAULT '{}',
    result       TEXT,
    error        TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    job_id       TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX queue_items_status ON queue_items(queue_id, status, priority DESC, created_at);

  CREATE TABLE jobs (
    id            TEXT PRIMARY KEY,
    flow_id       TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
    version       INTEGER NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    trigger       TEXT NOT NULL CHECK (trigger IN ('manual', 'schedule', 'webhook', 'queue', 'hotkey', 'api')),
    trigger_ref   TEXT,
    triggered_by  TEXT,
    inputs        TEXT NOT NULL DEFAULT '{}',
    pool          TEXT NOT NULL DEFAULT 'default',
    robot_id      TEXT,
    priority      INTEGER NOT NULL DEFAULT 0,
    timeout_s     INTEGER NOT NULL DEFAULT 3600,
    queue_item_id TEXT,
    queued_at     TEXT NOT NULL,
    started_at    TEXT,
    finished_at   TEXT,
    duration_ms   INTEGER,
    outputs       TEXT,
    error         TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX jobs_status ON jobs(status, priority DESC, queued_at);
  CREATE INDEX jobs_flow ON jobs(flow_id, queued_at DESC);
  CREATE INDEX jobs_queued_at ON jobs(queued_at DESC);

  CREATE TABLE job_events (
    job_id  TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    seq     INTEGER NOT NULL,
    ts      REAL NOT NULL,
    kind    TEXT NOT NULL,
    step_id TEXT,
    data    TEXT NOT NULL,
    PRIMARY KEY (job_id, seq)
  );

  CREATE TABLE artifacts (
    id         TEXT PRIMARY KEY,
    job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    step_id    TEXT,
    kind       TEXT NOT NULL,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX artifacts_job ON artifacts(job_id);

  CREATE TABLE schedules (
    id          TEXT PRIMARY KEY,
    flow_id     TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    cron        TEXT NOT NULL,
    timezone    TEXT NOT NULL,
    inputs      TEXT NOT NULL DEFAULT '{}',
    pool        TEXT NOT NULL DEFAULT 'default',
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_by  TEXT,
    created_at  TEXT NOT NULL,
    last_run_at TEXT
  );

  CREATE TABLE webhooks (
    id             TEXT PRIMARY KEY,
    flow_id        TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    token_hash     TEXT NOT NULL UNIQUE,
    token_hint     TEXT NOT NULL,
    enabled        INTEGER NOT NULL DEFAULT 1,
    created_by     TEXT,
    created_at     TEXT NOT NULL,
    last_called_at TEXT
  );

  CREATE TABLE credentials (
    name         TEXT PRIMARY KEY COLLATE NOCASE,
    username     TEXT NOT NULL DEFAULT '',
    secret       TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    updated_by   TEXT,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    user_id    TEXT,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    target     TEXT,
    details    TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX audit_ts ON audit(ts DESC);
  `,
  /* 2: AI self-repair */ `
  ALTER TABLE flows ADD COLUMN ai_repair INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE jobs ADD COLUMN repair_calls INTEGER NOT NULL DEFAULT 0;

  -- Fixes the AI assistant made during robot runs, waiting for a builder to approve them.
  CREATE TABLE repair_suggestions (
    id            TEXT PRIMARY KEY,
    flow_id       TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
    base_version  INTEGER NOT NULL,
    job_id        TEXT NOT NULL UNIQUE,
    patches       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed')),
    created_at    TEXT NOT NULL,
    decided_by    TEXT,
    decided_at    TEXT,
    version       INTEGER
  );
  CREATE INDEX repair_suggestions_flow ON repair_suggestions(flow_id, status);
  `,
];
