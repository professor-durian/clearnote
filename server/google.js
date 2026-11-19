// Google Calendar: OAuth and event sync.
//
// Read-only on a single scope. Tokens live in the local SQLite file alongside
// the transcripts; the refresh token is what matters, so treat that file as a
// secret once the calendar is connected.
//
// Raw fetch rather than googleapis: two endpoints and a token refresh do not
// justify the dependency.
import { db } from "./db.js";
import * as config from "./config.js";
import { eventConferenceCodes } from "./matching.js";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const CALENDAR = "https://www.googleapis.com/calendar/v3";

// Read events only. Nothing here ever writes to a calendar. drive.file lets
// ClearNote create and update only the files and folders it made itself (meeting
// notes and audio); it cannot see anything else in your Drive.
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
// Lets ClearNote list your calendars (names only) so you can choose which to read.
export const CALENDAR_LIST_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const SCOPE = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  CALENDAR_LIST_SCOPE,
  "https://www.googleapis.com/auth/userinfo.email",
  DRIVE_SCOPE,
].join(" ");

// Pasted in the dashboard's Settings, or set in the environment.
const clientId = () => config.get("googleClientId");
const clientSecret = () => config.get("googleClientSecret");
export const redirectUri = () =>
  process.env.GOOGLE_REDIRECT_URI ||
  `http://localhost:${process.env.PORT || 8787}/api/google/callback`;

export function googleConfigured() {
  return !!(clientId() && clientSecret());
}

// ------------------------------------------------------------------ account

function account() {
  return db.prepare(`SELECT * FROM google_account WHERE id = 1`).get() || null;
}

export function connectionStatus() {
  const a = account();
  return {
    configured: googleConfigured(),
    connected: !!a?.refresh_token,
    // Connections made before Drive saving existed need to reconnect once.
    drive: !!a?.refresh_token && String(a?.scope || "").includes(DRIVE_SCOPE),
    calendarList: !!a?.refresh_token && String(a?.scope || "").includes(CALENDAR_LIST_SCOPE),
    email: a?.email ?? null,
    lastSyncAt: a?.last_sync_at ?? null,
    eventCount: db.prepare(`SELECT COUNT(*) n FROM calendar_events`).get().n,
  };
}

function saveTokens({ access_token, refresh_token, expires_in, scope }, email) {
  const prev = account();
  db.prepare(
    `INSERT INTO google_account (id, email, access_token, refresh_token, expires_at, scope, connected_at)
     VALUES (1, @email, @access, @refresh, @expires, @scope, @now)
     ON CONFLICT(id) DO UPDATE SET
       email = COALESCE(@email, email),
       access_token = @access,
       -- Google only returns a refresh token on the first consent.
       refresh_token = COALESCE(@refresh, refresh_token),
       expires_at = @expires,
       scope = @scope`,
  ).run({
    email: email ?? prev?.email ?? null,
    access: access_token,
    refresh: refresh_token ?? null,
    expires: Date.now() + (expires_in ?? 3600) * 1000,
    scope: scope ?? SCOPE,
    now: Date.now(),
  });
}

export function disconnect() {
  db.prepare(`DELETE FROM google_account WHERE id = 1`).run();
  db.prepare(`DELETE FROM calendar_events`).run();
  db.prepare(`UPDATE meetings SET calendar_event_id = NULL, match_confidence = NULL, matched_by = NULL`).run();
}

// -------------------------------------------------------------------- OAuth

export function authUrl(state) {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPE,
    // offline + consent so a refresh token comes back even on a re-connect.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH}?${params}`;
}

async function postForm(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `google: ${json.error_description || json.error || res.status}` +
        (json.error === "invalid_grant" ? " (the connection was revoked — reconnect)" : ""),
    );
  }
  return json;
}

export async function exchangeCode(code) {
  const tokens = await postForm(TOKEN, {
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });

  let email = null;
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (res.ok) email = (await res.json()).email;
  } catch {
    // The email is only a label; a failure here does not break the connection.
  }

  saveTokens(tokens, email);
  return email;
}

/** A valid access token, refreshed when it is close to expiring. */
export async function accessToken() {
  const a = account();
  if (!a?.refresh_token) throw new Error("Google Calendar is not connected");
  if (a.access_token && a.expires_at > Date.now() + 60000) return a.access_token;

  const tokens = await postForm(TOKEN, {
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: a.refresh_token,
    grant_type: "refresh_token",
  });
  saveTokens(tokens, a.email);
  return tokens.access_token;
}

async function api(path, params) {
  const token = await accessToken();
  const url = `${CALENDAR}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`google calendar ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// --------------------------------------------------------------------- sync

const upsertEvent = db.prepare(
  `INSERT INTO calendar_events
     (id, calendar_id, title, description, location, start_at, end_at, organizer,
      conference_codes, html_link, status, synced_at)
   VALUES (@id, @calendar_id, @title, @description, @location, @start_at, @end_at,
           @organizer, @conference_codes, @html_link, @status, @synced_at)
   ON CONFLICT(id) DO UPDATE SET
     title = excluded.title, description = excluded.description, location = excluded.location,
     start_at = excluded.start_at, end_at = excluded.end_at, organizer = excluded.organizer,
     conference_codes = excluded.conference_codes, html_link = excluded.html_link,
     status = excluded.status, synced_at = excluded.synced_at`,
);
const clearAttendees = db.prepare(`DELETE FROM event_attendees WHERE event_id = ?`);
const insertAttendee = db.prepare(
  `INSERT OR REPLACE INTO event_attendees (event_id, email, name, organizer, response)
   VALUES (?, ?, ?, ?, ?)`,
);

const storeEvents = db.transaction((events, calendarId) => {
  for (const ev of events) {
    // All-day entries ("out of office", "holiday") are not meetings.
    if (!ev.start?.dateTime || !ev.end?.dateTime) continue;

    upsertEvent.run({
      id: ev.id,
      calendar_id: calendarId,
      title: ev.summary || "(no title)",
      description: ev.description || null,
      location: ev.location || null,
      start_at: Date.parse(ev.start.dateTime),
      end_at: Date.parse(ev.end.dateTime),
      organizer: ev.organizer?.email || null,
      conference_codes: JSON.stringify(eventConferenceCodes(ev)),
      html_link: ev.htmlLink || null,
      status: ev.status || "confirmed",
      synced_at: Date.now(),
    });

    clearAttendees.run(ev.id);
    for (const at of ev.attendees || []) {
      if (at.resource) continue; // meeting rooms are not people
      insertAttendee.run(
        ev.id,
        (at.email || "").toLowerCase(),
        at.displayName || null,
        at.organizer ? 1 : 0,
        at.responseStatus || null,
      );
    }
    // A solo event has no attendee list; the organizer is still a participant.
    if (!(ev.attendees || []).length && ev.organizer?.email) {
      insertAttendee.run(ev.id, ev.organizer.email.toLowerCase(), ev.organizer.displayName || null, 1, "accepted");
    }
  }
});

/**
 * Pull events in a window around now. Defaults cover yesterday through next
 * week, which is enough to match anything just captured and to show what is
 * coming up.
 */
/** The calendars chosen in Settings (your main calendar unless you pick others). */
export function selectedCalendars() {
  try {
    const ids = JSON.parse(config.get("calendarIds"));
    if (Array.isArray(ids) && ids.length) return ids.map(String);
  } catch {
    /* fall through */
  }
  return ["primary"];
}

/** Your calendars, for choosing which ClearNote reads. */
export async function listCalendars() {
  const out = [];
  let pageToken;
  do {
    const page = await api("/users/me/calendarList", { maxResults: "250", ...(pageToken ? { pageToken } : {}) });
    for (const c of page.items || []) {
      out.push({
        id: c.id,
        name: c.summaryOverride || c.summary || c.id,
        primary: !!c.primary,
        owner: c.accessRole === "owner",
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  // Main calendar first, then your own, then the rest, each alphabetically.
  return out.sort((a, b) => b.primary - a.primary || b.owner - a.owner || a.name.localeCompare(b.name));
}

export async function syncEvents({ daysBack = 2, daysForward = 7 } = {}) {
  const timeMin = new Date(Date.now() - daysBack * 864e5).toISOString();
  const timeMax = new Date(Date.now() + daysForward * 864e5).toISOString();
  const calendars = selectedCalendars();

  let fetched = 0;
  for (const calendarId of calendars) {
    let pageToken;
    do {
      const page = await api(`/calendars/${encodeURIComponent(calendarId)}/events`, {
        timeMin,
        timeMax,
        singleEvents: "true", // expand recurring series into instances
        orderBy: "startTime",
        maxResults: "250",
        ...(pageToken ? { pageToken } : {}),
      });
      storeEvents(page.items || [], calendarId);
      fetched += (page.items || []).length;
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  // Events from calendars you have since unticked are dropped.
  const keep = calendars.map(() => "?").join(",");
  const stale = db.prepare(`SELECT id FROM calendar_events WHERE calendar_id NOT IN (${keep})`).all(...calendars);
  for (const { id } of stale) {
    db.prepare(`DELETE FROM event_attendees WHERE event_id = ?`).run(id);
    db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(id);
  }

  db.prepare(`UPDATE google_account SET last_sync_at = ? WHERE id = 1`).run(Date.now());

  // Drop events that have fallen out of the window, so the table does not grow
  // forever and stale instances cannot win a match.
  db.prepare(`DELETE FROM calendar_events WHERE end_at < ?`).run(Date.now() - 30 * 864e5);
  return { fetched, ...connectionStatus() };
}
