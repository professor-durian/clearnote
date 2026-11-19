import express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  db,
  openMeeting,
  resolveMeetingId,
  addSegments,
  closeMeeting,
  getMeeting,
  getSegments,
  listMeetings,
  searchSegments,
  saveAnalysis,
  markFailed,
  markUnsummarized,
  allTags,
  openActionItems,
} from "./db.js";
import { candidateEvents, getEvent, linkMeetingToEvent, upcomingEvents } from "./db.js";
import { pickMatch, shouldAdoptTitle, reconcileParticipants } from "./matching.js";
import * as google from "./google.js";
import { analyzeMeeting, askMeeting, aiConfigured, providerOrder, testProvider } from "./ai.js";
import * as config from "./config.js";
import { listDirs, makeDir } from "./folders.js";
import { usageReport, meetingUsage } from "./usage.js";
import { toText, filenameFor } from "./export.js";
import { registerAudioRoutes, processAudio, audioFields, resumePending, deleteAudio, onAudioDone } from "./audio.js";
import { saveMeeting, scheduleSave, exportStatus, fillName, PART_KEYS } from "./save.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.CLEARNOTE_TOKEN || "";

const app = express();
app.use(express.json({ limit: "20mb" }));

// The extension posts from meet.google.com / zoom.us / teams.microsoft.com.
app.use((req, res, next) => {
  res.set("access-control-allow-origin", "*");
  res.set("access-control-allow-headers", "content-type,x-clearnote-token");
  res.set("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Shared-secret gate for the capture endpoints. The dashboard is served from
// the same origin and reads with the browser's own session, so GETs stay open
// on localhost; set CLEARNOTE_TOKEN before exposing this beyond your machine.
function requireToken(req, res, next) {
  if (!TOKEN) return next();
  if (req.get("x-clearnote-token") === TOKEN) return next();
  res.status(401).json({ error: "bad or missing x-clearnote-token" });
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(`[clearnote] ${req.method} ${req.path} failed:`, err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

// ------------------------------------------------------------------ capture

const BOOTED_AT = Date.now();

app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    ai: aiConfigured(),
    calendar: google.connectionStatus(),
    version: "0.1.0",
    // When this process started. A server older than the files it was started
    // from is running stale code — easy to do, and otherwise invisible.
    bootedAt: BOOTED_AT,
  }),
);

app.post(
  "/api/sessions",
  requireToken,
  wrap((req, res) => {
    const { meetingKey, platform, platformLabel, title, url, startedAt } = req.body || {};
    if (!meetingKey || !platform || !startedAt) {
      return res.status(400).json({ error: "meetingKey, platform and startedAt are required" });
    }
    const id = openMeeting({
      meetingKey,
      platform,
      platformLabel,
      title,
      url,
      startedAt: Number(startedAt),
    });
    console.log(`[clearnote] capturing "${title}" (${platform}) -> ${id}`);
    res.json({ id });
  }),
);

app.post(
  "/api/sessions/:id/segments",
  requireToken,
  wrap((req, res) => {
    const meetingId = resolveMeetingId(req.params.id);
    if (!meetingId) return res.status(404).json({ error: "unknown session" });
    const segments = Array.isArray(req.body?.segments) ? req.body.segments : [];
    addSegments(meetingId, segments);
    res.json({ ok: true, stored: segments.length });
  }),
);

app.post(
  "/api/sessions/:id/end",
  requireToken,
  wrap(async (req, res) => {
    const meetingId = resolveMeetingId(req.params.id);
    if (!meetingId) return res.status(404).json({ error: "unknown session" });
    const { endedAt = Date.now(), speakers = [], title, myName = "" } = req.body || {};
    if (title) db.prepare(`UPDATE meetings SET title = ? WHERE id = ?`).run(title, meetingId);
    closeMeeting(meetingId, { endedAt: Number(endedAt), speakers });

    // Answer the extension immediately; matching and the summary run behind it.
    res.json({ ok: true, id: meetingId });
    matchToCalendar(meetingId)
      .catch((err) => console.warn(`[clearnote] calendar match skipped: ${err.message}`))
      .finally(() => summarize(meetingId).catch(() => {}));
    processAudio(meetingId, { myName }).catch(() => {});
  }),
);

registerAudioRoutes(app, { requireToken, wrap });
onAudioDone((id) => scheduleSave(id, 1000));

// An edit in the dashboard (a transcript line, a title, an action item) updates
// the saved notes a few seconds later.
app.use((req, res, next) => {
  if (!["PATCH", "POST", "DELETE"].includes(req.method)) return next();
  const m = req.path.match(/^\/api\/(meetings|segments|action-items)\/([^/]+)/);
  if (!m || req.path.endsWith("/save") || req.path.endsWith("/retranscribe")) return next();
  res.on("finish", () => {
    if (res.statusCode >= 400) return;
    let meetingId = m[2];
    if (m[1] === "segments") meetingId = db.prepare(`SELECT meeting_id FROM segments WHERE id = ?`).get(m[2])?.meeting_id;
    if (m[1] === "action-items") meetingId = db.prepare(`SELECT meeting_id FROM action_items WHERE id = ?`).get(m[2])?.meeting_id;
    if (meetingId && db.prepare(`SELECT 1 FROM meetings WHERE id = ?`).get(meetingId)) scheduleSave(meetingId);
  });
  next();
});

app.post(
  "/api/meetings/:id/save",
  wrap(async (req, res) => {
    await saveMeeting(req.params.id);
    res.json(exportStatus(req.params.id));
  }),
);

// ------------------------------------------------------------------ settings

// Settings change keys and where data goes, so only the dashboard itself and
// the extension may call these. Any other website gets a 403, even though the
// rest of the API allows cross-origin calls from the meeting pages.
function ownOrigin(req, res, next) {
  const origin = req.get("origin");
  const host = req.get("host");
  if (!origin || origin === `http://${host}` || origin.startsWith("chrome-extension://")) return next();
  res.status(403).json({ error: "settings can only be changed from the ClearNote dashboard or extension" });
}

app.get("/api/settings", ownOrigin, (_req, res) =>
  res.json({ ...config.publicView(), ai: { configured: aiConfigured(), order: providerOrder() } }),
);

app.patch(
  "/api/settings",
  ownOrigin,
  wrap((req, res) => {
    const before = config.get("calendarIds");
    config.update(req.body || {});
    if (config.get("calendarIds") !== before && google.connectionStatus().connected) {
      google.syncEvents().catch((err) => console.warn(`[clearnote] calendar sync failed: ${err.message}`));
    }
    res.json({ ...config.publicView(), ai: { configured: aiConfigured(), order: providerOrder() } });
  }),
);

// What the extension needs: your name and the capture options.
// Folder browser for the "save audio to this computer" setting.
app.get(
  "/api/folders",
  ownOrigin,
  wrap((req, res) => {
    try {
      res.json(listDirs(req.query.path));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }),
);
app.post(
  "/api/folders",
  ownOrigin,
  wrap((req, res) => {
    try {
      res.json(makeDir(req.body?.parent, req.body?.name));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }),
);

// Live examples for the name templates on the Settings page, using your most
// recent meeting (or a sample when there is none).
app.post(
  "/api/names/preview",
  ownOrigin,
  wrap((req, res) => {
    const latest = db.prepare(`SELECT id FROM meetings ORDER BY started_at DESC LIMIT 1`).get();
    const m = latest
      ? getMeeting(latest.id)
      : { title: "Pricing sync", started_at: Date.now(), platform_label: "Google Meet", spoke: [{ name: "Ana Silva" }, { name: "Ben Ito" }] };
    const b = req.body || {};
    const parts = Object.fromEntries(
      Object.keys(PART_KEYS).map((k) => [k, `${fillName(b.audioFileName ?? config.get("audioFileName"), m, { part: b[PART_KEYS[k]] ?? config.get(PART_KEYS[k]) })}.mp3`]),
    );
    res.json({ notes: fillName(b.notesDocName ?? config.get("notesDocName"), m), audio: parts, from: latest ? m.title : "a sample meeting" });
  }),
);

// Spending log for the Settings › Usage tab.
app.get("/api/usage", ownOrigin, (_req, res) => res.json(usageReport()));

app.get("/api/extension-settings", ownOrigin, (_req, res) => res.json(config.extensionView()));

app.post(
  "/api/ai/test",
  ownOrigin,
  wrap(async (req, res) => {
    try {
      res.json(await testProvider(req.body?.provider === "openrouter" ? "openrouter" : "anthropic"));
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  }),
);

// ------------------------------------------------------------- calendar

/**
 * Attach a captured meeting to the calendar event it belongs to. Refreshes the
 * calendar first, because an impromptu call may have been put on the calendar
 * only moments ago.
 */
async function matchToCalendar(meetingId) {
  // Refresh first when we can — an impromptu call may have been put on the
  // calendar moments ago. Matching itself only needs stored events, so a
  // revoked token degrades to matching against what was last synced.
  if (google.connectionStatus().connected) {
    try {
      await google.syncEvents({ daysBack: 1, daysForward: 1 });
    } catch (err) {
      console.warn(`[clearnote] calendar sync failed, matching on cached events: ${err.message}`);
    }
  }

  const meeting = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(meetingId);
  if (!meeting) return null;

  const events = candidateEvents(meeting);
  if (!events.length) return null;

  const match = pickMatch(meeting, events);
  if (!match || !match.event) {
    if (match?.confidence === "ambiguous") {
      console.log(`[clearnote] "${meeting.title}" overlaps several events — left for you to pick`);
    }
    return null;
  }

  linkMeetingToEvent(meetingId, match.event.id, {
    confidence: match.confidence,
    matchedBy: match.matchedBy,
    title: shouldAdoptTitle(meeting, match.event) ? match.event.title : null,
  });
  console.log(
    `[clearnote] matched "${meeting.title}" to "${match.event.title}" (${match.matchedBy}, ${match.confidence})`,
  );
  return match;
}

app.get("/api/google/status", wrap((_req, res) => res.json(google.connectionStatus())));

app.get(
  "/api/google/calendars",
  ownOrigin,
  wrap(async (_req, res) => {
    const selected = google.selectedCalendars();
    if (!google.connectionStatus().calendarList) return res.json({ needsReconnect: true, selected, calendars: [] });
    res.json({ needsReconnect: false, selected, calendars: await google.listCalendars() });
  }),
);

// Short-lived OAuth state values, so the callback cannot be driven by another site.
const oauthStates = new Set();

app.get(
  "/api/google/connect",
  wrap((req, res) => {
    if (!google.googleConfigured()) {
      return res
        .status(400)
        .send("Add your Google client ID and secret in Settings first.");
    }
    // Guards the callback against being driven by another site.
    const state = randomUUID();
    oauthStates.add(state);
    setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000);
    res.redirect(google.authUrl(state));
  }),
);

app.get(
  "/api/google/callback",
  wrap(async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.redirect(`/#/settings?google=${encodeURIComponent(error)}`);
    if (!state || !oauthStates.delete(String(state))) {
      return res.status(400).send("Stale or unknown OAuth state — start again from Settings.");
    }
    try {
      await google.exchangeCode(String(code));
      await google.syncEvents();
      res.redirect("/#/settings?google=connected");
    } catch (err) {
      console.error("[clearnote] google connect failed:", err);
      res.redirect(`/#/settings?google=${encodeURIComponent(err.message)}`);
    }
  }),
);

app.post(
  "/api/google/sync",
  wrap(async (_req, res) => res.json(await google.syncEvents())),
);

app.post(
  "/api/google/disconnect",
  wrap((_req, res) => {
    google.disconnect();
    res.json(google.connectionStatus());
  }),
);

app.get("/api/calendar/upcoming", wrap((_req, res) => res.json(upcomingEvents(12))));

/** The events this meeting could belong to, best first, for the picker. */
app.get(
  "/api/meetings/:id/match-candidates",
  wrap((req, res) => {
    const meeting = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(req.params.id);
    if (!meeting) return res.status(404).json({ error: "unknown meeting" });
    const events = candidateEvents(meeting, 4 * 60 * 60 * 1000);
    const best = pickMatch(meeting, events);
    res.json({
      current: meeting.calendar_event_id,
      suggestion: best?.event?.id ?? null,
      confidence: best?.confidence ?? null,
      events,
    });
  }),
);

/** Correct a match by hand, or clear it with eventId: null. */
app.post(
  "/api/meetings/:id/match",
  wrap(async (req, res) => {
    const id = resolveMeetingId(req.params.id);
    if (!id) return res.status(404).json({ error: "unknown meeting" });
    const { eventId = null, adoptTitle = true } = req.body || {};

    if (eventId === null) {
      linkMeetingToEvent(id, null, { confidence: null, matchedBy: null });
      return res.json(getMeeting(id));
    }
    const event = getEvent(eventId);
    if (!event) return res.status(404).json({ error: "unknown calendar event" });

    linkMeetingToEvent(id, eventId, {
      confidence: "confirmed",
      matchedBy: "manual",
      title: adoptTitle ? event.title : null,
    });
    res.json(getMeeting(id));
  }),
);

// ------------------------------------------------------------------ AI

// Every path through a summary ends with the meeting saved wherever Settings
// says (Drive notes, audio files), so the saved copy always matches.
async function summarize(meetingId, template) {
  try {
    await summarizeOnly(meetingId, template);
  } finally {
    scheduleSave(meetingId, 1000);
  }
}

async function summarizeOnly(meetingId, template) {
  const meeting = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(meetingId);
  const segments = getSegments(meetingId);
  if (!meeting) return;

  if (!segments.length) {
    markFailed(meetingId, "no captions were captured — were captions on in the call?");
    return;
  }
  if (!aiConfigured()) {
    markUnsummarized(
      meetingId,
      "No summary: add an AI key in Settings and use Generate summary. The transcript is saved in full.",
    );
    return;
  }

  db.prepare(`UPDATE meetings SET status = 'processing' WHERE id = ?`).run(meetingId);
  // Hand the model the calendar event too: the agenda and the real invitee
  // names make for better owners than a caption spelling.
  const event = meeting.calendar_event_id ? getEvent(meeting.calendar_event_id) : null;
  const context = { event, attendees: event?.attendees || [] };
  try {
    const analysis = await analyzeMeeting(meeting, segments, template, context);
    saveAnalysis(meetingId, analysis);
    console.log(
      `[clearnote] summarized "${meeting.title}": ${analysis.actionItems.length} action items, ` +
        `${analysis.usage?.input_tokens ?? "?"} in / ${analysis.usage?.output_tokens ?? "?"} out`,
    );
  } catch (err) {
    console.error(`[clearnote] summary failed for ${meetingId}:`, err.message);
    markFailed(meetingId, err.message);
  }
}

app.post(
  "/api/meetings/:id/process",
  wrap(async (req, res) => {
    const id = resolveMeetingId(req.params.id);
    if (!id) return res.status(404).json({ error: "unknown meeting" });
    await summarize(id, req.body?.template);
    res.json(getMeeting(id));
  }),
);

app.post(
  "/api/meetings/:id/ask",
  wrap(async (req, res) => {
    const id = resolveMeetingId(req.params.id);
    if (!id) return res.status(404).json({ error: "unknown meeting" });
    if (!aiConfigured()) return res.status(400).json({ error: "no AI provider set: add a key in Settings" });
    const question = String(req.body?.question || "").trim();
    if (!question) return res.status(400).json({ error: "question is required" });
    const meeting = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(id);
    const event = meeting.calendar_event_id ? getEvent(meeting.calendar_event_id) : null;
    const answer = await askMeeting(meeting, getSegments(id), question, req.body?.history || [], {
      event,
      attendees: event?.attendees || [],
    });
    res.json(answer);
  }),
);

// ------------------------------------------------------------------ read & edit

app.get(
  "/api/meetings",
  wrap((req, res) => {
    const rows = listMeetings({ q: req.query.q, tag: req.query.tag, limit: Number(req.query.limit) || 60 });
    // Per-row status for the list: transcript kind, audio, summary, saved copy.
    res.json(
      rows.map((m) => {
        const a = audioFields(m.id);
        const s = exportStatus(m.id);
        return {
          ...m,
          recordType: a.recordType,
          audioStatus: a.audioStatus,
          hasAudio: a.audioTracks.some((t) => t.bytes > 0),
          saved: { savedAt: s.savedAt, error: s.error, notesUrl: s.notesUrl },
        };
      }),
    );
  }),
);

app.get(
  "/api/meetings/:id",
  wrap((req, res) => {
    const m = getMeeting(req.params.id);
    if (!m) return res.status(404).json({ error: "unknown meeting" });
    res.json({ ...m, ...audioFields(m.id), saved: exportStatus(m.id), aiUsage: meetingUsage(m.id) });
  }),
);

// Downloaded as a file, so the browser saves it rather than showing it.
app.get(
  "/api/meetings/:id/export.txt",
  wrap((req, res) => {
    const m = getMeeting(req.params.id);
    if (!m) return res.status(404).json({ error: "unknown meeting" });
    res.set("content-type", "text/plain; charset=utf-8");
    res.set("content-disposition", `attachment; filename="${filenameFor(m)}"`);
    res.send(toText(m));
  }),
);

app.delete(
  "/api/meetings/:id",
  wrap((req, res) => {
    const info = db.prepare(`DELETE FROM meetings WHERE id = ?`).run(req.params.id);
    if (info.changes) deleteAudio(req.params.id);
    res.json({ deleted: info.changes });
  }),
);

app.patch(
  "/api/meetings/:id",
  wrap((req, res) => {
    const { title, notes } = req.body || {};
    if (title !== undefined) {
      db.prepare(`UPDATE meetings SET title = ?, title_is_generic = 0 WHERE id = ?`).run(
        title,
        req.params.id,
      );
    }
    if (notes !== undefined)
      db.prepare(`UPDATE meetings SET notes = ? WHERE id = ?`).run(notes, req.params.id);
    res.json(getMeeting(req.params.id));
  }),
);

// Fix a mis-transcribed line, or rename a speaker across the whole meeting.
app.patch(
  "/api/segments/:id",
  wrap((req, res) => {
    const seg = db.prepare(`SELECT * FROM segments WHERE id = ?`).get(req.params.id);
    if (!seg) return res.status(404).json({ error: "unknown segment" });
    const { text, speaker, renameAll } = req.body || {};
    if (text !== undefined)
      db.prepare(`UPDATE segments SET text = ? WHERE id = ?`).run(text, seg.id);
    if (speaker !== undefined) {
      if (renameAll) {
        db.prepare(`UPDATE segments SET speaker = ? WHERE meeting_id = ? AND speaker = ?`).run(
          speaker,
          seg.meeting_id,
          seg.speaker,
        );
        db.prepare(`UPDATE participants SET name = ? WHERE meeting_id = ? AND name = ?`).run(
          speaker,
          seg.meeting_id,
          seg.speaker,
        );
      } else {
        db.prepare(`UPDATE segments SET speaker = ? WHERE id = ?`).run(speaker, seg.id);
      }
    }
    res.json({ ok: true });
  }),
);

app.post(
  "/api/meetings/:id/action-items",
  wrap((req, res) => {
    const id = resolveMeetingId(req.params.id);
    if (!id) return res.status(404).json({ error: "unknown meeting" });
    const { text, owner = null, due = null, priority = "medium" } = req.body || {};
    if (!text) return res.status(400).json({ error: "text is required" });
    const info = db
      .prepare(
        `INSERT INTO action_items (meeting_id, text, owner, due, priority, source, created_at)
         VALUES (?, ?, ?, ?, ?, 'manual', ?)`,
      )
      .run(id, text, owner, due, priority, Date.now());
    res.json({ id: info.lastInsertRowid });
  }),
);

app.patch(
  "/api/action-items/:id",
  wrap((req, res) => {
    const { done, text, owner, due, priority } = req.body || {};
    const sets = [];
    const vals = [];
    for (const [col, v] of [
      ["done", done === undefined ? undefined : done ? 1 : 0],
      ["text", text],
      ["owner", owner],
      ["due", due],
      ["priority", priority],
    ]) {
      if (v !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(v);
      }
    }
    if (!sets.length) return res.status(400).json({ error: "nothing to update" });
    db.prepare(`UPDATE action_items SET ${sets.join(", ")} WHERE id = ?`).run(
      ...vals,
      req.params.id,
    );
    res.json({ ok: true });
  }),
);

app.get("/api/action-items", wrap((_req, res) => res.json(openActionItems())));
app.get("/api/tags", wrap((_req, res) => res.json(allTags())));
app.get(
  "/api/search",
  wrap((req, res) => res.json(searchSegments(String(req.query.q || ""), 80))),
);

// ------------------------------------------------------------------ dashboard

app.use("/vendor/shoelace", express.static(path.join(here, "node_modules", "@shoelace-style", "shoelace", "cdn")));
app.use(express.static(path.join(here, "public")));
app.get("*", (_req, res) => res.sendFile(path.join(here, "public", "index.html")));

const server = app.listen(PORT, () => {
  console.log(`\n  ClearNote server  http://localhost:${PORT}`);
  console.log(`  summaries         ${aiConfigured() ? `on (${providerOrder().join(", then ")})` : "off (add a key in Settings)"}`);
  console.log(`  sync token        ${TOKEN ? "required" : "not set (local use only)"}`);
  const cal = google.connectionStatus();
  console.log(
    `  calendar          ${
      cal.connected ? `connected as ${cal.email}` : cal.configured ? "ready to connect" : "off (add Google client details in Settings)"
    }\n`,
  );
});

// Leaving an old server running is the easy mistake, and Node's default is an
// unhandled-error stack trace that buries the one useful fact.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n  Port ${PORT} is already in use — another ClearNote server is probably still running.\n` +
        `  Find it:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN\n` +
        `  Stop it:  kill $(lsof -t -iTCP:${PORT} -sTCP:LISTEN)\n` +
        `  Or start this one elsewhere:  PORT=8788 npm start\n`,
    );
    process.exit(1);
  }
  throw err;
});

// Any meeting left mid-flight by a crash gets picked up on the next boot.
const stale = db
  .prepare(`SELECT id FROM meetings WHERE status = 'processing' AND ended_at IS NOT NULL`)
  .all();
for (const row of stale) summarize(row.id).catch(() => {});
resumePending();
