// The calendar path end to end, with events written straight into the database
// so nothing here talks to Google. Covers matching a captured meeting, taking
// the event's title, surfacing who was invited but silent, and correcting a
// match by hand.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8901;
const base = `http://127.0.0.1:${PORT}`;
const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clearnote-cal-")), "test.db");

let child;
let raw;

async function boot() {
  child = spawn(process.execPath, [path.join(here, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      CLEARNOTE_DB: dbFile,
      // Keep the test server away from the real settings file and audio folder.
      CLEARNOTE_SETTINGS: `${dbFile}.settings.json`,
      CLEARNOTE_AUDIO_DIR: `${dbFile}.audio`,
      OPENROUTER_API_KEY: "",
      CLEARNOTE_TOKEN: "",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  raw = new Database(dbFile);
}

const call = (p, opts = {}) =>
  fetch(`${base}${p}`, { headers: { "content-type": "application/json" }, ...opts });

/** Write a calendar event as the sync would have. */
function seedEvent(ev) {
  raw
    .prepare(
      `INSERT OR REPLACE INTO calendar_events
        (id, calendar_id, title, description, location, start_at, end_at, organizer,
         conference_codes, html_link, status, synced_at)
       VALUES (@id, 'primary', @title, @description, NULL, @start_at, @end_at, @organizer,
               @codes, NULL, @status, @now)`,
    )
    .run({
      description: null,
      organizer: "ada@example.com",
      status: "confirmed",
      now: Date.now(),
      ...ev,
      codes: JSON.stringify(ev.codes || []),
    });
  for (const a of ev.attendees || []) {
    raw
      .prepare(
        `INSERT OR REPLACE INTO event_attendees (event_id, email, name, organizer, response)
         VALUES (?, ?, ?, ?, 'accepted')`,
      )
      .run(ev.id, a.email, a.name ?? null, a.organizer ? 1 : 0);
  }
}

async function capture({ key, title, url, startedAt, endedAt, speakers }) {
  const { id } = await (
    await call("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        meetingKey: key,
        platform: "google_meet",
        platformLabel: "Google Meet",
        title,
        url,
        startedAt,
      }),
    })
  ).json();

  await call(`/api/sessions/${id}/segments`, {
    method: "POST",
    body: JSON.stringify({
      segments: speakers.map((s, i) => ({
        seq: i,
        speaker: s,
        text: `line from ${s}`,
        startMs: i * 5000,
        endMs: i * 5000 + 4000,
      })),
    }),
  });

  await call(`/api/sessions/${id}/end`, {
    method: "POST",
    body: JSON.stringify({ endedAt, speakers }),
  });
  await new Promise((r) => setTimeout(r, 400));
  return id;
}

test.before(boot);
test.after(() => {
  raw?.close();
  child?.kill();
});

test("health reports the calendar as unconfigured", async () => {
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.equal(h.calendar.configured, false);
  assert.equal(h.calendar.connected, false);
});

test("connecting without credentials fails with an explanation", async () => {
  const res = await fetch(`${base}/api/google/connect`, { redirect: "manual" });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /client ID and secret in Settings/);
});

test("the OAuth callback rejects an unknown state", async () => {
  // Without this, any site could drive the callback.
  const res = await fetch(`${base}/api/google/callback?code=x&state=forged`, { redirect: "manual" });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /state/i);
});

const t0 = Date.now() - 3 * 3600_000;

test("a captured meeting takes the title and attendees of its calendar event", async () => {
  seedEvent({
    id: "ev-pricing",
    title: "Pricing page — go/no-go",
    start_at: t0,
    end_at: t0 + 45 * 60000,
    codes: ["meet:abc-defg-hij"],
    attendees: [
      { email: "ada@example.com", name: "Ada Lovelace", organizer: 1 },
      { email: "grace@example.com", name: "Grace Hopper" },
      { email: "marcus@example.com", name: "Marcus Chen" },
    ],
  });

  const id = await capture({
    key: "meet:abc-defg-hij",
    title: "Meet abc-defg-hij", // the platform's own generic title
    url: "https://meet.google.com/abc-defg-hij",
    startedAt: t0 + 60000,
    endedAt: t0 + 40 * 60000,
    speakers: ["Ada Lovelace", "Grace Hopper"],
  });

  const m = await (await fetch(`${base}/api/meetings/${id}`)).json();
  assert.equal(m.calendar_event_id, "ev-pricing");
  assert.equal(m.match_confidence, "high");
  assert.equal(m.matched_by, "link+time");
  assert.equal(m.title, "Pricing page — go/no-go", "the calendar title replaces the generic one");
  assert.equal(m.calendarEvent.attendees.length, 3);
});

test("the meeting shows who was invited but never spoke", async () => {
  const list = await (await fetch(`${base}/api/meetings`)).json();
  const id = list.find((x) => x.calendar_event_id === "ev-pricing").id;
  const m = await (await fetch(`${base}/api/meetings/${id}`)).json();

  assert.deepEqual(
    m.spoke.map((s) => s.email),
    ["ada@example.com", "grace@example.com"],
  );
  assert.deepEqual(
    m.silentInvitees.map((s) => s.email),
    ["marcus@example.com"],
  );
});

test("an impromptu call is left unmatched rather than guessed at", async () => {
  const id = await capture({
    key: "meet:qqq-qqqq-qqq",
    title: "Meet qqq-qqqq-qqq",
    url: "https://meet.google.com/qqq-qqqq-qqq",
    startedAt: Date.now() - 20 * 60000,
    endedAt: Date.now() - 5 * 60000,
    speakers: ["Ada Lovelace"],
  });
  const m = await (await fetch(`${base}/api/meetings/${id}`)).json();
  assert.equal(m.calendar_event_id, null);
  assert.equal(m.title, "Meet qqq-qqqq-qqq", "no match means no borrowed title");
});

test("a wrong match can be corrected by hand", async () => {
  const start = Date.now() - 90 * 60000;
  seedEvent({
    id: "ev-standup",
    title: "Daily standup",
    start_at: start,
    end_at: start + 15 * 60000,
    codes: [],
    attendees: [{ email: "ada@example.com", name: "Ada Lovelace", organizer: 1 }],
  });
  seedEvent({
    id: "ev-retro",
    title: "Sprint retro",
    start_at: start + 15 * 60000,
    end_at: start + 60 * 60000,
    codes: [],
    attendees: [{ email: "grace@example.com", name: "Grace Hopper", organizer: 1 }],
  });

  const id = await capture({
    key: "meet:rrr-rrrr-rrr",
    title: "Meet rrr-rrrr-rrr",
    url: "https://meet.google.com/rrr-rrrr-rrr",
    startedAt: start + 5 * 60000,
    endedAt: start + 50 * 60000,
    speakers: ["Grace Hopper"],
  });

  // Two overlapping events with no link: left ambiguous on purpose.
  let m = await (await fetch(`${base}/api/meetings/${id}`)).json();
  assert.equal(m.calendar_event_id, null, "back-to-back events are not guessed between");

  const candidates = await (await fetch(`${base}/api/meetings/${id}/match-candidates`)).json();
  assert.ok(candidates.events.length >= 2, "both are offered");

  m = await (
    await call(`/api/meetings/${id}/match`, {
      method: "POST",
      body: JSON.stringify({ eventId: "ev-retro" }),
    })
  ).json();
  assert.equal(m.calendar_event_id, "ev-retro");
  assert.equal(m.match_confidence, "confirmed");
  assert.equal(m.title, "Sprint retro");
});

test("a match can be cleared again", async () => {
  const list = await (await fetch(`${base}/api/meetings`)).json();
  const id = list.find((x) => x.calendar_event_id === "ev-retro").id;
  const m = await (
    await call(`/api/meetings/${id}/match`, {
      method: "POST",
      body: JSON.stringify({ eventId: null }),
    })
  ).json();
  assert.equal(m.calendar_event_id, null);
  assert.equal(m.calendarEvent, null);
});

test("matching to an unknown event is a 404", async () => {
  const list = await (await fetch(`${base}/api/meetings`)).json();
  const res = await call(`/api/meetings/${list[0].id}/match`, {
    method: "POST",
    body: JSON.stringify({ eventId: "nope" }),
  });
  assert.equal(res.status, 404);
});

test("a title edited by hand survives a later calendar match", async () => {
  const start = Date.now() - 30 * 60000;
  seedEvent({
    id: "ev-named",
    title: "Calendar's title",
    start_at: start,
    end_at: start + 30 * 60000,
    codes: ["meet:nnn-nnnn-nnn"],
    attendees: [],
  });
  const id = await capture({
    key: "meet:nnn-nnnn-nnn",
    title: "Meet nnn-nnnn-nnn",
    url: "https://meet.google.com/nnn-nnnn-nnn",
    startedAt: start + 60000,
    endedAt: start + 20 * 60000,
    speakers: ["Ada Lovelace"],
  });

  await call(`/api/meetings/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "My own title" }),
  });
  // Re-matching must not clobber it.
  await call(`/api/meetings/${id}/match`, {
    method: "POST",
    body: JSON.stringify({ eventId: "ev-named", adoptTitle: false }),
  });

  const m = await (await fetch(`${base}/api/meetings/${id}`)).json();
  assert.equal(m.title, "My own title");
  assert.equal(m.calendar_event_id, "ev-named");
});

test("upcoming events list and say which were captured", async () => {
  const soon = Date.now() + 20 * 60000;
  seedEvent({
    id: "ev-soon",
    title: "Next one up",
    start_at: soon,
    end_at: soon + 30 * 60000,
    codes: ["meet:sss-ssss-sss"],
    attendees: [],
  });
  const upcoming = await (await fetch(`${base}/api/calendar/upcoming`)).json();
  const row = upcoming.find((e) => e.id === "ev-soon");
  assert.ok(row, "a future event is listed");
  assert.equal(row.meeting_id, null, "and is marked as not yet captured");
});

test("disconnecting clears the calendar and every match", async () => {
  await call("/api/google/disconnect", { method: "POST" });
  const status = await (await fetch(`${base}/api/google/status`)).json();
  assert.equal(status.connected, false);
  assert.equal(status.eventCount, 0, "events are removed, not left behind");

  const list = await (await fetch(`${base}/api/meetings`)).json();
  assert.ok(
    list.every((m) => !m.calendar_event_id),
    "no meeting still points at a deleted event",
  );
  assert.ok(
    list.some((m) => m.title === "Pricing page — go/no-go"),
    "titles already adopted are kept",
  );
});
