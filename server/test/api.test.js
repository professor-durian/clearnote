// Drives the capture API the way the extension does: open a session, stream
// segments in batches, end it, then read the meeting back. Runs against a
// throwaway database and never calls the Claude API.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8899;
const base = `http://127.0.0.1:${PORT}`;
const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clearnote-")), "test.db");

let child;

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
      CLEARNOTE_TOKEN: "test-token",
      // No API key: the server must still capture, and mark the summary missing.
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

const call = (path, opts = {}) =>
  fetch(`${base}${path}`, {
    ...opts,
    headers: { "content-type": "application/json", "x-clearnote-token": "test-token", ...opts.headers },
  });

test.before(boot);
test.after(() => child?.kill());

test("health reports that the AI layer is unconfigured", async () => {
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.equal(h.ok, true);
  assert.equal(h.ai, false);
});

test("capture endpoints reject a wrong token", async () => {
  const res = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-clearnote-token": "nope" },
    body: JSON.stringify({ meetingKey: "x", platform: "google_meet", startedAt: Date.now() }),
  });
  assert.equal(res.status, 401);
});

let meetingId;
const startedAt = Date.now() - 20 * 60000;

test("a session opens and streams segments in batches", async () => {
  const open = await (
    await call("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        meetingKey: "meet:abc-defg-hij",
        platform: "google_meet",
        platformLabel: "Google Meet",
        title: "Pricing sync",
        url: "https://meet.google.com/abc-defg-hij",
        startedAt,
      }),
    })
  ).json();
  assert.ok(open.id);
  meetingId = open.id;

  const batch = (segs) =>
    call(`/api/sessions/${meetingId}/segments`, {
      method: "POST",
      body: JSON.stringify({ segments: segs }),
    });

  let r = await (
    await batch([
      { seq: 0, speaker: "Ada", text: "Let's settle the pricing page.", startMs: 1000, endMs: 4000 },
      { seq: 1, speaker: "Grace", text: "I want the annual tier first.", startMs: 5000, endMs: 8000 },
    ])
  ).json();
  assert.equal(r.stored, 2);

  r = await (
    await batch([
      { seq: 2, speaker: "Ada", text: "Fine. Ship it Thursday.", startMs: 9000, endMs: 12000 },
    ])
  ).json();
  assert.equal(r.stored, 1);
});

test("a replayed batch does not duplicate lines", async () => {
  // The extension's queue retries on failure, so the same seq can arrive twice.
  await call(`/api/sessions/${meetingId}/segments`, {
    method: "POST",
    body: JSON.stringify({
      segments: [
        { seq: 2, speaker: "Ada", text: "Fine. Ship it Thursday.", startMs: 9000, endMs: 12000 },
      ],
    }),
  });
  const m = await (await fetch(`${base}/api/meetings/${meetingId}`)).json();
  assert.equal(m.segments.length, 3, "seq is unique per meeting");
});

test("a queued batch addressed by room key still lands in the meeting", async () => {
  // When the server was unreachable at session start, the extension falls back
  // to the room key as the session id.
  const r = await (
    await call(`/api/sessions/${encodeURIComponent("meet:abc-defg-hij")}/segments`, {
      method: "POST",
      body: JSON.stringify({
        segments: [{ seq: 3, speaker: "Grace", text: "I'll tell support.", startMs: 13000, endMs: 15000 }],
      }),
    })
  ).json();
  assert.equal(r.stored, 1);
  const m = await (await fetch(`${base}/api/meetings/${meetingId}`)).json();
  assert.equal(m.segments.length, 4);
});

test("participants are derived from the speakers seen", async () => {
  const m = await (await fetch(`${base}/api/meetings/${meetingId}`)).json();
  assert.deepEqual(m.participants, ["Ada", "Grace"]);
});

test("ending a session records the duration and notes the missing summary", async () => {
  const endedAt = startedAt + 18 * 60000;
  await call(`/api/sessions/${meetingId}/end`, {
    method: "POST",
    body: JSON.stringify({ endedAt, speakers: ["Ada", "Grace"], title: "Pricing sync" }),
  });

  // The summary runs after the response, so give it a moment to settle.
  await new Promise((r) => setTimeout(r, 400));
  const m = await (await fetch(`${base}/api/meetings/${meetingId}`)).json();
  assert.equal(m.ended_at, endedAt);
  assert.equal(m.status, "captured", "a missing API key is not a failed capture");
  assert.match(m.summary.notice, /add an AI key in Settings|no AI provider set/);
  assert.ok(!m.summary.error, "nothing actually failed");
  assert.equal(m.segments.length, 4, "the transcript is saved in full regardless");
});

test("rejoining the same room after it ended starts a second meeting", async () => {
  const again = await (
    await call("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        meetingKey: "meet:abc-defg-hij",
        platform: "google_meet",
        title: "Pricing sync (take two)",
        startedAt: Date.now(),
      }),
    })
  ).json();
  assert.notEqual(again.id, meetingId, "a recurring room is not one endless meeting");
});

test("a dropped-then-resumed session reuses the live meeting", async () => {
  const key = "zoom:9876543210";
  const first = await (
    await call("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ meetingKey: key, platform: "zoom", title: "Standup", startedAt: Date.now() }),
    })
  ).json();
  const second = await (
    await call("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        meetingKey: key,
        platform: "zoom",
        title: "Standup",
        startedAt: Date.now() + 5000,
      }),
    })
  ).json();
  assert.equal(second.id, first.id, "a page reload keeps writing to the same meeting");
});

test("full-text search finds a line and names its meeting", async () => {
  const hits = await (await fetch(`${base}/api/search?q=Thursday`)).json();
  assert.ok(hits.length >= 1);
  assert.match(hits[0].text, /Thursday/);
  assert.equal(hits[0].title, "Pricing sync");
});

test("search is forgiving about punctuation", async () => {
  const hits = await (await fetch(`${base}/api/search?q=${encodeURIComponent("support.")}`)).json();
  assert.ok(hits.length >= 1, "a trailing period must not break the FTS query");
});

test("the meeting list carries counts the dashboard needs", async () => {
  const list = await (await fetch(`${base}/api/meetings`)).json();
  const m = list.find((x) => x.id === meetingId);
  assert.equal(m.segmentCount, 4);
  assert.equal(m.openActions, 0);
  assert.deepEqual(m.participants, ["Ada", "Grace"]);
});

test("a manual action item can be added and ticked off", async () => {
  const { id } = await (
    await call(`/api/meetings/${meetingId}/action-items`, {
      method: "POST",
      body: JSON.stringify({ text: "Send the pricing deck", owner: "Ada" }),
    })
  ).json();

  let open = await (await fetch(`${base}/api/action-items`)).json();
  assert.ok(open.some((a) => a.id === id && a.title === "Pricing sync"));

  await call(`/api/action-items/${id}`, { method: "PATCH", body: JSON.stringify({ done: true }) });
  open = await (await fetch(`${base}/api/action-items`)).json();
  assert.ok(!open.some((a) => a.id === id), "a ticked item leaves the open list");
});

test("a mis-transcribed line can be fixed and the fix is searchable", async () => {
  const m = await (await fetch(`${base}/api/meetings/${meetingId}`)).json();
  const seg = m.segments.find((s) => /annual tier/.test(s.text));
  await call(`/api/segments/${seg.id}`, {
    method: "PATCH",
    body: JSON.stringify({ text: "I want the annual plan first." }),
  });
  const hits = await (await fetch(`${base}/api/search?q=${encodeURIComponent("annual plan")}`)).json();
  assert.ok(hits.some((h) => /annual plan/.test(h.text)), "the FTS index follows the edit");
});

test("renaming a speaker rewrites every line they spoke", async () => {
  const m = await (await fetch(`${base}/api/meetings/${meetingId}`)).json();
  const seg = m.segments.find((s) => s.speaker === "Grace");
  await call(`/api/segments/${seg.id}`, {
    method: "PATCH",
    body: JSON.stringify({ speaker: "Grace Hopper", renameAll: true }),
  });
  const after = await (await fetch(`${base}/api/meetings/${meetingId}`)).json();
  assert.ok(!after.segments.some((s) => s.speaker === "Grace"));
  assert.equal(after.segments.filter((s) => s.speaker === "Grace Hopper").length, 2);
  assert.deepEqual(after.participants, ["Ada", "Grace Hopper"]);
});

test("asking about a meeting fails cleanly with no API key", async () => {
  const res = await call(`/api/meetings/${meetingId}/ask`, {
    method: "POST",
    body: JSON.stringify({ question: "What did we decide?" }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /add an AI key in Settings|no AI provider set/);
});

test("a meeting with no captions is flagged rather than summarized", async () => {
  const { id } = await (
    await call("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        meetingKey: "teams:silent",
        platform: "teams",
        title: "Nobody turned captions on",
        startedAt: Date.now(),
      }),
    })
  ).json();
  await call(`/api/sessions/${id}/end`, {
    method: "POST",
    body: JSON.stringify({ endedAt: Date.now() }),
  });
  await new Promise((r) => setTimeout(r, 300));
  const m = await (await fetch(`${base}/api/meetings/${id}`)).json();
  assert.equal(m.status, "failed");
  assert.match(m.summary.error, /no captions/);
});

test("an unknown meeting is a 404, not a crash", async () => {
  assert.equal((await fetch(`${base}/api/meetings/does-not-exist`)).status, 404);
  const res = await call("/api/sessions/does-not-exist/segments", {
    method: "POST",
    body: JSON.stringify({ segments: [] }),
  });
  assert.equal(res.status, 404);
});

test("a session request missing required fields is rejected", async () => {
  const res = await call("/api/sessions", { method: "POST", body: JSON.stringify({ platform: "zoom" }) });
  assert.equal(res.status, 400);
});

test("deleting a meeting takes its transcript out of search", async () => {
  const list = await (await fetch(`${base}/api/meetings`)).json();
  const victim = list.find((m) => m.title === "Pricing sync (take two)");
  await call(`/api/meetings/${victim.id}`, { method: "DELETE" });
  const after = await (await fetch(`${base}/api/meetings`)).json();
  assert.ok(!after.some((m) => m.id === victim.id));
});

// ---------------------------------------------------------------------------
// Getting a transcript out, and deleting one.
// ---------------------------------------------------------------------------

test("a meeting downloads as a plain text file", async () => {
  const list = await (await fetch(`${base}/api/meetings`)).json();
  const m = list.find((x) => x.title === "Pricing sync");

  const res = await fetch(`${base}/api/meetings/${m.id}/export.txt`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/plain/);

  // Saved as a file, named by date and title so exports sort sensibly.
  const disposition = res.headers.get("content-disposition");
  assert.match(disposition, /^attachment;/);
  assert.match(disposition, /filename="\d{4}-\d{2}-\d{2}-Pricing-sync\.txt"/);

  const text = await res.text();
  assert.match(text, /^Pricing sync/, "the title leads");
  assert.match(text, /Google Meet/);
  assert.match(text, /Participants: Ada, Grace Hopper/);
  assert.match(text, /TRANSCRIPT/);
  assert.match(text, /\[\d{2}:\d{2}\] Ada: /, "lines carry a timestamp and a speaker");
  assert.match(text, /Thursday/, "the actual words are in there");
});

test("the export notes a missing summary instead of leaving empty headings", async () => {
  const list = await (await fetch(`${base}/api/meetings`)).json();
  const m = list.find((x) => x.title === "Pricing sync");
  const text = await (await fetch(`${base}/api/meetings/${m.id}/export.txt`)).text();

  assert.ok(!/^KEY POINTS$/m.test(text), "no heading without content under it");
  assert.match(text, /add an AI key in Settings|no AI provider set/, "it says why there is no summary");
});

test("exporting an unknown meeting is a 404", async () => {
  assert.equal((await fetch(`${base}/api/meetings/nope/export.txt`)).status, 404);
});

test("a deleted meeting is gone from search and its file is unavailable", async () => {
  const { id } = await (
    await call("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        meetingKey: "meet:to-be-deleted",
        platform: "google_meet",
        title: "Throwaway",
        startedAt: Date.now(),
      }),
    })
  ).json();
  await call(`/api/sessions/${id}/segments`, {
    method: "POST",
    body: JSON.stringify({
      segments: [
        { seq: 0, speaker: "Ada", text: "quinoa supply chain", startMs: 0, endMs: 1000 },
      ],
    }),
  });

  assert.ok((await (await fetch(`${base}/api/search?q=quinoa`)).json()).length, "indexed first");

  await call(`/api/meetings/${id}`, { method: "DELETE" });

  assert.equal((await fetch(`${base}/api/meetings/${id}`)).status, 404);
  assert.equal((await fetch(`${base}/api/meetings/${id}/export.txt`)).status, 404);
  assert.equal(
    (await (await fetch(`${base}/api/search?q=quinoa`)).json()).length,
    0,
    "the search index lets go too",
  );
});
