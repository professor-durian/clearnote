// Saving finished meetings outside ClearNote, each part optional:
//   - meeting notes: one Google Doc per meeting, laid out like Gemini's notes,
//     with a Notes tab and a Transcript tab, in its own Drive folder
//   - audio: mixed, call and mic MP3s, to a Drive folder or a folder on this Mac
// The same Doc and files are updated when the meeting changes later (a fixed
// transcript line, a new summary, a re-transcription), never duplicated.

import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { db, getMeeting } from "./db.js";
import { audioFields, AUDIO_DIR } from "./audio.js";
import * as config from "./config.js";
import * as drive from "./drive.js";
import { connectionStatus } from "./google.js";
import { FFMPEG_BIN } from "./transcribe.js";

const run = promisify(execFile);

db.exec(`
CREATE TABLE IF NOT EXISTS meeting_exports (
  meeting_id   TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  notes_doc_id TEXT,
  audio_sig    TEXT,
  audio_json   TEXT,
  saved_at     INTEGER,
  error        TEXT
);
`);

const RECORD_TYPE = {
  merged: "Audio and captions",
  partial: "Audio for part of the call, captions for the rest",
  captions: "Captions only",
};

// ------------------------------------------------------------------ naming

function pad(n) {
  return String(n).padStart(2, "0");
}
function localParts(ms) {
  const d = new Date(ms);
  return { y: d.getFullYear(), mo: pad(d.getMonth() + 1), d: pad(d.getDate()), h: pad(d.getHours()), mi: pad(d.getMinutes()) };
}
const clean = (s) => String(s || "Untitled meeting").replace(/[\/\\:*?"<>|]+/g, "-").trim().slice(0, 120);

/**
 * Fill a name template. Tags: {title} {date} {time} {year} {month} {day}
 * {platform} {people} {part}. Unknown tags are left as written.
 */
export function fillName(template, m, extra = {}) {
  const t = localParts(m.started_at);
  const people = (m.spoke || m.participants || [])
    .map((p) => (typeof p === "string" ? p : p.name || p.speaker))
    .filter(Boolean);
  const tags = {
    title: m.title || "Untitled meeting",
    date: `${t.y}-${t.mo}-${t.d}`,
    time: `${t.h}.${t.mi}`,
    year: String(t.y),
    month: t.mo,
    day: t.d,
    platform: m.platform_label || m.platform || "",
    people: people.length > 3 ? `${people.slice(0, 3).join(", ")} +${people.length - 3}` : people.join(", "),
    ...extra,
  };
  const out = String(template || "").replace(/\{(\w+)\}/g, (all, k) => (k in tags ? tags[k] : all));
  return clean(out.replace(/\s+/g, " ")) || "Untitled meeting";
}

export const PART_KEYS = { mixed: "partMixed", call: "partCall", mic: "partMic" };

export function docName(m, template = config.get("notesDocName")) {
  return fillName(template, m);
}
export function audioName(m, part, template = config.get("audioFileName")) {
  const label = config.get(PART_KEYS[part] || "") || part;
  return `${fillName(template, m, { part: label })}.mp3`;
}

export function clock(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

// ---------------------------------------------------------------- doc content

const AUDIO_LABELS = { mixed: "Mixed audio (everyone)", call: "Call audio (everyone else)", mic: "Your microphone" };

/**
 * The two tabs of a meeting's notes Doc. Pure: takes the meeting as getMeeting()
 * returns it plus audioFields(), and where the audio was saved.
 */
export function notesTabs(m, audio = {}, myName = "") {
  const P = (text, extra = {}) => ({ text, ...extra });
  // Captions call you "You"; use your name from Settings when there is one.
  const who = (n) => (myName && /^(you|me)$/i.test(String(n || "").trim()) ? myName : n);
  const notes = [];
  const when = new Date(m.started_at);
  const minutes = m.ended_at ? Math.max(1, Math.round((m.ended_at - m.started_at) / 60000)) : null;

  notes.push(P(m.title || "Untitled meeting", { style: "HEADING_1" }));
  notes.push(
    P(
      [
        when.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }),
        when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
        minutes ? `${minutes} min` : null,
        m.platform_label || m.platform,
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  );
  const spoke = [...new Set((m.spoke || []).map((s) => who(s.name || s.speaker)).filter(Boolean))];
  if (spoke.length) notes.push(P(`Attendees: ${spoke.join(", ")}`, { bold: [0, 10] }));
  const silent = (m.silentInvitees || []).map((s) => s.name || s.email).filter(Boolean);
  if (silent.length) notes.push(P(`Invited, not heard from: ${silent.join(", ")}`, { bold: [0, 24] }));

  const s = m.summary;
  if (s && !s.notice && !s.error && (s.tldr || s.headline)) {
    notes.push(P("Summary", { style: "HEADING_2" }));
    if (s.headline) notes.push(P(s.headline, { bold: [0, s.headline.length] }));
    if (s.tldr) notes.push(P(s.tldr));
    if (s.key_points?.length) {
      notes.push(P("Details", { style: "HEADING_2" }));
      for (const k of s.key_points) notes.push(P(`• ${k}`));
    }
    if (s.decisions?.length) {
      notes.push(P("Decisions", { style: "HEADING_2" }));
      for (const d of s.decisions) notes.push(P(`• ${d}`));
    }
  } else {
    notes.push(P("Summary", { style: "HEADING_2" }));
    notes.push(P(s?.notice || s?.error || "No summary yet. The full transcript is in the Transcript tab."));
  }

  const items = (m.actionItems || []).filter((a) => !a.done);
  if (items.length) {
    notes.push(P("Suggested next steps", { style: "HEADING_2" }));
    for (const a of items) {
      const who = a.owner ? `${a.owner}: ` : "";
      notes.push(P(`☐ ${who}${a.text}${a.due ? ` (due ${a.due})` : ""}`, a.owner ? { bold: [2, 2 + who.length - 1] } : {}));
    }
  }
  if (s?.open_questions?.length) {
    notes.push(P("Open questions", { style: "HEADING_2" }));
    for (const q of s.open_questions) notes.push(P(`• ${q}`));
  }
  if (s?.next_meeting) notes.push(P(`Next meeting: ${s.next_meeting}`, { bold: [0, 13] }));

  const saved = Object.entries(audio).filter(([, v]) => v);
  if (saved.length) {
    notes.push(P("Recordings", { style: "HEADING_2" }));
    for (const [part, where] of saved) {
      if (where.driveId) notes.push(P(AUDIO_LABELS[part] || part, { link: drive.fileUrl(where.driveId) }));
      else if (where.path) notes.push(P(`${AUDIO_LABELS[part] || part}: ${where.path}`));
    }
  }
  notes.push(P(`Transcript source: ${RECORD_TYPE[m.recordType] || RECORD_TYPE.captions}. Made by ClearNote.`));

  const transcript = [P(config.get("tabTranscriptName") || "Transcript", { style: "HEADING_1" })];
  const lines = m.mergedLines?.length
    ? m.mergedLines.map((l) => ({ speaker: l.speaker, text: l.text, startMs: l.startMs, inferred: l.inferred }))
    : (m.segments || []).map((sg) => ({ speaker: sg.speaker, text: sg.text, startMs: sg.start_ms }));
  if (!lines.length) transcript.push(P("Nothing was captured."));
  for (const l of lines) {
    const head = `[${clock(l.startMs)}] ${who(l.speaker)}${l.inferred ? " (likely)" : ""}: `;
    transcript.push(P(`${head}${l.text}`, { bold: [0, head.length - 1] }));
  }

  return [
    { title: config.get("tabNotesName") || "Notes", paragraphs: notes },
    { title: config.get("tabTranscriptName") || "Transcript", paragraphs: transcript },
  ];
}

// -------------------------------------------------------------------- audio

/**
 * Turn the recorded tracks into mixed / call / mic MP3s, lined up so that one
 * point in time is at the same position in all three files.
 */
export async function exportMp3s(meetingId, tracks) {
  const byTrack = Object.fromEntries(tracks.filter((t) => t.bytes > 0).map((t) => [t.track, t]));
  if (!byTrack.tab && !byTrack.mic) return {};
  const dir = path.join(AUDIO_DIR, meetingId);
  const start = Math.min(...Object.values(byTrack).map((t) => t.offsetMs));
  const delay = (t) => Math.max(0, Math.round(t.offsetMs - start));
  const out = {};
  const enc = ["-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "64k"];

  const single = async (t, part) => {
    const file = path.join(dir, `${part}.mp3`);
    await run(FFMPEG_BIN, ["-y", "-loglevel", "error", "-i", path.join(dir, `${t.track}.webm`), "-af", `adelay=${delay(t)}:all=1`, ...enc, file]);
    out[part] = file;
  };
  if (byTrack.tab) await single(byTrack.tab, "call");
  if (byTrack.mic) await single(byTrack.mic, "mic");

  if (byTrack.tab && byTrack.mic) {
    const file = path.join(dir, "mixed.mp3");
    await run(FFMPEG_BIN, [
      "-y", "-loglevel", "error",
      "-i", path.join(dir, "tab.webm"),
      "-i", path.join(dir, "mic.webm"),
      "-filter_complex",
      `[0]adelay=${delay(byTrack.tab)}:all=1[a];[1]adelay=${delay(byTrack.mic)}:all=1[b];[a][b]amix=inputs=2:duration=longest:normalize=0`,
      ...enc, file,
    ]);
    out.mixed = file;
  } else {
    out.mixed = out.call || out.mic;
  }
  return out;
}

// --------------------------------------------------------------------- save

const row = (id) => db.prepare(`SELECT * FROM meeting_exports WHERE meeting_id = ?`).get(id) || {};
function store(id, patch) {
  const cur = row(id);
  const next = { ...cur, ...patch, meeting_id: id };
  db.prepare(
    `INSERT INTO meeting_exports (meeting_id, notes_doc_id, audio_sig, audio_json, saved_at, error)
     VALUES (@meeting_id, @notes_doc_id, @audio_sig, @audio_json, @saved_at, @error)
     ON CONFLICT(meeting_id) DO UPDATE SET notes_doc_id = @notes_doc_id, audio_sig = @audio_sig,
       audio_json = @audio_json, saved_at = @saved_at, error = @error`,
  ).run({ notes_doc_id: null, audio_sig: null, audio_json: null, saved_at: null, error: null, ...next });
}

export function exportStatus(meetingId) {
  const r = row(meetingId);
  const audio = r.audio_json ? JSON.parse(r.audio_json) : {};
  return {
    notesUrl: r.notes_doc_id ? drive.docUrl(r.notes_doc_id) : null,
    audio: Object.fromEntries(
      Object.entries(audio).map(([k, v]) => [k, v.driveId ? { url: drive.fileUrl(v.driveId) } : { path: v.path }]),
    ),
    savedAt: r.saved_at || null,
    error: r.error || null,
  };
}

const running = new Map();

/** Save a meeting's notes and audio wherever Settings says. Safe to repeat. */
export async function saveMeeting(meetingId) {
  if (running.has(meetingId)) return running.get(meetingId);
  const job = (async () => {
    const meeting = getMeeting(meetingId);
    if (!meeting || !meeting.ended_at) return;
    const m = { ...meeting, ...audioFields(meetingId) };
    const wantNotes = config.get("saveNotes");
    const audioTo = config.get("saveAudio");
    if (!wantNotes && audioTo === "off") return;
    if (["recording", "transcribing"].includes(m.audioStatus)) return; // saved again when it finishes

    const needsGoogle = wantNotes || audioTo === "drive";
    if (needsGoogle && !connectionStatus().drive) {
      store(meetingId, { error: "Connect Google (with Drive access) in Settings to save to Drive." });
      return;
    }

    try {
      const r = row(meetingId);
      let audio = r.audio_json ? JSON.parse(r.audio_json) : {};
      const finished = m.audioTracks.filter((t) => t.finished && t.bytes > 0);
      const sig = finished.length ? `${audioTo}|${finished.map((t) => `${t.track}:${t.bytes}:${t.offsetMs}`).join(",")}` : null;

      if (audioTo !== "off" && sig && sig !== r.audio_sig) {
        const mp3s = await exportMp3s(meetingId, finished);
        const next = {};
        if (audioTo === "drive") {
          const folderId = await drive.ensureFolder("audio");
          for (const [part, file] of Object.entries(mp3s)) {
            if (part === "mixed" && file === mp3s.call && !mp3s.mic) continue; // one track: no separate mix
            next[part] = {
              driveId: await drive.uploadFile(file, {
                name: audioName(m, part),
                mimeType: "audio/mpeg",
                folderId,
                existingId: audio[part]?.driveId,
              }),
            };
          }
        } else {
          const dir = (config.get("audioLocalPath") || "~/ClearNote Audio").replace(/^~(?=$|\/)/, os.homedir());
          mkdirSync(dir, { recursive: true });
          for (const [part, file] of Object.entries(mp3s)) {
            if (part === "mixed" && file === mp3s.call && !mp3s.mic) continue;
            const dest = path.join(dir, audioName(m, part));
            copyFileSync(file, dest);
            next[part] = { path: dest };
          }
        }
        audio = next;
        store(meetingId, { audio_sig: sig, audio_json: JSON.stringify(audio) });
        console.log(`[clearnote] saved audio for "${m.title}" (${Object.keys(audio).join(", ")}) to ${audioTo}`);
      }

      let docId = row(meetingId).notes_doc_id;
      if (wantNotes) {
        const folderId = await drive.ensureFolder("notes");
        const name = docName(m);
        let fresh = false;
        try {
          if (docId) await drive.renameFile(docId, name);
        } catch (err) {
          if (err.status !== 404) throw err;
          docId = null; // deleted in Drive: make a new one
        }
        if (!docId) {
          docId = await drive.createDoc(name, folderId);
          fresh = true;
          store(meetingId, { notes_doc_id: docId });
        }
        await drive.writeTabs(docId, notesTabs(m, audio, config.get("displayName")));
        console.log(`[clearnote] ${fresh ? "created" : "updated"} notes doc for "${m.title}"`);
      }
      store(meetingId, { saved_at: Date.now(), error: null });
    } catch (err) {
      console.error(`[clearnote] saving ${meetingId} failed:`, err.message);
      store(meetingId, { error: err.message.slice(0, 500) });
    }
  })().finally(() => running.delete(meetingId));
  running.set(meetingId, job);
  return job;
}

const timers = new Map();
/** Save shortly; repeated calls (several edits in a row) collapse into one. */
export function scheduleSave(meetingId, delayMs = 8000) {
  if (!meetingId) return;
  clearTimeout(timers.get(meetingId));
  timers.set(
    meetingId,
    setTimeout(() => {
      timers.delete(meetingId);
      saveMeeting(meetingId).catch(() => {});
    }, delayMs),
  );
}

