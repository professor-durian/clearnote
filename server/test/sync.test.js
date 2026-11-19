import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "clearnote-sync-"));
process.env.CLEARNOTE_DB = path.join(dir, "t.db");
process.env.CLEARNOTE_SETTINGS = path.join(dir, "settings.json");
process.env.CLEARNOTE_AUDIO_DIR = path.join(dir, "audio");
const { db, openMeeting, closeMeeting } = await import("../db.js");
await import("../audio.js"); // creates audio_tracks
await import("../save.js"); // creates meeting_exports
const sync = await import("../sync.js");

function meeting() {
  const id = openMeeting({ meetingKey: `k-${Math.random()}`, platform: "meet", platformLabel: "Google Meet", title: "Budget review", url: "", startedAt: 1000 });
  const ins = db.prepare(`INSERT INTO segments (meeting_id, seq, speaker, text, start_ms, end_ms) VALUES (?, ?, ?, ?, ?, ?)`);
  ins.run(id, 0, "Ana", "Shall we start?", 0, 1500);
  ins.run(id, 1, "Ben", "Yes, the budget first.", 1600, 3000);
  db.prepare(`INSERT INTO action_items (meeting_id, text, owner, created_at) VALUES (?, 'Send the draft', 'Ana', 5)`).run(id);
  closeMeeting(id, { endedAt: 60_000, speakers: ["Ana", "Ben"] });
  db.prepare(`UPDATE meetings SET summary_json = ?, status = 'ready' WHERE id = ?`).run(JSON.stringify({ tldr: "Budget agreed." }), id);
  return id;
}

test("a meeting survives the trip to another computer unchanged", () => {
  const id = meeting();
  const content = JSON.parse(JSON.stringify(sync.meetingContent(id)));
  const hash = sync.hashOf(content);
  db.prepare(`DELETE FROM meetings WHERE id = ?`).run(id);

  sync.applyContent(content, { hash, at: 123, device: "Other Mac", fileId: "f1" });
  const back = sync.meetingContent(id);
  assert.equal(sync.hashOf(back), hash, "same content, so it isn't sent back again");
  assert.equal(back.children.segments.length, 2);
  assert.equal(back.children.action_items[0].text, "Send the draft");
  const row = db.prepare(`SELECT sync_device, sync_hash, sync_file_id FROM meetings WHERE id = ?`).get(id);
  assert.deepEqual(row, { sync_device: "Other Mac", sync_hash: hash, sync_file_id: "f1" });
});

test("the hash ignores key order, which differs between databases", () => {
  assert.equal(sync.hashOf({ a: 1, b: [{ x: 1, y: 2 }] }), sync.hashOf({ b: [{ y: 2, x: 1 }], a: 1 }));
});

test("an edit from another computer replaces the text but keeps audio recorded here", () => {
  const id = meeting();
  db.prepare(`INSERT INTO audio_tracks (meeting_id, track, file, offset_ms, bytes) VALUES (?, 'tab', '/tmp/x.webm', 0, 10)`).run(id);
  const content = JSON.parse(JSON.stringify(sync.meetingContent(id)));
  content.meeting.title = "Budget review (renamed)";
  content.children.segments[1].text = "Yes, budget first.";
  sync.applyContent(content, { hash: sync.hashOf(content), at: 9, device: "Other Mac", fileId: "f2" });
  assert.equal(db.prepare(`SELECT title FROM meetings WHERE id = ?`).get(id).title, "Budget review (renamed)");
  assert.equal(db.prepare(`SELECT text FROM segments WHERE meeting_id = ? AND seq = 1`).get(id).text, "Yes, budget first.");
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM audio_tracks WHERE meeting_id = ?`).get(id).n, 1);
});

test("meetings are found by transcript search after arriving", () => {
  const id = meeting();
  const content = JSON.parse(JSON.stringify(sync.meetingContent(id)));
  db.prepare(`DELETE FROM meetings WHERE id = ?`).run(id);
  sync.applyContent(content, { hash: "h", at: 1, device: "Other Mac", fileId: "f3" });
  const hit = db.prepare(`SELECT meeting_id FROM segments_fts WHERE segments_fts MATCH 'budget'`).all().map((r) => r.meeting_id);
  assert.ok(hit.includes(id));
});
