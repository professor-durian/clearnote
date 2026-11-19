// People you meet with, built from what each meeting already knows: speaker
// names from the captions and invitees (with email) from the matched calendar
// event. No AI involved.
//
// A person is identified by email when there is one, otherwise by name. Every
// name a person has appeared under is kept as an alias, so "Ben" in captions and
// "Benjamin Ito" on the invite can be merged into one person and stay merged.

import { db, getMeeting, isCall } from "./db.js";
import * as config from "./config.js";

db.exec(`
CREATE TABLE IF NOT EXISTS people (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT UNIQUE,
  hidden     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS person_aliases (
  alias     TEXT PRIMARY KEY,                -- normalised name
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS meeting_people (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  spoke      INTEGER NOT NULL DEFAULT 0,
  invited    INTEGER NOT NULL DEFAULT 0,
  response   TEXT,
  PRIMARY KEY (meeting_id, person_id)
);
CREATE INDEX IF NOT EXISTS meeting_people_person ON meeting_people(person_id);
`);

export const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}@.' -]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const byEmail = db.prepare(`SELECT * FROM people WHERE email = ?`);
const byAlias = db.prepare(`SELECT p.* FROM person_aliases a JOIN people p ON p.id = a.person_id WHERE a.alias = ?`);
const addAlias = db.prepare(`INSERT OR IGNORE INTO person_aliases (alias, person_id) VALUES (?, ?)`);
const insertPerson = db.prepare(`INSERT INTO people (name, email, created_at) VALUES (?, ?, ?)`);

/** You, so you don't appear in your own People list. */
export function isSelf(name, email) {
  const n = norm(name);
  if (n === "you" || n === "me") return true;
  const mine = norm(config.get("displayName"));
  if (mine && n === mine) return true;
  if (!email) return false;
  const e = email.toLowerCase();
  const acct = db.prepare(`SELECT email FROM google_account WHERE id = 1`).get()?.email;
  if (acct && e === acct.toLowerCase()) return true;
  return String(config.get("otherEmails") || "")
    .split(/[\s,;]+/)
    .some((x) => x && x.toLowerCase() === e);
}

/** Find or create the person for a name and (optional) email. */
export function resolvePerson(name, email) {
  const e = email ? String(email).toLowerCase().trim() : null;
  const n = norm(name);
  let p = e ? byEmail.get(e) : null;
  if (!p && n) {
    const viaAlias = byAlias.get(n);
    // A name alone only joins a person who has no email, or the same email.
    if (viaAlias && (!e || !viaAlias.email)) p = viaAlias;
    if (p && e && !p.email) {
      db.prepare(`UPDATE people SET email = ? WHERE id = ?`).run(e, p.id);
      p.email = e;
    }
  }
  if (!p) {
    const id = insertPerson.run(String(name || e || "Unknown").trim(), e, Date.now()).lastInsertRowid;
    p = { id: Number(id), name, email: e };
  }
  if (n) addAlias.run(n, p.id);
  return p;
}

/** Recompute who was in one meeting. Safe to repeat. */
export function syncMeetingPeople(meetingId) {
  const m = getMeeting(meetingId);
  if (!m) return;
  // People are the attendees of calls. A YouTube speaker isn't someone you met.
  if (!isCall(m)) {
    db.prepare(`DELETE FROM meeting_people WHERE meeting_id = ?`).run(meetingId);
    return;
  }
  const rows = new Map();
  const put = (person, patch) => {
    const cur = rows.get(person.id) || { spoke: 0, invited: 0, response: null };
    rows.set(person.id, { ...cur, ...patch });
  };
  for (const s of m.spoke || []) {
    if (!s.speaker || /^unknown/i.test(s.speaker) || isSelf(s.speaker, s.email)) continue;
    const p = resolvePerson(s.email ? s.name || s.speaker : s.speaker, s.email);
    if (s.email && s.speaker) addAlias.run(norm(s.speaker), p.id);
    put(p, { spoke: 1, invited: s.email ? 1 : 0 });
  }
  for (const a of m.silentInvitees || []) {
    if (!a.email || isSelf(a.name, a.email)) continue;
    const p = resolvePerson(a.name || a.email.split("@")[0], a.email);
    put(p, { invited: 1, response: a.response || null });
  }
  if (m.calendarEvent) {
    for (const a of m.calendarEvent.attendees || []) {
      const p = a.email ? byEmail.get(a.email.toLowerCase()) : null;
      if (p && rows.has(p.id)) rows.get(p.id).response = a.response || rows.get(p.id).response;
    }
  }
  db.transaction(() => {
    db.prepare(`DELETE FROM meeting_people WHERE meeting_id = ?`).run(meetingId);
    const ins = db.prepare(
      `INSERT INTO meeting_people (meeting_id, person_id, spoke, invited, response) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [pid, r] of rows) ins.run(meetingId, pid, r.spoke, r.invited, r.response);
  })();
}

export function syncAllPeople() {
  for (const { id } of db.prepare(`SELECT id FROM meetings WHERE ended_at IS NOT NULL`).all()) {
    try {
      syncMeetingPeople(id);
    } catch (err) {
      console.warn(`[clearnote] people sync skipped ${id}: ${err.message}`);
    }
  }
}

export function listPeople({ q = "", sort = "meetings", includeHidden = false } = {}) {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.email, p.hidden,
              COUNT(mp.meeting_id) meetings, SUM(mp.spoke) spoke,
              MAX(m.started_at) last_met, MIN(m.started_at) first_met
         FROM people p
         JOIN meeting_people mp ON mp.person_id = p.id
         JOIN meetings m ON m.id = mp.meeting_id
        WHERE (? OR p.hidden = 0) AND m.platform IN ('google_meet', 'zoom', 'teams')
        GROUP BY p.id`,
    )
    .all(includeHidden ? 1 : 0);
  const needle = norm(q);
  const filtered = needle
    ? rows.filter((r) => norm(r.name).includes(needle) || (r.email || "").includes(needle))
    : rows;
  const order = {
    meetings: (a, b) => b.meetings - a.meetings || b.last_met - a.last_met,
    recent: (a, b) => b.last_met - a.last_met,
    name: (a, b) => a.name.localeCompare(b.name),
  }[sort] || ((a, b) => b.meetings - a.meetings);
  return filtered.sort(order);
}

export function getPerson(id) {
  const p = db.prepare(`SELECT * FROM people WHERE id = ?`).get(id);
  if (!p) return null;
  const aliases = db.prepare(`SELECT alias FROM person_aliases WHERE person_id = ?`).all(id).map((r) => r.alias);
  const meetings = db
    .prepare(
      `SELECT m.id, m.title, m.started_at, m.ended_at, m.platform_label, m.platform, m.summary_json,
              mp.spoke, mp.invited, mp.response
         FROM meeting_people mp JOIN meetings m ON m.id = mp.meeting_id
        WHERE mp.person_id = ? ORDER BY m.started_at DESC`,
    )
    .all(id)
    .map(({ summary_json, ...r }) => ({ ...r, headline: summary_json ? JSON.parse(summary_json).headline || null : null }));
  // Open next steps owned by this person, under any name they've appeared as.
  const names = new Set([norm(p.name), ...aliases]);
  const actions = db
    .prepare(
      `SELECT a.*, m.title FROM action_items a JOIN meetings m ON m.id = a.meeting_id
        WHERE a.done = 0 AND a.owner IS NOT NULL ORDER BY a.created_at DESC`,
    )
    .all()
    .filter((a) => names.has(norm(a.owner)) || names.has(norm(a.owner).split(" ")[0]));
  return { ...p, aliases, meetings, actions };
}

export function updatePerson(id, { name, email, hidden }) {
  if (name !== undefined && String(name).trim()) {
    db.prepare(`UPDATE people SET name = ? WHERE id = ?`).run(String(name).trim(), id);
    addAlias.run(norm(name), id);
  }
  if (email !== undefined) db.prepare(`UPDATE people SET email = ? WHERE id = ?`).run(email ? String(email).toLowerCase().trim() : null, id);
  if (hidden !== undefined) db.prepare(`UPDATE people SET hidden = ? WHERE id = ?`).run(hidden ? 1 : 0, id);
}

/** Fold `fromId` into `intoId`: meetings, names and email move across. */
export function mergePeople(fromId, intoId) {
  if (fromId === intoId) return;
  const from = db.prepare(`SELECT * FROM people WHERE id = ?`).get(fromId);
  const into = db.prepare(`SELECT * FROM people WHERE id = ?`).get(intoId);
  if (!from || !into) throw new Error("unknown person");
  db.transaction(() => {
    for (const r of db.prepare(`SELECT * FROM meeting_people WHERE person_id = ?`).all(fromId)) {
      const cur = db.prepare(`SELECT * FROM meeting_people WHERE meeting_id = ? AND person_id = ?`).get(r.meeting_id, intoId);
      if (cur) {
        db.prepare(`UPDATE meeting_people SET spoke = MAX(spoke, ?), invited = MAX(invited, ?), response = COALESCE(response, ?) WHERE meeting_id = ? AND person_id = ?`)
          .run(r.spoke, r.invited, r.response, r.meeting_id, intoId);
      } else {
        db.prepare(`INSERT INTO meeting_people (meeting_id, person_id, spoke, invited, response) VALUES (?, ?, ?, ?, ?)`)
          .run(r.meeting_id, intoId, r.spoke, r.invited, r.response);
      }
    }
    db.prepare(`UPDATE person_aliases SET person_id = ? WHERE person_id = ?`).run(intoId, fromId);
    addAlias.run(norm(from.name), intoId);
    db.prepare(`DELETE FROM people WHERE id = ?`).run(fromId);
    if (!into.email && from.email) db.prepare(`UPDATE people SET email = ? WHERE id = ?`).run(from.email, intoId);
  })();
}

/** Meeting ids attended by every one of these people. */
export function meetingsWithPeople(personIds) {
  const ids = personIds.map(Number).filter(Boolean);
  if (!ids.length) return null;
  const rows = db
    .prepare(
      `SELECT meeting_id FROM meeting_people WHERE person_id IN (${ids.map(() => "?").join(",")})
        GROUP BY meeting_id HAVING COUNT(DISTINCT person_id) = ?`,
    )
    .all(...ids, ids.length);
  return new Set(rows.map((r) => r.meeting_id));
}

/** People per meeting, for the meetings list. */
export function peopleForMeetings(meetingIds) {
  if (!meetingIds.length) return {};
  const rows = db
    .prepare(
      `SELECT mp.meeting_id, p.id, p.name FROM meeting_people mp JOIN people p ON p.id = mp.person_id
        WHERE p.hidden = 0 AND mp.meeting_id IN (${meetingIds.map(() => "?").join(",")})
        ORDER BY mp.spoke DESC, p.name`,
    )
    .all(...meetingIds);
  const out = {};
  for (const r of rows) (out[r.meeting_id] ||= []).push({ id: r.id, name: r.name });
  return out;
}
