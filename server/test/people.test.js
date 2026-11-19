import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "clearnote-people-"));
process.env.CLEARNOTE_DB = path.join(dir, "t.db");
process.env.CLEARNOTE_SETTINGS = path.join(dir, "settings.json");
const { db, openMeeting, closeMeeting, linkMeetingToEvent } = await import("../db.js");
const config = await import("../config.js");
const people = await import("../people.js");

config.update({ displayName: "Scott" });

function meeting(title, at, speakers, attendees, platform = "google_meet") {
  const id = openMeeting({ meetingKey: `${title}-${at}`, platform, platformLabel: platform, title, url: "", startedAt: at });
  closeMeeting(id, { endedAt: at + 1800e3, speakers });
  if (attendees) {
    const ev = `ev-${title}`;
    db.prepare(`INSERT INTO calendar_events (id, calendar_id, title, start_at, end_at, synced_at) VALUES (?, 'primary', ?, ?, ?, ?)`)
      .run(ev, title, at, at + 1800e3, Date.now());
    for (const a of attendees) {
      db.prepare(`INSERT INTO event_attendees (event_id, email, name, organizer, response) VALUES (?, ?, ?, 0, ?)`).run(ev, a.email, a.name, a.response || "accepted");
    }
    linkMeetingToEvent(id, ev, { confidence: "high", matchedBy: "link" });
  }
  people.syncMeetingPeople(id);
  return id;
}

test("speakers and invitees become people; you are left out", () => {
  meeting("Pricing", 1_000_000, ["Ana Silva", "Ben", "You"], [
    { email: "ana@acme.com", name: "Ana Silva" },
    { email: "ben.ito@acme.com", name: "Benjamin Ito" },
    { email: "cfo@acme.com", name: "Chris Fo", response: "declined" },
  ]);
  const list = people.listPeople();
  const names = list.map((p) => p.name).sort();
  assert.deepEqual(names, ["Ana Silva", "Benjamin Ito", "Chris Fo"]);
  const ben = list.find((p) => p.name === "Benjamin Ito");
  assert.equal(ben.email, "ben.ito@acme.com");
  assert.equal(ben.spoke, 1);
  assert.equal(list.find((p) => p.name === "Chris Fo").spoke, 0);
});

test("a later captions-only call finds the same person by name", () => {
  meeting("Follow-up", 2_000_000, ["Ana Silva"]);
  const ana = people.listPeople().find((p) => p.name === "Ana Silva");
  assert.equal(ana.meetings, 2);
  assert.equal(people.listPeople({ sort: "meetings" })[0].name, "Ana Silva");
});

test("filtering meetings by people needs all of them", () => {
  const ana = people.listPeople().find((p) => p.name === "Ana Silva");
  const ben = people.listPeople().find((p) => p.name === "Benjamin Ito");
  assert.equal(people.meetingsWithPeople([ana.id]).size, 2);
  assert.equal(people.meetingsWithPeople([ana.id, ben.id]).size, 1);
});

test("merging folds meetings and names together", () => {
  meeting("Hallway", 3_000_000, ["Benny"]);
  const benny = people.listPeople().find((p) => p.name === "Benny");
  const ben = people.listPeople().find((p) => p.name === "Benjamin Ito");
  people.mergePeople(benny.id, ben.id);
  const merged = people.getPerson(ben.id);
  assert.equal(merged.meetings.length, 2);
  assert.ok(merged.aliases.includes("benny"));
  // and the next captions-only call as "Benny" lands on Ben
  meeting("Another", 4_000_000, ["Benny"]);
  assert.equal(people.getPerson(ben.id).meetings.length, 3);
});

test("speakers in a YouTube video don't become people", () => {
  meeting("Never Gonna Give You Up", Date.UTC(2026, 10, 19), ["Rick Astley"], null, "youtube");
  assert.ok(!people.listPeople().some((p) => p.name === "Rick Astley"));
});

test("your other email addresses count as you", () => {
  config.update({ otherEmails: "me.personal@example.com, other@example.org" });
  meeting("Weekly sync", Date.UTC(2026, 10, 20), ["Scott", "Dana"], [
    { email: "me.personal@example.com", name: "Scott P" },
    { email: "dana@example.com", name: "Dana" },
  ]);
  const names = people.listPeople().map((p) => p.email);
  assert.ok(!names.includes("me.personal@example.com"));
  assert.ok(names.includes("dana@example.com"));
  config.update({ otherEmails: "" });
});
