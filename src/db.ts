import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import crypto from "node:crypto";

// pbkdf2 password hashing (portable across bun versions)
const PBKDF2_ITERS = 120_000;
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERS, 32, "sha256").toString("hex");
  return `pbkdf2:${PBKDF2_ITERS}:${salt}:${hash}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, iters, salt, hash] = (stored ?? "").split(":");
  if (scheme !== "pbkdf2" || !iters || !salt || !hash) return false;
  const test = crypto.pbkdf2Sync(password, salt, Number(iters), 32, "sha256").toString("hex");
  return test.length === hash.length && crypto.timingSafeEqual(Buffer.from(test), Buffer.from(hash));
}

// db location is configurable for container deployments (persistent volume)
const DB_PATH = process.env.BOOKMARKER_DB ?? "bookmarker.db";
if (DB_PATH.includes("/")) mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  address TEXT NOT NULL,
  description TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  check_type TEXT NOT NULL DEFAULT 'none' CHECK (check_type IN ('none','http','tcp')),
  is_indicator INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  reachable INTEGER
);
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  time INTEGER NOT NULL,
  reachable INTEGER NOT NULL,
  latency_ms INTEGER,
  status_code INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_checks_bookmark_time ON checks (bookmark_id, time);
CREATE TABLE IF NOT EXISTS checks_daily (
  bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  up REAL NOT NULL,
  cnt INTEGER NOT NULL,
  lat REAL,
  PRIMARY KEY (bookmark_id, day)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// migrations for existing databases: bookmarks.status_code/error are legacy
// columns from earlier versions (live in the checks table now); leave any
// existing databases untouched, fresh ones never get them.
export const q = {
  groups: db.query("SELECT * FROM groups ORDER BY sort, id"),
  groupById: db.query("SELECT * FROM groups WHERE id = ?"),
  insertGroup: db.query("INSERT INTO groups (name, sort) VALUES (?, ?)"),
  updateGroup: db.query("UPDATE groups SET name = ?, sort = ? WHERE id = ?"),
  deleteGroup: db.query("DELETE FROM groups WHERE id = ?"),
  bookmarks: db.query("SELECT * FROM bookmarks ORDER BY sort, id"),
  bookmarksByGroup: db.query("SELECT * FROM bookmarks WHERE group_id = ? ORDER BY sort, id"),
  bookmarkById: db.query("SELECT * FROM bookmarks WHERE id = ?"),
  insertBookmark: db.query(
    "INSERT INTO bookmarks (group_id, title, address, description, sort, check_type, is_indicator, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  updateBookmark: db.query(
    "UPDATE bookmarks SET group_id = ?, title = ?, address = ?, description = ?, sort = ?, check_type = ?, is_indicator = ?, enabled = ? WHERE id = ?"
  ),
  moveBookmark: db.query("UPDATE bookmarks SET group_id = ?, sort = ? WHERE id = ?"),
  setReachable: db.query("UPDATE bookmarks SET reachable = ? WHERE id = ?"),
  deleteBookmark: db.query("DELETE FROM bookmarks WHERE id = ?"),
  insertCheck: db.query("INSERT INTO checks (bookmark_id, time, reachable, latency_ms, status_code, error) VALUES (?, ?, ?, ?, ?, ?)"),
  checksRange: db.query("SELECT time, reachable, latency_ms, status_code, error FROM checks WHERE bookmark_id = ? AND time >= ? AND time <= ? ORDER BY time"),
  lastCheckBefore: db.query("SELECT reachable FROM checks WHERE bookmark_id = ? AND time < ? ORDER BY time DESC LIMIT 1"),
  lastCheck: db.query("SELECT time, reachable FROM checks WHERE bookmark_id = ? ORDER BY time DESC LIMIT 1"),
  lastDailyBefore: db.query("SELECT up FROM checks_daily WHERE bookmark_id = ? AND day < ? ORDER BY day DESC LIMIT 1"),
  checksErrors: db.query("SELECT time, latency_ms, status_code, error FROM checks WHERE bookmark_id = ? AND time >= ? AND reachable = 0 ORDER BY time DESC LIMIT 100"),
  upsertDaily: db.query("INSERT OR REPLACE INTO checks_daily (bookmark_id, day, up, cnt, lat) SELECT ?, ?, ?, ?, ?"),
  checksDailyRange: db.query("SELECT day, up, cnt, lat FROM checks_daily WHERE bookmark_id = ? AND day >= ? AND day <= ? ORDER BY day"),
  deleteChecksBefore: db.query("DELETE FROM checks WHERE time < ?"),
  deleteDailyBefore: db.query("DELETE FROM checks_daily WHERE day < ?"),
  setting: db.query("SELECT value FROM settings WHERE key = ?"),
  setSetting: db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ),
};
