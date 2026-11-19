PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  budget REAL,
  gift_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'drawn')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  drawn_at TEXT
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  is_host INTEGER NOT NULL DEFAULT 0 CHECK (is_host IN (0, 1)),
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(room_code, name_key)
);

CREATE INDEX IF NOT EXISTS idx_members_room ON members(room_code, joined_at, id);

CREATE TABLE IF NOT EXISTS assignments (
  room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  giver_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  receiver_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY(room_code, giver_id),
  CHECK (giver_id <> receiver_id)
);

CREATE TRIGGER IF NOT EXISTS block_late_members
BEFORE INSERT ON members
WHEN (SELECT status FROM rooms WHERE code = NEW.room_code) <> 'open'
BEGIN
  SELECT RAISE(ABORT, 'ROOM_CLOSED');
END;
