// One place for every setting, editable from the dashboard's Settings page.
//
// Stored in ~/.clearnote/settings.json, readable only by you (mode 600), never
// inside the project folder. Environment variables still win when set, so an
// existing ~/.clearnote.env keeps working.
//
// Secrets (API keys, the Google client secret) are write-only from the
// dashboard: the API reports whether one is set and its last four characters,
// never the value.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = process.env.CLEARNOTE_SETTINGS || path.join(os.homedir(), ".clearnote", "settings.json");

/** key -> { env, secret, default } */
export const FIELDS = {
  // capture (read by the extension)
  displayName: { default: "" },
  autoCapture: { default: true },
  hideCaptions: { default: true },
  recordMic: { default: true },
  panelMode: { default: "compact" }, // in-call panel: "full" | "compact" | "hidden"
  debug: { default: false },
  // AI
  aiPrimary: { default: "anthropic" }, // "anthropic" | "openrouter"
  aiBackup: { default: true }, // try the other provider if the primary fails
  anthropicKey: { env: "ANTHROPIC_API_KEY", secret: true, default: "" },
  anthropicModel: { env: "CLEARNOTE_MODEL", default: "claude-opus-5-5" },
  openrouterKey: { env: "OPENROUTER_API_KEY", secret: true, default: "" },
  openrouterModel: { env: "OPENROUTER_MODEL", default: "anthropic/claude-opus-5.5" },
  // Saving to Google Drive / this computer
  saveNotes: { default: false }, // a Google Doc per meeting
  notesFolderName: { default: "ClearNote Meeting Notes" },
  notesFolderId: { default: "" }, // set by ClearNote when it creates the folder
  saveAudio: { default: "off" }, // "off" | "drive" | "local"
  audioFolderName: { default: "ClearNote Audio" },
  audioFolderId: { default: "" },
  audioLocalPath: { default: "" },
  // Name templates. Tags: {title} {date} {time} {year} {month} {day} {platform} {people} {part}
  notesDocName: { default: "{title} – {date} {time} – Notes by ClearNote" },
  audioFileName: { default: "{title} – {date} {time} – {part}" },
  tabNotesName: { default: "Notes" },
  tabTranscriptName: { default: "Transcript" },
  partMixed: { default: "mixed" },
  partCall: { default: "call" },
  partMic: { default: "mic" },
  // Google Calendar: which calendars to read, as a JSON list of calendar IDs
  calendarIds: { default: '["primary"]' },
  // Google Calendar
  googleClientId: { env: "GOOGLE_CLIENT_ID", default: "" },
  googleClientSecret: { env: "GOOGLE_CLIENT_SECRET", secret: true, default: "" },
};

export const EXTENSION_FIELDS = ["displayName", "autoCapture", "hideCaptions", "recordMic", "debug", "panelMode"];

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
  } catch (err) {
    console.warn(`[clearnote] could not read ${FILE}: ${err.message}`);
    cache = {};
  }
  return cache;
}

/** Effective value: environment, then the settings file, then the default. */
export function get(key) {
  const f = FIELDS[key];
  if (!f) throw new Error(`unknown setting ${key}`);
  if (f.env && process.env[f.env]) return process.env[f.env];
  const v = load()[key];
  return v === undefined || v === "" ? f.default : v;
}

function coerce(key, value) {
  const d = FIELDS[key].default;
  if (typeof d === "boolean") return value === true || value === "true";
  if (Array.isArray(value)) return JSON.stringify(value.map(String));
  return String(value ?? "").trim();
}

/**
 * Apply a partial update. For secrets, an empty string clears the value and
 * an absent key leaves it unchanged.
 */
export function update(patch = {}) {
  const next = { ...load() };
  for (const [key, value] of Object.entries(patch)) {
    if (!FIELDS[key]) continue;
    next[key] = coerce(key, value);
  }
  if (next.aiPrimary && !["anthropic", "openrouter"].includes(next.aiPrimary)) next.aiPrimary = "anthropic";
  if (next.saveAudio && !["off", "drive", "local"].includes(next.saveAudio)) next.saveAudio = "off";
  if (next.panelMode && !["full", "compact", "hidden"].includes(next.panelMode)) next.panelMode = "compact";
  mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, FILE);
  chmodSync(FILE, 0o600);
  cache = next;
  for (const fn of listeners) fn(Object.keys(patch));
}

const listeners = [];
export function onChange(fn) {
  listeners.push(fn);
}

/** Safe view for the dashboard: secrets reduced to set / last four characters. */
export function publicView() {
  const values = {};
  const secrets = {};
  const locked = []; // set by an environment variable, so not editable here
  for (const [key, f] of Object.entries(FIELDS)) {
    if (f.env && process.env[f.env]) locked.push(key);
    if (f.secret) {
      const v = get(key);
      secrets[key] = { set: !!v, hint: v ? `…${String(v).slice(-4)}` : "" };
    } else {
      values[key] = get(key);
    }
  }
  return { values, secrets, locked, file: FILE };
}

export function extensionView() {
  return Object.fromEntries(EXTENSION_FIELDS.map((k) => [k, get(k)]));
}
