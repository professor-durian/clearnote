// Rules: what ClearNote does in each situation. Checked in order; the first
// rule that matches decides. Edited in Settings › Rules.
//
// A situation is a site (Google Meet, Zoom, Teams, YouTube, a domain you list,
// or anywhere) and, for calls, who hosts: you, someone else, or unknown. The
// host comes from your calendar: the event whose meeting link matches the call
// says who organised it.

import { db } from "./db.js";
import * as config from "./config.js";
import { meetingCodeFromUrl } from "./matching.js";

export const SITES = ["calls", "meet", "zoom", "teams", "youtube", "domains", "any"];
export const HOSTS = ["any", "me", "others", "unknown"];

const PLATFORM_SITE = { google_meet: "meet", meet: "meet", zoom: "zoom", teams: "teams", youtube: "youtube" };
const CALL_SITES = new Set(["meet", "zoom", "teams"]);

export const DEFAULT_RULES = [
  {
    id: "host-meet",
    name: "Google Meet calls I host",
    match: { site: "meet", host: "me", domains: [] },
    actions: { captions: "off", panel: "hidden", audio: "click", summary: false, saveNotes: false, saveAudio: true },
  },
  {
    id: "others-calls",
    name: "Calls someone else hosts",
    match: { site: "calls", host: "others", domains: [] },
    actions: { captions: "auto", panel: "compact", audio: "click", summary: true, saveNotes: true, saveAudio: true },
  },
  {
    id: "unknown-calls",
    name: "Calls not on my calendar",
    match: { site: "calls", host: "unknown", domains: [] },
    actions: { captions: "auto", panel: "compact", audio: "click", summary: true, saveNotes: true, saveAudio: true },
  },
  {
    id: "youtube",
    name: "YouTube",
    match: { site: "youtube", host: "any", domains: [] },
    actions: { captions: "click", panel: "hidden", audio: "off", summary: true, saveNotes: true, saveAudio: true },
  },
  {
    id: "anywhere",
    name: "Anywhere else",
    match: { site: "any", host: "any", domains: [] },
    actions: { captions: "off", panel: "hidden", audio: "click", summary: true, saveNotes: true, saveAudio: true },
  },
];

/** What happens when no rule matches at all (a list with no catch-all). */
const FALLBACK = { captions: "off", panel: "hidden", audio: "click", summary: true, saveNotes: true, saveAudio: true };

const ACTION_VALUES = {
  captions: ["auto", "click", "off"],
  panel: ["full", "compact", "hidden"],
  audio: ["click", "off"],
};

/** Clean up a rule list from the settings page. */
export function normaliseRules(list) {
  if (!Array.isArray(list)) return DEFAULT_RULES;
  return list.slice(0, 50).map((r, i) => {
    const m = r.match || {};
    const a = r.actions || {};
    const pick = (k, v) => (ACTION_VALUES[k].includes(v) ? v : FALLBACK[k]);
    return {
      id: String(r.id || `rule-${Date.now()}-${i}`).slice(0, 60),
      name: String(r.name || "Untitled rule").slice(0, 80),
      match: {
        site: SITES.includes(m.site) ? m.site : "any",
        host: HOSTS.includes(m.host) ? m.host : "any",
        domains: (Array.isArray(m.domains) ? m.domains : String(m.domains || "").split(/[,\s]+/))
          .map((d) => String(d).toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
          .filter(Boolean)
          .slice(0, 30),
      },
      actions: {
        captions: pick("captions", a.captions),
        panel: pick("panel", a.panel),
        audio: pick("audio", a.audio),
        summary: a.summary !== false,
        saveNotes: a.saveNotes !== false,
        saveAudio: a.saveAudio !== false,
      },
    };
  });
}

export function getRules() {
  try {
    return normaliseRules(JSON.parse(config.get("rules")));
  } catch {
    return DEFAULT_RULES;
  }
}

function siteOf({ platform, url }) {
  if (PLATFORM_SITE[platform]) return PLATFORM_SITE[platform];
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "meet.google.com") return "meet";
    if (/(^|\.)zoom\.us$/.test(host)) return "zoom";
    if (/teams\.(microsoft|live)\.com$/.test(host)) return "teams";
    if (/(^|\.)youtube\.com$/.test(host) || host === "youtu.be") return "youtube";
  } catch {
    /* not a URL */
  }
  return "other";
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Your email addresses: the connected Google account, plus any you added. */
function myEmails() {
  const acct = db.prepare(`SELECT email FROM google_account WHERE id = 1`).get()?.email;
  return new Set([acct].filter(Boolean).map((e) => e.toLowerCase()));
}

/**
 * Who hosts this call: "me", "others" or "unknown", from the calendar event
 * whose meeting link matches the call's code, around now.
 */
export function hostFor({ url = "", platform = "", meetingKey = "", at = Date.now() }) {
  const code = meetingCodeFromUrl(url, platform) || meetingCodeFromUrl(meetingKey, platform);
  if (!code) return { host: "unknown", event: null };
  const events = db
    .prepare(
      `SELECT id, title, organizer, conference_codes FROM calendar_events
        WHERE start_at < ? AND end_at > ? AND conference_codes LIKE ?`,
    )
    .all(at + 12 * 3600e3, at - 12 * 3600e3, `%${code}%`)
    .filter((e) => {
      try {
        return JSON.parse(e.conference_codes || "[]").map((c) => String(c).toLowerCase()).includes(code);
      } catch {
        return false;
      }
    });
  if (!events.length) return { host: "unknown", event: null };
  const mine = myEmails();
  const ev = events[0];
  return { host: ev.organizer && mine.has(ev.organizer.toLowerCase()) ? "me" : "others", event: { id: ev.id, title: ev.title } };
}

function matches(rule, site, host, hostname) {
  const s = rule.match.site;
  const siteOk =
    s === "any" ||
    s === site ||
    (s === "calls" && CALL_SITES.has(site)) ||
    (s === "domains" && rule.match.domains.some((d) => hostname === d || hostname.endsWith(`.${d}`)));
  if (!siteOk) return false;
  return rule.match.host === "any" || rule.match.host === host;
}

/** Decide what to do for a page. */
export function evaluate({ url = "", platform = "", meetingKey = "", at = Date.now() } = {}) {
  const site = siteOf({ platform, url });
  const isCall = CALL_SITES.has(site);
  const { host, event } = isCall ? hostFor({ url, platform, meetingKey, at }) : { host: "unknown", event: null };
  const hostname = hostOf(url);
  const rule = getRules().find((r) => matches(r, site, isCall ? host : "unknown", hostname));
  return {
    site,
    host: isCall ? host : null,
    event,
    rule: rule ? { id: rule.id, name: rule.name } : null,
    actions: rule ? rule.actions : FALLBACK,
  };
}

/** The rule decision stored with a meeting, if any. */
export function meetingRule(meeting) {
  if (!meeting?.rule_json) return null;
  try {
    return JSON.parse(meeting.rule_json);
  } catch {
    return null;
  }
}

{
  const cols = db.prepare(`PRAGMA table_info(meetings)`).all().map((c) => c.name);
  if (!cols.includes("rule_json")) db.exec(`ALTER TABLE meetings ADD COLUMN rule_json TEXT`);
}
