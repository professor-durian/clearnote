// "Send finished captures to another app": POSTs each finished capture as JSON
// to an address you choose (your own notes system, an automation tool, a
// script). Generic on purpose: ClearNote knows nothing about the receiver.
//
// Payload version 2. Every request is signed; there is no unsigned mode:
//   X-ClearNote-Timestamp: <unix seconds>
//   X-ClearNote-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>", keyed by the secret>
// so a receiver can reject old or replayed requests. Retries sign afresh.
//
// Each capture carries a `revision` that rises with every change, so a late
// request never overwrites a newer one. Events: meeting.finished,
// meeting.updated, meeting.deleted, test. Failures are retried with growing
// gaps; a 410 reply means "stop sending this one". The receiver may answer
// { recordId, url, appName } and ClearNote links to that record.
//
// Only the computer that recorded a capture sends it (and its deletion), so
// two synced computers never deliver the same capture twice.

import { createHash, createHmac, randomUUID } from "node:crypto";
import { db, getMeeting, CALL_PLATFORMS } from "./db.js";
import * as config from "./config.js";
import { audioFields } from "./audio.js";
import { isSelf } from "./people.js";
import { deviceName } from "./sync.js";

export const PAYLOAD_VERSION = 2;

// Deliveries outlive the capture (no foreign key), so a deletion can still be
// announced after the row in `meetings` is gone.
db.exec(`
CREATE TABLE IF NOT EXISTS webhook_state (
  meeting_id   TEXT PRIMARY KEY,
  revision     INTEGER NOT NULL DEFAULT 0,  -- last revision assigned
  hash         TEXT,                        -- content of that revision
  delivered    INTEGER NOT NULL DEFAULT 0,  -- revision the receiver has accepted
  sent_at      INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_try_at  INTEGER,
  status       INTEGER,                     -- last HTTP status
  error        TEXT,
  deleted      INTEGER NOT NULL DEFAULT 0,  -- capture deleted; announce it
  stopped      INTEGER NOT NULL DEFAULT 0,  -- receiver answered 410
  remote_id    TEXT,
  remote_url   TEXT,
  remote_name  TEXT
);
DROP TABLE IF EXISTS webhook_deliveries;
`);

const getState = db.prepare(`SELECT * FROM webhook_state WHERE meeting_id = ?`);

/** A new address hasn't received anything yet. */
export function resetDeliveries() {
  db.exec(`DELETE FROM webhook_state`);
}

export function webhookEnabled() {
  return !!(config.get("webhookUrl") && config.get("webhookSecret"));
}

export const kindOf = (m) => (CALL_PLATFORMS.includes(m.platform) ? "call" : m.platform === "youtube" ? "youtube" : "web");

/** Which kinds of capture go to the receiver (Settings: calls / YouTube / websites). */
function kindWanted(kind) {
  return String(config.get("webhookKinds") || "call").split(",").map((s) => s.trim()).includes(kind);
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

/** The capture as the receiver sees it (without revision, which is assigned per change). */
export function meetingPayload(id) {
  const m = getMeeting(id);
  if (!m) return null;
  const a = audioFields(id);
  const exp = db.prepare(`SELECT notes_doc_id, audio_json FROM meeting_exports WHERE meeting_id = ?`).get(id) || {};
  const audio = exp.audio_json ? JSON.parse(exp.audio_json) : {};
  const account = db.prepare(`SELECT email FROM google_account WHERE id = 1`).get()?.email || null;
  const ev = m.calendarEvent;
  const organizer = ev?.organizer?.toLowerCase() || null;
  const enhanced = Array.isArray(a.mergedLines) && a.mergedLines.length > 0;
  const transcript = enhanced
    ? a.mergedLines.map((l) => ({ speaker: l.speaker, text: l.text, startMs: l.startMs, endMs: l.endMs ?? null }))
    : m.segments.map((s) => ({ speaker: s.speaker, text: s.text, startMs: s.start_ms, endMs: s.end_ms }));
  const s = m.summary || {};
  const person = (name, email, spoke) => ({
    name: name || null,
    email: email || null,
    spoke,
    self: isSelf(name, email),
    organizer: !!(email && organizer && email.toLowerCase() === organizer),
  });
  return {
    id: m.id,
    kind: kindOf(m),
    platform: m.platform_label || m.platform,
    platformKey: m.platform,
    title: m.title,
    url: m.url || null,
    startedAt: iso(m.started_at),
    endedAt: iso(m.ended_at),
    recordedOn: m.sync_device || deviceName(),
    transcriptSource: enhanced ? "audio+captions" : "captions",
    summary: m.summary
      ? { headline: s.headline || null, tldr: s.tldr || null, keyPoints: s.key_points || [], decisions: s.decisions || [], openQuestions: s.open_questions || [] }
      : null,
    actionItems: m.actionItems.map((x) => ({ text: x.text, owner: x.owner, due: x.due, priority: x.priority, done: !!x.done })),
    people: [
      ...m.spoke.map((p) => person(p.name || p.speaker, p.email, true)),
      ...m.silentInvitees.map((p) => person(p.name, p.email, false)),
    ],
    calendarEvent: ev
      ? {
          id: ev.id,
          seriesId: ev.recurring_event_id || null,
          calendarId: ev.calendar_id || null,
          account,
          title: ev.title,
          scheduledStart: iso(ev.start_at),
          scheduledEnd: iso(ev.end_at),
          organizer: ev.organizer || null,
          link: ev.html_link || null,
        }
      : null,
    tags: m.tags,
    notes: m.notes || null,
    transcript,
    files: {
      notesDoc: exp.notes_doc_id ? { id: exp.notes_doc_id, url: `https://docs.google.com/document/d/${exp.notes_doc_id}/edit` } : null,
      audio: Object.fromEntries(
        Object.entries(audio)
          .filter(([, v]) => v.driveId)
          .map(([part, v]) => [part, { id: v.driveId, url: `https://drive.google.com/file/d/${v.driveId}/view` }]),
      ),
    },
  };
}

const hashOf = (p) => createHash("sha256").update(JSON.stringify(p)).digest("hex").slice(0, 32);

/** Sign and POST one body; returns { ok, gone, status, error, reply }. */
async function post(body) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", config.get("webhookSecret")).update(`${ts}.${raw}`).digest("hex");
  const headers = {
    "content-type": "application/json",
    "user-agent": "ClearNote",
    "x-clearnote-event": body.event,
    "x-clearnote-delivery": body.deliveryId,
    "x-clearnote-timestamp": ts,
    "x-clearnote-signature": `sha256=${sig}`,
  };
  try {
    const res = await fetch(config.get("webhookUrl"), { method: "POST", headers, body: raw, signal: AbortSignal.timeout(30_000) });
    const text = await res.text().catch(() => "");
    let reply = null;
    try {
      reply = text ? JSON.parse(text) : null;
    } catch {
      /* a plain-text answer is fine */
    }
    return {
      ok: res.ok,
      gone: res.status === 410,
      status: res.status,
      error: res.ok ? null : `HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ""}`,
      reply,
    };
  } catch (err) {
    const why = err.name === "TimeoutError" ? "no answer within 30 seconds" : err.cause?.code || err.cause?.message || err.message;
    return { ok: false, status: null, error: `Couldn't reach the address (${String(why).slice(0, 160)})` };
  }
}

const envelope = (event, meeting) => ({ event, version: PAYLOAD_VERSION, deliveryId: randomUUID(), sentAt: new Date().toISOString(), meeting });

const save = db.prepare(
  `INSERT INTO webhook_state (meeting_id, revision, hash, delivered, sent_at, attempts, next_try_at, status, error, deleted, stopped, remote_id, remote_url, remote_name)
   VALUES (@meeting_id, @revision, @hash, @delivered, @sent_at, @attempts, @next_try_at, @status, @error, @deleted, @stopped, @remote_id, @remote_url, @remote_name)
   ON CONFLICT(meeting_id) DO UPDATE SET revision = excluded.revision, hash = excluded.hash, delivered = excluded.delivered,
     sent_at = excluded.sent_at, attempts = excluded.attempts, next_try_at = excluded.next_try_at, status = excluded.status,
     error = excluded.error, deleted = excluded.deleted, stopped = excluded.stopped, remote_id = excluded.remote_id,
     remote_url = excluded.remote_url, remote_name = excluded.remote_name`,
);

const blank = (id) => ({
  meeting_id: id, revision: 0, hash: null, delivered: 0, sent_at: null, attempts: 0, next_try_at: null,
  status: null, error: null, deleted: 0, stopped: 0, remote_id: null, remote_url: null, remote_name: null,
});

/** Record the outcome of a send. */
function settle(st, r) {
  const attempts = r.ok ? 0 : st.attempts + 1;
  Object.assign(st, {
    attempts,
    status: r.status,
    error: r.ok || r.gone ? null : r.error,
    // Retry after 1, 2, 4 … minutes, at most every 6 hours.
    next_try_at: r.ok || r.gone ? null : Date.now() + Math.min(6 * 3600e3, 60e3 * 2 ** (attempts - 1)),
  });
  if (r.gone) st.stopped = 1;
  if (r.ok) {
    st.delivered = st.revision;
    st.sent_at = Date.now();
    if (r.reply && (r.reply.recordId || r.reply.url)) {
      st.remote_id = r.reply.recordId != null ? String(r.reply.recordId) : st.remote_id;
      st.remote_url = typeof r.reply.url === "string" && /^https?:\/\//.test(r.reply.url) ? r.reply.url : st.remote_url;
      st.remote_name = typeof r.reply.appName === "string" ? r.reply.appName.slice(0, 40) : st.remote_name;
    }
  }
  save.run(st);
}

/** Send a capture if it changed since the receiver last accepted it (or always, with force). */
export async function deliver(id, { force = false } = {}) {
  if (!webhookEnabled()) return { ok: false, error: "Add the address and a signing secret first." };
  const payload = meetingPayload(id);
  if (!payload) return { ok: false, error: "unknown capture" };
  const st = getState.get(id) || blank(id);
  if (st.stopped && !force) return { ok: true, skipped: true };
  const hash = hashOf(payload);
  if (hash !== st.hash) {
    st.revision += 1;
    st.hash = hash;
  } else if (st.delivered === st.revision && !force) {
    return { ok: true, skipped: true };
  }
  if (force) st.stopped = 0;
  const event = st.delivered > 0 ? "meeting.updated" : "meeting.finished";
  const r = await post(envelope(event, { ...payload, revision: st.revision }));
  settle(st, r);
  if (r.ok) console.log(`[clearnote] webhook: sent ${id} (revision ${st.revision})`);
  else if (r.gone) console.log(`[clearnote] webhook: receiver no longer wants ${id}; stopped`);
  else console.warn(`[clearnote] webhook: ${id} failed (${r.error})`);
  return { ok: r.ok, status: r.status, error: r.error };
}

/** A capture was deleted here, or by another computer through sync. */
export function captureDeleted(id) {
  const st = getState.get(id);
  // Only announce what this computer delivered; the receiver never saw the rest.
  if (!st || !st.delivered || st.stopped) return void db.prepare(`DELETE FROM webhook_state WHERE meeting_id = ?`).run(id);
  st.deleted = 1;
  st.revision += 1;
  st.attempts = 0;
  st.next_try_at = null;
  save.run(st);
  sendDeletion(st).catch(() => {});
}

async function sendDeletion(st) {
  if (!webhookEnabled()) return;
  const r = await post(envelope("meeting.deleted", { id: st.meeting_id, revision: st.revision }));
  if (r.ok || r.gone) {
    db.prepare(`DELETE FROM webhook_state WHERE meeting_id = ?`).run(st.meeting_id);
    console.log(`[clearnote] webhook: sent deletion of ${st.meeting_id}`);
  } else settle(st, r);
}

/** A sample delivery so the receiver can be checked before a real capture. */
export async function sendTest() {
  if (!webhookEnabled()) return { ok: false, error: "Add the address and a signing secret first." };
  const latest = db.prepare(`SELECT id FROM meetings WHERE ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`).get();
  const meeting = latest ? { ...meetingPayload(latest.id), revision: 0 } : null;
  const r = await post(envelope("test", meeting));
  return { ok: r.ok, status: r.status, error: r.error };
}

/** Finished captures: ended, summarised (or failed), audio settled, recorded here. */
function finishedSince(since) {
  return db
    .prepare(
      `SELECT id, platform FROM meetings
        WHERE ended_at IS NOT NULL AND ended_at >= ? AND (sync_device IS NULL OR ?)
          AND status NOT IN ('live', 'processing')
          AND COALESCE(audio_status, '') NOT IN ('recording', 'transcribing')
        ORDER BY ended_at`,
    )
    .all(since, config.get("webhookSendOthers") ? 1 : 0);
}

let running = false;
export async function webhookRound() {
  if (running || !webhookEnabled()) return;
  running = true;
  try {
    const due = (st) => !st?.next_try_at || st.next_try_at <= Date.now();
    for (const st of db.prepare(`SELECT * FROM webhook_state WHERE deleted = 1`).all()) {
      if (due(st)) await sendDeletion(st);
    }
    const since = Number(config.get("webhookSince")) || Date.now();
    for (const m of finishedSince(since)) {
      if (!kindWanted(kindOf(m))) continue;
      const st = getState.get(m.id);
      if (st?.stopped || !due(st)) continue;
      await deliver(m.id);
    }
  } finally {
    running = false;
  }
}

/** Where the receiver filed a capture, if it said. */
export function linkedRecord(id) {
  const st = getState.get(id);
  return st?.remote_url ? { url: st.remote_url, name: st.remote_name || null } : null;
}

/** Status for the Settings page. */
export function webhookStatus() {
  const r = db
    .prepare(
      `SELECT COUNT(*) FILTER (WHERE delivered > 0) AS sent, COUNT(*) FILTER (WHERE error IS NOT NULL) AS failing,
              MAX(sent_at) AS lastSentAt FROM webhook_state`,
    )
    .get();
  const lastError = db.prepare(`SELECT error FROM webhook_state WHERE error IS NOT NULL ORDER BY next_try_at DESC LIMIT 1`).get();
  return {
    enabled: webhookEnabled(),
    address: !!config.get("webhookUrl"),
    sent: r.sent,
    failing: r.failing,
    lastSentAt: r.lastSentAt,
    lastError: lastError?.error || null,
  };
}

let timer = null;
export function startWebhookLoop(everyMs = 60_000) {
  clearInterval(timer);
  timer = setInterval(() => webhookRound().catch(() => {}), everyMs);
}
