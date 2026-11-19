// "Send finished meetings to another app": POSTs each finished meeting as JSON
// to an address you choose (your own notes system, an automation tool, a
// script). Generic on purpose: ClearNote knows nothing about the receiver.
//
// Each delivery is signed when a secret is set:
//   X-ClearNote-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed by the secret>
// A meeting is sent again (event "meeting.updated") when its content changes,
// e.g. after a summary is regenerated or a line is corrected. Failures are
// retried with growing gaps. Only the computer that recorded a meeting sends
// it, so two synced computers don't deliver it twice.

import { createHash, createHmac, randomUUID } from "node:crypto";
import { db, getMeeting } from "./db.js";
import * as config from "./config.js";
import { audioFields } from "./audio.js";
import { exportStatus } from "./save.js";
import { deviceName } from "./sync.js";

db.exec(`
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  meeting_id  TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  hash        TEXT,             -- content last delivered
  sent_at     INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_try_at INTEGER,
  status      INTEGER,          -- last HTTP status
  error       TEXT
);
`);

export const PAYLOAD_VERSION = 1;

/** A new address hasn't received anything yet. */
export function resetDeliveries() {
  db.exec(`DELETE FROM webhook_deliveries`);
}

export function webhookEnabled() {
  return !!config.get("webhookUrl");
}

/** The JSON a receiver gets for one meeting. */
export function meetingPayload(id) {
  const m = getMeeting(id);
  if (!m) return null;
  const a = audioFields(id);
  const saved = exportStatus(id);
  const enhanced = Array.isArray(a.mergedLines) && a.mergedLines.length > 0;
  const transcript = enhanced
    ? a.mergedLines.map((l) => ({ speaker: l.speaker, text: l.text, startMs: l.startMs, endMs: l.endMs ?? null }))
    : m.segments.map((s) => ({ speaker: s.speaker, text: s.text, startMs: s.start_ms, endMs: s.end_ms }));
  const s = m.summary || {};
  return {
    id: m.id,
    title: m.title,
    platform: m.platform_label || m.platform,
    url: m.url || null,
    startedAt: new Date(m.started_at).toISOString(),
    endedAt: m.ended_at ? new Date(m.ended_at).toISOString() : null,
    recordedOn: m.sync_device || deviceName(),
    transcriptSource: enhanced ? "audio+captions" : "captions",
    summary: m.summary
      ? { headline: s.headline || null, tldr: s.tldr || null, keyPoints: s.key_points || [], decisions: s.decisions || [], openQuestions: s.open_questions || [] }
      : null,
    actionItems: m.actionItems.map((x) => ({ text: x.text, owner: x.owner, due: x.due, priority: x.priority, done: !!x.done })),
    people: [
      ...m.spoke.map((p) => ({ name: p.name || p.speaker, email: p.email || null, spoke: true })),
      ...m.silentInvitees.map((p) => ({ name: p.name || null, email: p.email || null, spoke: false })),
    ],
    calendarEvent: m.calendarEvent
      ? { id: m.calendarEvent.id, title: m.calendarEvent.title, link: m.calendarEvent.html_link || null, organizer: m.calendarEvent.organizer || null }
      : null,
    tags: m.tags,
    notes: m.notes || null,
    transcript,
    links: {
      dashboard: `http://localhost:${process.env.PORT || 8787}/#/m/${m.id}`,
      notesDoc: saved.notesUrl,
      audio: Object.fromEntries(Object.entries(saved.audio || {}).filter(([, v]) => v.url).map(([k, v]) => [k, v.url])),
    },
  };
}

const hashOf = (p) => createHash("sha256").update(JSON.stringify(p)).digest("hex").slice(0, 32);

/** POST one body; returns { ok, status, error }. */
async function post(body) {
  const raw = JSON.stringify(body);
  const headers = { "content-type": "application/json", "user-agent": "ClearNote", "x-clearnote-event": body.event, "x-clearnote-delivery": body.deliveryId };
  const secret = config.get("webhookSecret");
  if (secret) headers["x-clearnote-signature"] = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  try {
    const res = await fetch(config.get("webhookUrl"), { method: "POST", headers, body: raw, signal: AbortSignal.timeout(30_000) });
    const text = res.ok ? "" : (await res.text().catch(() => "")).slice(0, 200);
    return { ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status}${text ? `: ${text}` : ""}` };
  } catch (err) {
    const why = err.name === "TimeoutError" ? "no answer within 30 seconds" : err.cause?.code || err.cause?.message || err.message;
    return { ok: false, status: null, error: `Couldn't reach the address (${String(why).slice(0, 160)})` };
  }
}

const envelope = (event, meeting) => ({ event, version: PAYLOAD_VERSION, deliveryId: randomUUID(), sentAt: new Date().toISOString(), meeting });

/** Send one meeting now, whatever was sent before. */
export async function deliver(id, { force = false } = {}) {
  const payload = meetingPayload(id);
  if (!payload) return { ok: false, error: "unknown meeting" };
  const hash = hashOf(payload);
  const prev = db.prepare(`SELECT * FROM webhook_deliveries WHERE meeting_id = ?`).get(id);
  if (!force && prev?.hash === hash) return { ok: true, skipped: true };
  const r = await post(envelope(prev?.hash ? "meeting.updated" : "meeting.finished", payload));
  const attempts = r.ok ? 0 : (prev?.attempts || 0) + 1;
  // Retry after 1, 2, 4 … minutes, at most every 6 hours.
  const nextTry = r.ok ? null : Date.now() + Math.min(6 * 3600e3, 60e3 * 2 ** (attempts - 1));
  db.prepare(
    `INSERT INTO webhook_deliveries (meeting_id, hash, sent_at, attempts, next_try_at, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(meeting_id) DO UPDATE SET hash = excluded.hash, sent_at = excluded.sent_at, attempts = excluded.attempts,
       next_try_at = excluded.next_try_at, status = excluded.status, error = excluded.error`,
  ).run(id, r.ok ? hash : prev?.hash || null, r.ok ? Date.now() : prev?.sent_at || null, attempts, nextTry, r.status, r.error);
  if (r.ok) console.log(`[clearnote] webhook: sent ${id}`);
  else console.warn(`[clearnote] webhook: ${id} failed (${r.error}); retry in ${Math.round((nextTry - Date.now()) / 60e3)} min`);
  return r;
}

/** A sample delivery so the receiver can be checked before a real meeting. */
export async function sendTest() {
  if (!webhookEnabled()) return { ok: false, error: "Add the address first." };
  const latest = db.prepare(`SELECT id FROM meetings WHERE ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`).get();
  const meeting = latest ? meetingPayload(latest.id) : null;
  return post(envelope("test", meeting));
}

/** Meetings that are finished: ended, summarised (or failed), audio settled. */
function finishedSince(since) {
  return db
    .prepare(
      `SELECT id FROM meetings
        WHERE ended_at IS NOT NULL AND ended_at >= ? AND sync_device IS NULL
          AND status NOT IN ('live', 'processing')
          AND COALESCE(audio_status, '') NOT IN ('recording', 'transcribing')
        ORDER BY ended_at`,
    )
    .all(since)
    .map((r) => r.id);
}

let running = false;
export async function webhookRound() {
  if (running || !webhookEnabled()) return;
  running = true;
  try {
    const since = Number(config.get("webhookSince")) || Date.now();
    for (const id of finishedSince(since)) {
      const d = db.prepare(`SELECT next_try_at FROM webhook_deliveries WHERE meeting_id = ?`).get(id);
      if (d?.next_try_at && d.next_try_at > Date.now()) continue;
      await deliver(id);
    }
  } finally {
    running = false;
  }
}

/** Status for the Settings page. */
export function webhookStatus() {
  const r = db
    .prepare(
      `SELECT COUNT(*) FILTER (WHERE hash IS NOT NULL) AS sent, COUNT(*) FILTER (WHERE error IS NOT NULL) AS failing,
              MAX(sent_at) AS lastSentAt FROM webhook_deliveries`,
    )
    .get();
  const lastError = db.prepare(`SELECT error FROM webhook_deliveries WHERE error IS NOT NULL ORDER BY next_try_at DESC LIMIT 1`).get();
  return { enabled: webhookEnabled(), sent: r.sent, failing: r.failing, lastSentAt: r.lastSentAt, lastError: lastError?.error || null };
}

let timer = null;
export function startWebhookLoop(everyMs = 60_000) {
  clearInterval(timer);
  timer = setInterval(() => webhookRound().catch(() => {}), everyMs);
}
