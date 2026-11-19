import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "clearnote-rules-"));
process.env.CLEARNOTE_DB = path.join(dir, "t.db");
process.env.CLEARNOTE_SETTINGS = path.join(dir, "settings.json");
const { db } = await import("../db.js");
const config = await import("../config.js");
const rules = await import("../rules.js");

db.prepare(`INSERT OR REPLACE INTO google_account (id, email, refresh_token, connected_at) VALUES (1, 'me@acme.com', 'x', 0)`).run();
const now = Date.now();
const ev = (id, organizer, code) =>
  db.prepare(`INSERT INTO calendar_events (id, calendar_id, title, start_at, end_at, organizer, conference_codes, synced_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, 0)`)
    .run(id, id, now - 600e3, now + 1800e3, organizer, JSON.stringify([code]));
ev("mine", "me@acme.com", "meet:aaa-bbbb-ccc");
ev("theirs", "boss@other.com", "meet:ddd-eeee-fff");

test("a Meet I host is left alone", () => {
  const r = rules.evaluate({ url: "https://meet.google.com/aaa-bbbb-ccc", platform: "google_meet", meetingKey: "aaa-bbbb-ccc" });
  assert.equal(r.host, "me");
  assert.equal(r.rule.id, "host-meet");
  assert.equal(r.actions.captions, "off");
  assert.equal(r.actions.summary, false);
});

test("someone else's call is captured", () => {
  const r = rules.evaluate({ url: "https://meet.google.com/ddd-eeee-fff", platform: "google_meet", meetingKey: "ddd-eeee-fff" });
  assert.equal(r.host, "others");
  assert.equal(r.actions.captions, "auto");
});

test("a call not on the calendar is host unknown", () => {
  const r = rules.evaluate({ url: "https://meet.google.com/zzz-yyyy-xxx", platform: "google_meet", meetingKey: "zzz-yyyy-xxx" });
  assert.equal(r.host, "unknown");
  assert.equal(r.rule.id, "unknown-calls");
});

test("YouTube waits for a click; other sites offer audio", () => {
  assert.equal(rules.evaluate({ url: "https://www.youtube.com/watch?v=abc" }).actions.captions, "click");
  const other = rules.evaluate({ url: "https://webinar.example.com/live" });
  assert.equal(other.rule.id, "anywhere");
  assert.equal(other.actions.audio, "click");
});

test("your own rules, in order, with domains", () => {
  const list = [
    { name: "Webinars", match: { site: "domains", domains: "webinar.example.com, https://events.acme.com/x" }, actions: { captions: "off", panel: "hidden", audio: "click", summary: true, saveNotes: true, saveAudio: false } },
    ...rules.DEFAULT_RULES,
  ];
  config.update({ rules: rules.normaliseRules(list) });
  const r = rules.evaluate({ url: "https://sub.events.acme.com/live" });
  assert.equal(r.rule.name, "Webinars");
  assert.equal(r.actions.saveAudio, false);
  assert.deepEqual(rules.getRules()[0].match.domains, ["webinar.example.com", "events.acme.com"]);
  config.update({ rules: "" });
  assert.equal(rules.getRules()[0].id, "host-meet");
});
