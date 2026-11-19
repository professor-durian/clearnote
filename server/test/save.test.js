import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "clearnote-save-"));
process.env.CLEARNOTE_DB = path.join(dir, "t.db");
process.env.CLEARNOTE_SETTINGS = path.join(dir, "settings.json");
process.env.CLEARNOTE_AUDIO_DIR = path.join(dir, "audio");
const { notesTabs, docName, audioName, clock } = await import("../save.js");
const config = await import("../config.js");
const { tabRequests } = await import("../drive.js");

const meeting = {
  title: "Pricing sync",
  platform: "meet",
  platform_label: "Google Meet",
  started_at: new Date(2026, 10, 19, 14, 5).getTime(),
  ended_at: new Date(2026, 10, 19, 14, 35).getTime(),
  spoke: [{ name: "Ana Silva" }, { speaker: "Ben" }],
  silentInvitees: [{ email: "cfo@example.com" }],
  summary: {
    headline: "Pricing page ships Friday",
    tldr: "The team agreed the launch date.",
    key_points: ["Legal review done"],
    decisions: ["Ship Friday"],
    open_questions: ["Annual discount?"],
    next_meeting: null,
  },
  actionItems: [
    { text: "Send the contract", owner: "Ben", due: "2026-11-21", done: 0 },
    { text: "Already done", owner: null, done: 1 },
  ],
  segments: [{ speaker: "Ana Silva", text: "caption text", start_ms: 1000 }],
  recordType: "merged",
  mergedLines: [{ speaker: "Ana Silva", text: "Audio text.", startMs: 65000, inferred: false }],
};

test("doc and audio names carry title, date and time", () => {
  assert.equal(docName(meeting), "Pricing sync – 2026-11-19 14.05 – Notes by ClearNote");
  assert.equal(audioName({ ...meeting, title: "A/B: test" }, "mixed"), "A-B- test – 2026-11-19 14.05 – mixed.mp3");
  assert.equal(docName(meeting, "{year}/{month} {platform} – {people} – {nope}"), "2026-11 Google Meet – Ana Silva, Ben – {nope}");
  assert.equal(clock(65000), "01:05");
  assert.equal(clock(3725000), "1:02:05");
});

test("Notes and Transcript tabs, like Gemini's notes", () => {
  const [notes, transcript] = notesTabs(meeting, { mixed: { driveId: "abc" }, mic: { path: "/x/mic.mp3" } });
  assert.equal(notes.title, "Notes");
  assert.equal(transcript.title, "Transcript");
  const text = notes.paragraphs.map((p) => p.text);
  assert.ok(text.includes("Summary") && text.includes("Suggested next steps") && text.includes("Recordings"));
  assert.ok(text.includes("☐ Ben: Send the contract (due 2026-11-21)"));
  assert.ok(!text.some((t) => t.includes("Already done")), "done items are left out");
  assert.ok(text.some((t) => t.startsWith("Invited, not heard from: cfo@example.com")));
  const link = notes.paragraphs.find((p) => p.link);
  assert.equal(link.link, "https://drive.google.com/file/d/abc/view");
  // The transcript uses the audio version when there is one.
  assert.equal(transcript.paragraphs[1].text, "[01:05] Ana Silva: Audio text.");
});

test("captions are used when there is no audio transcript, and a missing summary says so", () => {
  const [notes, transcript] = notesTabs({ ...meeting, summary: { notice: "No summary: add a key" }, mergedLines: null });
  assert.ok(notes.paragraphs.some((p) => p.text === "No summary: add a key"));
  assert.equal(transcript.paragraphs[1].text, "[00:01] Ana Silva: caption text");
});

test("doc requests place styles at the right positions", () => {
  const reqs = tabRequests("t1", [
    { text: "Title", style: "HEADING_1" },
    { text: "Ben: hi", bold: [0, 4] },
  ]);
  assert.deepEqual(reqs[0], { insertText: { text: "Title\nBen: hi\n", location: { index: 1, tabId: "t1" } } });
  const heading = reqs.find((r) => r.updateParagraphStyle?.paragraphStyle.namedStyleType === "HEADING_1");
  assert.deepEqual(heading.updateParagraphStyle.range, { startIndex: 1, endIndex: 7, tabId: "t1" });
  const bold = reqs.find((r) => r.updateTextStyle);
  assert.deepEqual(bold.updateTextStyle.range, { startIndex: 7, endIndex: 11, tabId: "t1" });
});

test("'You' in captions becomes your name from Settings", () => {
  const m = { ...meeting, spoke: [{ speaker: "You" }, { name: "Ana Silva" }], mergedLines: [{ speaker: "You", text: "Hi.", startMs: 0 }] };
  const [notes, transcript] = notesTabs(m, {}, "Scott");
  assert.ok(notes.paragraphs.some((p) => p.text === "Attendees: Scott, Ana Silva"));
  assert.equal(transcript.paragraphs[1].text, "[00:00] Scott: Hi.");
});

test("part names and tab names come from Settings", () => {
  config.update({ partMixed: "everyone", tabNotesName: "Summary", tabTranscriptName: "Full transcript" });
  assert.equal(audioName(meeting, "mixed"), "Pricing sync – 2026-11-19 14.05 – everyone.mp3");
  const [notes, transcript] = notesTabs(meeting);
  assert.equal(notes.title, "Summary");
  assert.equal(transcript.title, "Full transcript");
  config.update({ partMixed: "mixed", tabNotesName: "Notes", tabTranscriptName: "Transcript" });
});
