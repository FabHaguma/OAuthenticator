BEGIN IMMEDIATE;

-- Preserve the original admin hash and legacy approval tables. Old tokens are not used.
CREATE TABLE IF NOT EXISTS admin (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  password_hash TEXT NOT NULL
);

CREATE TABLE gateway_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip_address TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX gateway_sessions_expiry ON gateway_sessions(expires_at);
CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_address TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX login_attempts_time ON login_attempts(attempted_at);
CREATE INDEX login_attempts_ip ON login_attempts(ip_address, attempted_at);

PRAGMA user_version = 1;
COMMIT;
