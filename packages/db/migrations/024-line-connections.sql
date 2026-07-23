CREATE TABLE IF NOT EXISTS line_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  worker_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
