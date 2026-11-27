// Deciding which calendar event a captured meeting belongs to.
//
// Three signals, in descending order of how much they are worth:
//
//   link   the event carries the same conference code we were in. This is an
//          identity match, not a guess — nothing else gives that.
//   time   the meeting overlapped the event's slot.
//   title  the meeting title resembles the event's.
//
// Time alone is weak: back-to-back calls overlap, and people run over. So a
// time-only match is only offered when exactly one event is in the frame, and
// it is recorded as a guess the user can override.
//
// Everything here is pure — no database, no network — so the rules can be
// tested against the awkward cases directly.

/** Pull the conference code out of a meeting URL. */
export function meetingCodeFromUrl(url, platform) {
  if (!url) return null;
  const s = String(url);

  // Meet serves calls at /abc-defg-hij and at /meet/abc-defg-hij, so allow
  // intervening path segments rather than anchoring to the host.
  const meet = s.match(/meet\.google\.com\/(?:[\w-]+\/)*([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i);
  if (meet) return `meet:${meet[1].toLowerCase()}`;

  const zoom = s.match(/zoom\.us\/(?:j|wc|s)\/(\d{9,12})/i);
  if (zoom) return `zoom:${zoom[1]}`;

  const teams = s.match(/teams\.(?:microsoft|live)\.com\/.*?(19[:%]3a[^/?#"']+)/i);
  if (teams) return `teams:${decodeURIComponent(teams[1]).toLowerCase()}`;

  // A meeting key the extension already built (e.g. "meet:abc-defg-hij").
  const key = s.match(/^(meet|zoom|teams):(.+)$/i);
  if (key) return `${key[1].toLowerCase()}:${key[2].toLowerCase()}`;

  if (platform === "google_meet") {
    const bare = s.match(/\b([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i);
    if (bare) return `meet:${bare[1].toLowerCase()}`;
  }
  return null;
}

/**
 * Every conference code an event mentions. Google puts the link in
 * conferenceData for events it created, and people paste links into the
 * location or the description for everything else.
 */
export function eventConferenceCodes(event) {
  const codes = new Set();
  const add = (v) => {
    const c = meetingCodeFromUrl(v);
    if (c) codes.add(c);
  };

  add(event.hangoutLink);
  add(event.location);
  add(event.description);
  for (const entry of event.conferenceData?.entryPoints || []) {
    add(entry.uri);
    add(entry.label);
  }
  return Array.from(codes);
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "with", "on", "in", "at",
  "call", "meeting", "sync", "weekly", "daily", "monthly", "catch", "up", "chat",
]);

/** Jaccard overlap of meaningful title words, 0..1. */
export function titleSimilarity(a, b) {
  const words = (s) =>
    new Set(
      String(s || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.has(w)),
    );
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

/** Milliseconds the two time ranges share. */
export function overlapMs(meeting, event) {
  const mStart = meeting.started_at;
  // A meeting still in progress is treated as a minute long, so it can match
  // the event it just started inside.
  const mEnd = meeting.ended_at || meeting.started_at + 60000;
  return Math.max(0, Math.min(mEnd, event.end_at) - Math.max(mStart, event.start_at));
}

const NEAR_MS = 30 * 60 * 1000; // people join early and run over

/**
 * Score one candidate. Returns null when the event cannot be the meeting.
 * @returns {{score:number, confidence:"high"|"medium"|"low", matchedBy:string}|null}
 */
export function scoreMatch(meeting, event) {
  if (event.status === "cancelled") return null;

  const overlap = overlapMs(meeting, event);
  const mEnd = meeting.ended_at || meeting.started_at + 60000;
  const near =
    meeting.started_at < event.end_at + NEAR_MS && mEnd > event.start_at - NEAR_MS;

  const code = meetingCodeFromUrl(meeting.url, meeting.platform) ||
    meetingCodeFromUrl(meeting.meeting_key, meeting.platform);
  const codes = event.conference_codes || [];
  const linked = !!code && codes.includes(code);

  // The link is identity. Accept it even when the clock disagrees — someone
  // reusing the room off-schedule is still in that meeting's room.
  if (linked) {
    if (overlap > 0) return { score: 1000 + overlap / 60000, confidence: "high", matchedBy: "link+time" };
    if (near) return { score: 800, confidence: "high", matchedBy: "link" };
    return { score: 500, confidence: "medium", matchedBy: "link-only" };
  }

  if (overlap <= 0) return null;

  const mDuration = Math.max(60000, mEnd - meeting.started_at);
  const eDuration = Math.max(60000, event.end_at - event.start_at);
  const ratio = overlap / Math.min(mDuration, eDuration);
  const title = titleSimilarity(meeting.title, event.title);

  if (ratio >= 0.3 && title >= 0.4) {
    return { score: 300 + ratio * 50 + title * 100, confidence: "medium", matchedBy: "time+title" };
  }
  if (ratio >= 0.5) {
    return { score: 100 + ratio * 50, confidence: "low", matchedBy: "time" };
  }
  return null;
}

/**
 * Choose the event for a meeting.
 * @param {object} meeting
 * @param {object[]} events  candidates, each with conference_codes as an array
 * @returns {{event:object, confidence:string, matchedBy:string, alternatives:object[]}|null}
 */
export function pickMatch(meeting, events) {
  const scored = [];
  for (const event of events) {
    const s = scoreMatch(meeting, event);
    if (s) scored.push({ event, ...s });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];

  // Two events equally plausible on time alone is exactly the back-to-back
  // case. Rather than pick one and be confidently wrong, offer neither and let
  // the dashboard ask.
  if (best.matchedBy === "time" && runnerUp && runnerUp.matchedBy === "time") {
    return {
      event: null,
      confidence: "ambiguous",
      matchedBy: "time",
      alternatives: scored.map((s) => s.event),
    };
  }

  return {
    event: best.event,
    confidence: best.confidence,
    matchedBy: best.matchedBy,
    alternatives: scored.slice(1).map((s) => s.event),
  };
}

/**
 * A calendar title beats "Meet abc-defg-hij", but never beats a title someone
 * typed themselves.
 */
export function shouldAdoptTitle(meeting, event) {
  if (!event?.title) return false;
  if (!meeting.title_is_generic) return false;
  return event.title.trim() !== meeting.title?.trim();
}

/** Platform display names and calendar display names rarely match exactly. */
export function normalizePerson(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "") // "Ada Lovelace (she/her)"
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Line the people who spoke up against the people who were invited.
 * @param {string[]} speakers  names detected in the captions
 * @param {{email:string,name:string,organizer:number,response:string}[]} attendees
 */
/**
 * Could this email address belong to someone called `name`? Calendar invites
 * often carry only the address, and companies build it from the name in a few
 * standard ways: gina.kopf, ginakopf, gkopf, ginak, kopf, gk.
 */
export function emailFitsName(email, name) {
  const local = String(email || "").toLowerCase().split("@")[0].replace(/[^a-z]/g, "");
  const parts = normalizePerson(name).split(" ").map((w) => w.replace(/[^a-z]/g, "")).filter(Boolean);
  if (!local || parts.length < 2) return false;
  const first = parts[0];
  const last = parts[parts.length - 1];
  const forms = [first + last, last + first, first[0] + last, first + last[0], parts.map((w) => w[0]).join("")];
  if (last.length > 3) forms.push(last);
  return forms.includes(local);
}

export function reconcileParticipants(speakers, attendees, { mine = [] } = {}) {
  const used = new Set();
  const spoke = [];

  for (const speaker of speakers) {
    const norm = normalizePerson(speaker);
    let match = attendees.find((a) => !used.has(a.email) && normalizePerson(a.name) === norm);

    if (!match) {
      // Fall back to the first name, which is how most people appear in calls.
      const first = norm.split(" ")[0];
      match = attendees.find(
        (a) =>
          !used.has(a.email) &&
          first.length > 2 &&
          (normalizePerson(a.name).split(" ")[0] === first ||
            a.email.toLowerCase().startsWith(`${first}.`) ||
            a.email.toLowerCase().startsWith(`${first}@`)),
      );
    }

    if (!match) {
      // An address made from the name: gkopf@ for "Gina Kopf".
      match = attendees.find((a) => !used.has(a.email) && !a.name && emailFitsName(a.email, speaker));
    }

    if (match) used.add(match.email);
    spoke.push({ speaker, email: match?.email ?? null, name: match?.name || speaker });
  }

  // By elimination: one named speaker and one invitee left over, and the
  // invite gave no name to contradict it, are the same person.
  const loose = spoke.filter((s) => !s.email && !/^(unknown|you\b|me\b)/i.test(s.speaker));
  const self = new Set(mine.map((e) => String(e).toLowerCase()));
  const left = attendees.filter((a) => !used.has(a.email) && !a.organizer && !self.has(String(a.email).toLowerCase()));
  if (loose.length === 1 && left.length === 1 && !left[0].name) {
    loose[0].email = left[0].email;
    used.add(left[0].email);
  }

  return {
    spoke,
    silent: attendees.filter((a) => !used.has(a.email)),
  };
}
