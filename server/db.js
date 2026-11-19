import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileParticipants } from "./matching.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.CLEARNOTE_DB || path.join(here, "clearnote.db");

export const db = new Database(file);

// Calls have attendees; everything else captured (YouTube, websites) doesn't.
export const CALL_PLATFORMS = ["google_meet", "zoom", "teams"];
export const isCall = (m) => CALL_PLATFORMS.includes(m?.platform);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS meetings (
  id             TEXT PRIMARY KEY,
  meeting_key    TEXT NOT NULL,
  platform       TEXT NOT NULL,
  platform_label TEXT,
  title          TEXT,
  url            TEXT,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  status         TEXT NOT NULL DEFAULT 'live',
  summary_json   TEXT,
  processed_at   INTEGER,
  notes          TEXT
);
CREATE INDEX IF NOT EXISTS meetings_key   ON meetings(meeting_key, started_at DESC);
CREATE INDEX IF NOT EXISTS meetings_start ON meetings(started_at DESC);

CREATE TABLE IF NOT EXISTS segments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  speaker    TEXT NOT NULL,
  text       TEXT NOT NULL,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  UNIQUE(meeting_id, seq)
);
CREATE INDEX IF NOT EXISTS segments_meeting ON segments(meeting_id, seq);

CREATE TABLE IF NOT EXISTS action_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  owner      TEXT,
  due        TEXT,
  priority   TEXT,
  quote      TEXT,
  done       INTEGER NOT NULL DEFAULT 0,
  source     TEXT NOT NULL DEFAULT 'ai',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS action_meeting ON action_items(meeting_id);

CREATE TABLE IF NOT EXISTS insights (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  speaker    TEXT,
  quote      TEXT,
  note       TEXT,
  at_ms      INTEGER
);
CREATE INDEX IF NOT EXISTS insights_meeting ON insights(meeting_id);

CREATE TABLE IF NOT EXISTS tags (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  PRIMARY KEY (meeting_id, tag)
);

CREATE TABLE IF NOT EXISTS participants (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  PRIMARY KEY (meeting_id, name)
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id            TEXT PRIMARY KEY,        -- Google's event id
  calendar_id   TEXT NOT NULL,
  title         TEXT,
  description   TEXT,
  location      TEXT,
  start_at      INTEGER NOT NULL,
  end_at        INTEGER NOT NULL,
  organizer     TEXT,
  conference_codes TEXT,                 -- JSON array of meeting codes found on the event
  html_link     TEXT,
  status        TEXT,
  synced_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_window ON calendar_events(start_at, end_at);

CREATE TABLE IF NOT EXISTS event_attendees (
  event_id     TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  name         TEXT,
  organizer    INTEGER NOT NULL DEFAULT 0,
  response     TEXT,
  PRIMARY KEY (event_id, email)
);

CREATE TABLE IF NOT EXISTS google_account (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  email         TEXT,
  access_token  TEXT,
  refresh_token TEXT,
  expires_at    INTEGER,
  scope         TEXT,
  connected_at  INTEGER,
  last_sync_at  INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
  text, speaker, meeting_id UNINDEXED, content='segments', content_rowid='id'
);
`);

// Keep the full-text index in step with the segments table.
db.exec(`
CREATE TRIGGER IF NOT EXISTS segments_ai AFTER INSERT ON segments BEGIN
  INSERT INTO segments_fts(rowid, text, speaker, meeting_id)
  VALUES (new.id, new.text, new.speaker, new.meeting_id);
END;
CREATE TRIGGER IF NOT EXISTS segments_ad AFTER DELETE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text, speaker, meeting_id)
  VALUES ('delete', old.id, old.text, old.speaker, old.meeting_id);
END;
CREATE TRIGGER IF NOT EXISTS segments_au AFTER UPDATE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text, speaker, meeting_id)
  VALUES ('delete', old.id, old.text, old.speaker, old.meeting_id);
  INSERT INTO segments_fts(rowid, text, speaker, meeting_id)
  VALUES (new.id, new.text, new.speaker, new.meeting_id);
END;
`);

// Columns added after the first release. SQLite has no "ADD COLUMN IF NOT
// EXISTS", so check before adding and leave existing databases working.
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumn("meetings", "calendar_event_id", "TEXT");
addColumn("calendar_events", "recurring_event_id", "TEXT"); // the series a repeating event belongs to
addColumn("meetings", "match_confidence", "TEXT");
addColumn("meetings", "matched_by", "TEXT");
// Set when the title came from the platform rather than from a person, so a
// calendar match may improve it without overwriting a title you typed.
addColumn("meetings", "title_is_generic", "INTEGER NOT NULL DEFAULT 1");

const SESSION_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * One meeting room is reused week after week, so the room key alone cannot
 * identify a sitting. Reuse an existing row only while it is still live and
 * recent; otherwise start a new one.
 */
export function openMeeting({ meetingKey, platform, platformLabel, title, url, startedAt }) {
  const existing = db
    .prepare(
      `SELECT * FROM meetings
        WHERE meeting_key = ? AND ended_at IS NULL AND started_at > ?
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(meetingKey, startedAt - SESSION_WINDOW_MS);

  if (existing) {
    if (title && title !== existing.title) {
      db.prepare(`UPDATE meetings SET title = ? WHERE id = ?`).run(title, existing.id);
    }
    return existing.id;
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO meetings
       (id, meeting_key, platform, platform_label, title, url, started_at, status, title_is_generic)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'live', ?)`,
  ).run(
    id,
    meetingKey,
    platform,
    platformLabel ?? platform,
    title ?? "Untitled meeting",
    url ?? null,
    startedAt,
    isGenericTitle(title) ? 1 : 0,
  );
  return id;
}

/**
 * A title the platform made up, rather than one that came from a calendar
 * event or a person. Only these get replaced by a calendar match.
 */
export function isGenericTitle(title) {
  const t = (title || "").trim();
  if (!t) return true;
  return (
    /^(untitled meeting|meet|zoom meeting|teams meeting|google meet|microsoft teams)$/i.test(t) ||
    /^meet\s+[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(t) ||
    // A bare room code, which is what Meet puts in the tab title.
    /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(t) ||
    /^\d{9,12}$/.test(t) ||
    /^(zoom|teams)\s+meeting$/i.test(t)
  );
}

/** Accepts a meeting id or a room key, so a queued batch still finds its home. */
export function resolveMeetingId(idOrKey) {
  const byId = db.prepare(`SELECT id FROM meetings WHERE id = ?`).get(idOrKey);
  if (byId) return byId.id;
  const byKey = db
    .prepare(`SELECT id FROM meetings WHERE meeting_key = ? ORDER BY started_at DESC LIMIT 1`)
    .get(idOrKey);
  return byKey?.id ?? null;
}

const insertSegment = db.prepare(
  `INSERT INTO segments (meeting_id, seq, speaker, text, start_ms, end_ms)
   VALUES (@meeting_id, @seq, @speaker, @text, @start_ms, @end_ms)
   ON CONFLICT(meeting_id, seq) DO UPDATE SET
     speaker = excluded.speaker, text = excluded.text,
     start_ms = excluded.start_ms, end_ms = excluded.end_ms`,
);
const insertParticipant = db.prepare(
  `INSERT OR IGNORE INTO participants (meeting_id, name) VALUES (?, ?)`,
);

export const addSegments = db.transaction((meetingId, segments) => {
  for (const s of segments) {
    insertSegment.run({
      meeting_id: meetingId,
      seq: s.seq,
      speaker: s.speaker || "Unknown speaker",
      text: s.text,
      start_ms: s.startMs ?? 0,
      end_ms: s.endMs ?? s.startMs ?? 0,
    });
    if (s.speaker && s.speaker !== "Unknown speaker") insertParticipant.run(meetingId, s.speaker);
  }
});

export function closeMeeting(meetingId, { endedAt, speakers = [] }) {
  db.prepare(`UPDATE meetings SET ended_at = ?, status = 'processing' WHERE id = ?`).run(
    endedAt,
    meetingId,
  );
  for (const name of speakers) {
    if (name && name !== "Unknown speaker") insertParticipant.run(meetingId, name);
  }
}

// ---------------------------------------------------------------- calendar

/** Events that could plausibly be this meeting, widened for early/late joins. */
export function candidateEvents(meeting, windowMs = 2 * 60 * 60 * 1000) {
  const from = meeting.started_at - windowMs;
  const to = (meeting.ended_at || meeting.started_at) + windowMs;
  return db
    .prepare(
      `SELECT * FROM calendar_events
        WHERE end_at > ? AND start_at < ? AND status != 'cancelled'
        ORDER BY start_at`,
    )
    .all(from, to)
    .map(hydrateEvent);
}

function hydrateEvent(row) {
  if (!row) return null;
  return {
    ...row,
    conference_codes: JSON.parse(row.conference_codes || "[]"),
    attendees: db
      .prepare(`SELECT * FROM event_attendees WHERE event_id = ? ORDER BY organizer DESC, name, email`)
      .all(row.id),
  };
}

export function getEvent(eventId) {
  return hydrateEvent(db.prepare(`SELECT * FROM calendar_events WHERE id = ?`).get(eventId));
}

export function linkMeetingToEvent(meetingId, eventId, { confidence, matchedBy, title }) {
  db.prepare(
    `UPDATE meetings SET calendar_event_id = ?, match_confidence = ?, matched_by = ? WHERE id = ?`,
  ).run(eventId, confidence ?? null, matchedBy ?? null, meetingId);
  if (title) {
    db.prepare(`UPDATE meetings SET title = ?, title_is_generic = 0 WHERE id = ?`).run(title, meetingId);
  }
}

export function upcomingEvents(limit = 10) {
  return db
    .prepare(
      `SELECT e.*, m.id AS meeting_id FROM calendar_events e
        LEFT JOIN meetings m ON m.calendar_event_id = e.id
        WHERE e.end_at > ? AND e.status != 'cancelled'
        ORDER BY e.start_at LIMIT ?`,
    )
    .all(Date.now() - 60 * 60 * 1000, limit)
    .map((row) => ({ ...hydrateEvent(row), meeting_id: row.meeting_id }));
}

export function getSegments(meetingId) {
  return db.prepare(`SELECT * FROM segments WHERE meeting_id = ? ORDER BY start_ms, seq`).all(meetingId);
}

export function getMeeting(meetingId) {
  const m = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(meetingId);
  if (!m) return null;
  const speakers = db
    .prepare(`SELECT name FROM participants WHERE meeting_id = ? ORDER BY name`)
    .all(meetingId)
    .map((r) => r.name);
  const event = m.calendar_event_id ? getEvent(m.calendar_event_id) : null;
  const { spoke, silent } = event
    ? reconcileParticipants(speakers, event.attendees)
    : { spoke: speakers.map((s) => ({ speaker: s, email: null, name: s })), silent: [] };

  return {
    ...m,
    summary: m.summary_json ? JSON.parse(m.summary_json) : null,
    calendarEvent: event,
    spoke,
    // Invited but never heard from — the thing a transcript alone cannot tell you.
    silentInvitees: silent,
    participants: db
      .prepare(`SELECT name FROM participants WHERE meeting_id = ? ORDER BY name`)
      .all(meetingId)
      .map((r) => r.name),
    tags: db
      .prepare(`SELECT tag FROM tags WHERE meeting_id = ? ORDER BY tag`)
      .all(meetingId)
      .map((r) => r.tag),
    actionItems: db
      .prepare(`SELECT * FROM action_items WHERE meeting_id = ? ORDER BY done, id`)
      .all(meetingId),
    insights: db.prepare(`SELECT * FROM insights WHERE meeting_id = ? ORDER BY id`).all(meetingId),
    segments: getSegments(meetingId),
  };
}

export function listMeetings({ limit = 60, tag, q } = {}) {
  let rows;
  if (q) {
    rows = db
      .prepare(
        `SELECT m.* FROM meetings m
          WHERE m.id IN (SELECT meeting_id FROM segments_fts WHERE segments_fts MATCH ?)
             OR m.title LIKE ?
          ORDER BY m.started_at DESC LIMIT ?`,
      )
      .all(ftsQuery(q), `%${q}%`, limit);
  } else if (tag) {
    rows = db
      .prepare(
        `SELECT m.* FROM meetings m JOIN tags t ON t.meeting_id = m.id
          WHERE t.tag = ? ORDER BY m.started_at DESC LIMIT ?`,
      )
      .all(tag, limit);
  } else {
    rows = db.prepare(`SELECT * FROM meetings ORDER BY started_at DESC LIMIT ?`).all(limit);
  }

  return rows.map((m) => ({
    ...m,
    summary: m.summary_json ? JSON.parse(m.summary_json) : null,
    summary_json: undefined,
    segmentCount: db
      .prepare(`SELECT COUNT(*) n FROM segments WHERE meeting_id = ?`)
      .get(m.id).n,
    openActions: db
      .prepare(`SELECT COUNT(*) n FROM action_items WHERE meeting_id = ? AND done = 0`)
      .get(m.id).n,
    inviteeCount: m.calendar_event_id
      ? db.prepare(`SELECT COUNT(*) n FROM event_attendees WHERE event_id = ?`).get(m.calendar_event_id).n
      : 0,
    participants: db
      .prepare(`SELECT name FROM participants WHERE meeting_id = ? ORDER BY name`)
      .all(m.id)
      .map((r) => r.name),
    tags: db
      .prepare(`SELECT tag FROM tags WHERE meeting_id = ? ORDER BY tag`)
      .all(m.id)
      .map((r) => r.tag),
  }));
}

/** FTS5 rejects bare punctuation, so quote each term and OR them together. */
function ftsQuery(q) {
  const terms = String(q)
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, ""))
    .filter(Boolean)
    .map((t) => `"${t}"*`);
  return terms.length ? terms.join(" OR ") : '""';
}

export function searchSegments(q, limit = 80) {
  return db
    .prepare(
      `SELECT s.*, m.title, m.started_at, m.platform FROM segments_fts f
        JOIN segments s ON s.id = f.rowid
        JOIN meetings m ON m.id = s.meeting_id
        WHERE segments_fts MATCH ?
        ORDER BY m.started_at DESC LIMIT ?`,
    )
    .all(ftsQuery(q), limit);
}

export const saveAnalysis = db.transaction((meetingId, analysis) => {
  db.prepare(
    `UPDATE meetings SET summary_json = ?, status = 'ready', processed_at = ? WHERE id = ?`,
  ).run(JSON.stringify(analysis.summary), Date.now(), meetingId);

  // Replace AI output but keep anything a human added or ticked off.
  db.prepare(`DELETE FROM action_items WHERE meeting_id = ? AND source = 'ai' AND done = 0`).run(
    meetingId,
  );
  db.prepare(`DELETE FROM insights WHERE meeting_id = ?`).run(meetingId);
  db.prepare(`DELETE FROM tags WHERE meeting_id = ?`).run(meetingId);

  const ai = db.prepare(
    `INSERT INTO action_items (meeting_id, text, owner, due, priority, quote, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ai', ?)`,
  );
  for (const a of analysis.actionItems ?? []) {
    ai.run(meetingId, a.text, a.owner ?? null, a.due ?? null, a.priority ?? null, a.quote ?? null, Date.now());
  }

  const ins = db.prepare(
    `INSERT INTO insights (meeting_id, kind, speaker, quote, note) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const i of analysis.insights ?? []) {
    ins.run(meetingId, i.kind, i.speaker ?? null, i.quote ?? null, i.note ?? null);
  }

  const tg = db.prepare(`INSERT OR IGNORE INTO tags (meeting_id, tag) VALUES (?, ?)`);
  for (const t of analysis.tags ?? []) tg.run(meetingId, t);
});

/**
 * Captured fine, but no summary was produced — no API key, say. The transcript
 * is intact, so this is not a failure and must not be shown as one.
 */
export function markUnsummarized(meetingId, notice) {
  db.prepare(
    `UPDATE meetings SET status = 'captured', summary_json = ?, processed_at = ? WHERE id = ?`,
  ).run(JSON.stringify({ notice }), Date.now(), meetingId);
}

export function markFailed(meetingId, message) {
  db.prepare(
    `UPDATE meetings SET status = 'failed', summary_json = ?, processed_at = ? WHERE id = ?`,
  ).run(JSON.stringify({ error: message }), Date.now(), meetingId);
}

export function allTags() {
  return db
    .prepare(`SELECT tag, COUNT(*) n FROM tags GROUP BY tag ORDER BY n DESC, tag`)
    .all();
}

export function openActionItems() {
  return db
    .prepare(
      `SELECT a.*, m.title, m.started_at FROM action_items a
        JOIN meetings m ON m.id = a.meeting_id
        WHERE a.done = 0 ORDER BY m.started_at DESC`,
    )
    .all();
}
