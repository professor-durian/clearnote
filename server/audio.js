// Optional audio layer: stores the recorded tracks, transcribes them locally
// and merges the result with the captions. Off unless the extension records.
//
// Tracks: "tab" (the meeting's sound: everyone else) and "mic" (you). The
// extension streams each as webm/opus chunks while the call runs, so a crash
// loses at most the last few seconds.

import express from "express";
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, resolveMeetingId, getSegments } from "./db.js";
import { merge } from "./merge.js";
import { transcribeFile, transcriptionStatus } from "./transcribe.js";
import { MODEL_MB, brewPath, runSetup, setupState } from "./setup.js";
import * as config from "./config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const AUDIO_DIR = process.env.CLEARNOTE_AUDIO_DIR || path.join(here, "audio");
const TRACKS = new Set(["tab", "mic"]);

db.exec(`
CREATE TABLE IF NOT EXISTS audio_tracks (
  meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  track       TEXT NOT NULL,
  file        TEXT NOT NULL,
  offset_ms   INTEGER NOT NULL,
  end_ms      INTEGER,
  bytes       INTEGER NOT NULL DEFAULT 0,
  next_seq    INTEGER NOT NULL DEFAULT 0,
  finished    INTEGER NOT NULL DEFAULT 0,
  words_json  TEXT,
  PRIMARY KEY (meeting_id, track)
);
`);
{
  const cols = db.prepare(`PRAGMA table_info(meetings)`).all().map((c) => c.name);
  if (!cols.includes("record_type")) db.exec(`ALTER TABLE meetings ADD COLUMN record_type TEXT NOT NULL DEFAULT 'captions'`);
  if (!cols.includes("audio_status")) db.exec(`ALTER TABLE meetings ADD COLUMN audio_status TEXT`);
  if (!cols.includes("audio_error")) db.exec(`ALTER TABLE meetings ADD COLUMN audio_error TEXT`);
  if (!cols.includes("merged_json")) db.exec(`ALTER TABLE meetings ADD COLUMN merged_json TEXT`);
}

const getTrack = db.prepare(`SELECT * FROM audio_tracks WHERE meeting_id = ? AND track = ?`);
const tracksOf = db.prepare(`SELECT * FROM audio_tracks WHERE meeting_id = ? ORDER BY track`);
const setStatus = db.prepare(`UPDATE meetings SET audio_status = ?, audio_error = ? WHERE id = ?`);

function meetingDir(meetingId) {
  const dir = path.join(AUDIO_DIR, meetingId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Fields the dashboard needs, added to getMeeting()'s result. */
export function audioFields(meetingId) {
  const m = db.prepare(`SELECT record_type, audio_status, audio_error, merged_json FROM meetings WHERE id = ?`).get(meetingId);
  const tracks = tracksOf.all(meetingId).map((t) => ({
    track: t.track,
    bytes: t.bytes,
    offsetMs: t.offset_ms,
    endMs: t.end_ms,
    finished: !!t.finished,
    url: `/api/meetings/${meetingId}/audio/${t.track}`,
  }));
  return {
    recordType: m?.record_type || "captions",
    audioStatus: m?.audio_status || null,
    audioError: m?.audio_error || null,
    mergedLines: m?.merged_json ? JSON.parse(m.merged_json) : null,
    audioTracks: tracks,
  };
}

const running = new Set();

// Called when a meeting's audio has been transcribed and merged (or failed),
// so whatever saves meetings elsewhere can run. Set by the server.
let onDone = () => {};
export function onAudioDone(fn) {
  onDone = fn;
}

/**
 * Transcribe any untranscribed tracks, then merge with the captions. Runs once
 * the meeting has ended and every started track is finished. Safe to call again.
 */
export async function processAudio(meetingId, { force = false, manual = false, myName = "" } = {}) {
  myName = myName || config.get("displayName");
  if (running.has(meetingId)) return;
  const meeting = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(meetingId);
  const tracks = tracksOf.all(meetingId);
  if (!meeting || !tracks.length) return;
  if (!meeting.ended_at && !force) return;
  if (!force && tracks.some((t) => !t.finished)) return;

  // YouTube's own transcript is already accurate: keep the audio as a file only.
  const hasCaptions = db.prepare(`SELECT 1 FROM segments WHERE meeting_id = ? LIMIT 1`).get(meetingId);
  if (meeting.platform === "youtube" && hasCaptions) {
    setStatus.run("done", null, meetingId);
    onDone(meetingId);
    return;
  }

  // Improving a caption transcript with audio is optional. Off: the audio is
  // kept as files and the captions stay the transcript. Audio-only recordings
  // (no captions at all) are always transcribed when this Mac can.
  if (hasCaptions && !manual && config.get("enhanceTranscripts") !== "local") {
    setStatus.run("done", null, meetingId);
    onDone(meetingId);
    return;
  }

  const ready = transcriptionStatus();
  if (!ready.ready) {
    setStatus.run("waiting", "Transcription isn't set up on this Mac. Set it up in Settings › Recording, then use Re-transcribe.", meetingId);
    return;
  }

  running.add(meetingId);
  try {
    setStatus.run("transcribing", null, meetingId);
    const words = {};
    for (const t of tracks) {
      if (t.bytes === 0) continue;
      let w = !force && t.words_json ? JSON.parse(t.words_json) : null;
      if (!w) {
        const started = Date.now();
        w = await transcribeFile(t.file);
        db.prepare(`UPDATE audio_tracks SET words_json = ? WHERE meeting_id = ? AND track = ?`).run(
          JSON.stringify(w),
          meetingId,
          t.track,
        );
        console.log(`[clearnote] transcribed ${t.track} for ${meetingId}: ${w.length} words in ${Math.round((Date.now() - started) / 1000)}s`);
      }
      // whisper times are file-relative; the file starts offset_ms into the meeting.
      words[t.track] = w.map((x) => ({ ...x, startMs: x.startMs + t.offset_ms, endMs: x.endMs + t.offset_ms }));
    }

    const captions = getSegments(meetingId).map((s) => ({
      speaker: s.speaker,
      text: s.text,
      startMs: s.start_ms,
      endMs: s.end_ms,
    }));
    const audioStartMs = Math.min(...tracks.map((t) => t.offset_ms));
    const ends = tracks.map((t) => t.end_ms).filter((x) => x != null);
    const result = merge({
      captions,
      tabWords: words.tab || null,
      micWords: words.mic || null,
      audioStartMs,
      audioEndMs: ends.length ? Math.max(...ends) : Infinity,
      myName,
    });
    db.prepare(`UPDATE meetings SET merged_json = ?, record_type = ?, audio_status = 'done', audio_error = NULL WHERE id = ?`).run(
      JSON.stringify(result.lines),
      result.recordType,
      meetingId,
    );
    console.log(`[clearnote] merged ${meetingId}: ${result.lines.length} lines, ${result.recordType}, caption lag ${Math.round(result.lagMs)}ms`);
  } catch (err) {
    console.error(`[clearnote] audio processing failed for ${meetingId}:`, err);
    setStatus.run("failed", String(err.message || err).slice(0, 500), meetingId);
  } finally {
    running.delete(meetingId);
    onDone(meetingId);
  }
}

export function registerAudioRoutes(app, { requireToken, wrap }) {
  // Chunks arrive in order; seq lets a retried chunk be ignored rather than
  // appended twice.
  app.post(
    "/api/sessions/:id/audio/:track/chunk",
    requireToken,
    express.raw({ type: () => true, limit: "50mb" }),
    wrap((req, res) => {
      const meetingId = resolveMeetingId(req.params.id);
      if (!meetingId) return res.status(404).json({ error: "unknown session" });
      const { track } = req.params;
      if (!TRACKS.has(track)) return res.status(400).json({ error: "track must be tab or mic" });
      const seq = Number(req.query.seq);
      if (!Number.isInteger(seq) || seq < 0) return res.status(400).json({ error: "seq required" });

      let row = getTrack.get(meetingId, track);
      if (seq === 0 && (!row || row.next_seq !== 0)) {
        // A new recording of this track replaces any earlier one.
        const file = path.join(meetingDir(meetingId), `${track}.webm`);
        writeFileSync(file, Buffer.alloc(0));
        db.prepare(
          `INSERT INTO audio_tracks (meeting_id, track, file, offset_ms) VALUES (?, ?, ?, ?)
           ON CONFLICT(meeting_id, track) DO UPDATE SET file = excluded.file, offset_ms = excluded.offset_ms,
             end_ms = NULL, bytes = 0, next_seq = 0, finished = 0, words_json = NULL`,
        ).run(meetingId, track, file, Math.max(0, Number(req.query.offsetMs) || 0));
        setStatus.run("recording", null, meetingId);
        row = getTrack.get(meetingId, track);
      }
      if (!row) return res.status(409).json({ error: "first chunk must have seq=0" });
      if (seq < row.next_seq) return res.json({ ok: true, duplicate: true });
      if (seq > row.next_seq) return res.status(409).json({ error: `expected seq ${row.next_seq}` });

      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      appendFileSync(row.file, body);
      db.prepare(`UPDATE audio_tracks SET bytes = bytes + ?, next_seq = next_seq + 1 WHERE meeting_id = ? AND track = ?`).run(
        body.length,
        meetingId,
        track,
      );
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/sessions/:id/audio/:track/finish",
    requireToken,
    wrap((req, res) => {
      const meetingId = resolveMeetingId(req.params.id);
      if (!meetingId) return res.status(404).json({ error: "unknown session" });
      const endMs = Number(req.body?.endMs);
      db.prepare(`UPDATE audio_tracks SET finished = 1, end_ms = ? WHERE meeting_id = ? AND track = ?`).run(
        Number.isFinite(endMs) ? endMs : null,
        meetingId,
        req.params.track,
      );
      res.json({ ok: true });
      processAudio(meetingId, { myName: req.body?.myName || "" }).catch(() => {});
    }),
  );

  app.get(
    "/api/meetings/:id/audio/:track",
    wrap((req, res) => {
      const row = getTrack.get(req.params.id, req.params.track);
      if (!row || !existsSync(row.file) || statSync(row.file).size === 0) return res.sendStatus(404);
      res.type("audio/webm").sendFile(row.file);
    }),
  );

  app.post(
    "/api/meetings/:id/retranscribe",
    requireToken,
    wrap((req, res) => {
      if (!tracksOf.all(req.params.id).length) return res.status(404).json({ error: "no audio for this meeting" });
      res.json({ ok: true });
      processAudio(req.params.id, { force: true, manual: true, myName: req.body?.myName || "" }).catch(() => {});
    }),
  );

  app.get("/api/audio/status", (_req, res) =>
    res.json({ ...transcriptionStatus(), setup: setupState(), homebrew: !!brewPath(), downloadMb: MODEL_MB }),
  );
  app.post("/api/audio/setup", requireToken, (req, res) => {
    const origin = req.get("origin");
    if (origin && origin !== `http://${req.get("host")}` && !origin.startsWith("chrome-extension://")) return res.sendStatus(403);
    runSetup(resumePending);
    res.json({ ok: true });
  });
}

export function deleteAudio(meetingId) {
  rmSync(path.join(AUDIO_DIR, meetingId), { recursive: true, force: true });
}

/** On boot: finish anything a crash or restart interrupted. */
export function resumePending() {
  const rows = db
    .prepare(`SELECT id FROM meetings WHERE ended_at IS NOT NULL AND audio_status IN ('recording','transcribing','waiting')`)
    .all();
  for (const r of rows) processAudio(r.id, { force: true }).catch(() => {});
}
