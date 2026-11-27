// Matching a captured meeting to a calendar event. These rules decide whose
// name ends up on an action item, so the awkward cases matter more than the
// happy path: back-to-back calls, recurring rooms, people running over, and
// the meeting that was never on the calendar at all.
import test from "node:test";
import assert from "node:assert/strict";
import {
  meetingCodeFromUrl,
  eventConferenceCodes,
  titleSimilarity,
  overlapMs,
  scoreMatch,
  pickMatch,
  shouldAdoptTitle,
  normalizePerson,
  reconcileParticipants,
} from "../matching.js";

const MIN = 60000;
const at = (h, m = 0) => Date.UTC(2026, 9, 27, h, m);

const meeting = (over = {}) => ({
  id: "m1",
  platform: "google_meet",
  title: "Meet abc-defg-hij",
  url: "https://meet.google.com/abc-defg-hij",
  meeting_key: "meet:abc-defg-hij",
  started_at: at(10, 1),
  ended_at: at(10, 48),
  title_is_generic: 1,
  ...over,
});

const event = (over = {}) => ({
  id: "e1",
  title: "Pricing sync",
  start_at: at(10),
  end_at: at(10, 45),
  status: "confirmed",
  conference_codes: ["meet:abc-defg-hij"],
  ...over,
});

// ------------------------------------------------------------ code extraction

test("meeting codes are read out of each platform's URL", () => {
  assert.equal(
    meetingCodeFromUrl("https://meet.google.com/abc-defg-hij"),
    "meet:abc-defg-hij",
  );
  assert.equal(meetingCodeFromUrl("https://us02web.zoom.us/j/98765432109"), "zoom:98765432109");
  assert.equal(meetingCodeFromUrl("https://zoom.us/wc/98765432109/join?pwd=x"), "zoom:98765432109");
  assert.equal(meetingCodeFromUrl("meet:abc-defg-hij"), "meet:abc-defg-hij");
});

test("a code is found in a calendar link wrapped in tracking", () => {
  // Calendar invites routinely rewrite links through a redirector.
  assert.equal(
    meetingCodeFromUrl("https://www.google.com/url?q=https://meet.google.com/abc-defg-hij&sa=D"),
    "meet:abc-defg-hij",
  );
});

test("a URL with no conference code yields nothing", () => {
  assert.equal(meetingCodeFromUrl("https://example.com/standup"), null);
  assert.equal(meetingCodeFromUrl(""), null);
  assert.equal(meetingCodeFromUrl(null), null);
});

test("codes are collected from every place an invite hides them", () => {
  const codes = eventConferenceCodes({
    hangoutLink: "https://meet.google.com/abc-defg-hij",
    location: "https://us02web.zoom.us/j/98765432109",
    description: "Backup line: https://meet.google.com/zzz-zzzz-zzz",
    conferenceData: { entryPoints: [{ uri: "https://meet.google.com/abc-defg-hij" }] },
  });
  assert.ok(codes.includes("meet:abc-defg-hij"));
  assert.ok(codes.includes("zoom:98765432109"));
  assert.ok(codes.includes("meet:zzz-zzzz-zzz"));
  assert.equal(new Set(codes).size, codes.length, "no duplicates");
});

// -------------------------------------------------------------------- timing

test("overlap is the shared time, not the gap", () => {
  assert.equal(overlapMs(meeting(), event()), at(10, 45) - at(10, 1));
  assert.equal(overlapMs(meeting({ started_at: at(12), ended_at: at(13) }), event()), 0);
});

test("a meeting still in progress can still overlap its event", () => {
  const live = meeting({ started_at: at(10, 5), ended_at: null });
  assert.ok(overlapMs(live, event()) > 0);
});

// --------------------------------------------------------------- the signals

test("the conference link is an identity match", () => {
  const m = scoreMatch(meeting(), event());
  assert.equal(m.confidence, "high");
  assert.equal(m.matchedBy, "link+time");
});

test("the link wins even when the room is used off-schedule", () => {
  // Someone reuses the standing room hours later. It is still that meeting's
  // room, and the time signal would say otherwise.
  const late = meeting({ started_at: at(16), ended_at: at(16, 30) });
  const m = scoreMatch(late, event());
  assert.ok(m, "an off-schedule link match is still a match");
  assert.equal(m.matchedBy, "link-only");
  assert.equal(m.confidence, "medium");
});

test("a cancelled event never matches", () => {
  assert.equal(scoreMatch(meeting(), event({ status: "cancelled" })), null);
});

test("an unrelated event at the same time does not match on time alone", () => {
  const other = event({ id: "e2", title: "Dentist", conference_codes: [], start_at: at(10, 30), end_at: at(10, 40) });
  const m = scoreMatch(meeting(), other);
  // It overlaps fully within its own short slot, so it scores — but only "low".
  assert.equal(m?.confidence, "low");
  assert.equal(m?.matchedBy, "time");
});

test("time plus a matching title is better than time alone", () => {
  const m = scoreMatch(
    meeting({ title: "Pricing sync" }),
    event({ conference_codes: [] }),
  );
  assert.equal(m.matchedBy, "time+title");
  assert.equal(m.confidence, "medium");
});

test("a meeting entirely outside the slot does not match without a link", () => {
  const m = scoreMatch(meeting({ started_at: at(14), ended_at: at(15) }), event({ conference_codes: [] }));
  assert.equal(m, null);
});

// --------------------------------------------------------------- picking one

test("the linked event beats a better-timed one", () => {
  const exact = event({ id: "timed", conference_codes: [], start_at: at(10, 1), end_at: at(10, 48), title: "Pricing sync" });
  const linked = event({ id: "linked", start_at: at(9), end_at: at(9, 30) });
  const pick = pickMatch(meeting(), [exact, linked]);
  assert.equal(pick.event.id, "linked");
});

test("back-to-back calls with no link are left for the user to pick", () => {
  // The common failure: two events touching, nothing to tell them apart.
  const a = event({ id: "a", title: "Standup", conference_codes: [], start_at: at(10), end_at: at(10, 30) });
  const b = event({ id: "b", title: "Retro", conference_codes: [], start_at: at(10, 30), end_at: at(11) });
  const pick = pickMatch(meeting({ title: "Meet abc-defg-hij", url: null, meeting_key: null }), [a, b]);
  assert.equal(pick.event, null);
  assert.equal(pick.confidence, "ambiguous");
  assert.equal(pick.alternatives.length, 2, "both are offered as choices");
});

test("an impromptu call matches nothing and says so", () => {
  const pick = pickMatch(
    meeting({ started_at: at(19), ended_at: at(19, 20), url: "https://meet.google.com/qqq-qqqq-qqq", meeting_key: null }),
    [event()],
  );
  assert.equal(pick, null, "not every meeting is on the calendar");
});

test("with no events at all there is no match", () => {
  assert.equal(pickMatch(meeting(), []), null);
});

// ------------------------------------------------------------------- titles

test("a calendar title replaces a platform-generated one", () => {
  assert.equal(shouldAdoptTitle(meeting(), event()), true);
});

test("a title someone typed is never overwritten", () => {
  const mine = meeting({ title: "Pricing — my notes", title_is_generic: 0 });
  assert.equal(shouldAdoptTitle(mine, event()), false);
});

test("title similarity ignores filler words", () => {
  assert.ok(titleSimilarity("Weekly pricing sync", "Pricing sync") > 0.6);
  assert.equal(titleSimilarity("Pricing sync", "Dentist appointment"), 0);
});

// ------------------------------------------------------------- participants

test("speaker names are reconciled with invitees", () => {
  const attendees = [
    { email: "ada@example.com", name: "Ada Lovelace", organizer: 1, response: "accepted" },
    { email: "grace@example.com", name: "Grace Hopper", organizer: 0, response: "accepted" },
    { email: "marcus@example.com", name: "Marcus Chen", organizer: 0, response: "accepted" },
  ];
  const { spoke, silent } = reconcileParticipants(["Ada Lovelace", "Grace Hopper"], attendees);
  assert.deepEqual(
    spoke.map((s) => s.email),
    ["ada@example.com", "grace@example.com"],
  );
  assert.deepEqual(
    silent.map((s) => s.email),
    ["marcus@example.com"],
    "someone invited who never spoke is worth knowing about",
  );
});

test("a display name with pronouns still matches its invitee", () => {
  const attendees = [{ email: "ada@example.com", name: "Ada Lovelace", organizer: 1 }];
  const { spoke } = reconcileParticipants(["Ada Lovelace (she/her)"], attendees);
  assert.equal(spoke[0].email, "ada@example.com");
});

test("a first-name-only speaker matches by email prefix", () => {
  const attendees = [{ email: "marcus@example.com", name: null, organizer: 0 }];
  const { spoke } = reconcileParticipants(["Marcus"], attendees);
  assert.equal(spoke[0].email, "marcus@example.com");
});

test("a speaker who is not an invitee is kept, not dropped", () => {
  // Someone forwards an invite and joins anyway; they still spoke.
  const attendees = [{ email: "ada@example.com", name: "Ada Lovelace", organizer: 1 }];
  const { spoke } = reconcileParticipants(["Ada Lovelace", "Unexpected Guest"], attendees);
  assert.equal(spoke.length, 2);
  assert.equal(spoke[1].email, null);
  assert.equal(spoke[1].name, "Unexpected Guest");
});

test("two people are not matched to the same invitee", () => {
  const attendees = [
    { email: "ada@example.com", name: "Ada Lovelace", organizer: 1 },
    { email: "ada.s@example.com", name: "Ada Smith", organizer: 0 },
  ];
  const { spoke } = reconcileParticipants(["Ada Lovelace", "Ada Smith"], attendees);
  assert.deepEqual(
    spoke.map((s) => s.email),
    ["ada@example.com", "ada.s@example.com"],
  );
});

test("person names normalise away decoration", () => {
  assert.equal(normalizePerson("Ada Lovelace (she/her)"), "ada lovelace");
  assert.equal(normalizePerson("  O'Neill,  Ada "), "o neill ada");
});

test("a Meet link under the /meet/ path still yields its code", () => {
  // The shape a live call actually used; the old pattern anchored to the host
  // and missed it, which would silently break calendar matching.
  assert.equal(
    meetingCodeFromUrl("https://meet.google.com/meet/aka-gsvq-fjh"),
    "meet:aka-gsvq-fjh",
  );
  assert.equal(
    meetingCodeFromUrl("https://meet.google.com/meet/abc-defg-hij?authuser=1"),
    "meet:abc-defg-hij",
  );
});

test("an invite address made from the name matches the speaker", async () => {
  const { emailFitsName, reconcileParticipants } = await import("../matching.js");
  assert.equal(emailFitsName("gkopf@mis-solutions.com", "Gina Kopf"), true);
  assert.equal(emailFitsName("mt@matteotrovato.com", "Matteo Trovato"), true);
  assert.equal(emailFitsName("taylorgoetz@hatchline.com", "Taylor Goetz"), true);
  assert.equal(emailFitsName("gkopf@mis-solutions.com", "Lance Lyle"), false);
  const r = reconcileParticipants(["Gina Kopf", "Lance Lyle"], [
    { email: "gkopf@mis-solutions.com", name: null },
    { email: "llyle@mis-solutions.com", name: null },
  ]);
  assert.deepEqual(r.spoke.map((s) => s.email), ["gkopf@mis-solutions.com", "llyle@mis-solutions.com"]);
  assert.equal(r.silent.length, 0);
});

test("pairing by elimination never uses one of your own addresses", async () => {
  const { reconcileParticipants } = await import("../matching.js");
  const r = reconcileParticipants(["Dana"], [{ email: "me.personal@example.com", name: null }], { mine: ["me.personal@example.com"] });
  assert.equal(r.spoke[0].email, null);
});
