// Sync between computers through the user's own Google Drive.
//
// Each computer uploads one small JSON file per finished meeting (transcript,
// summary, next steps, people; never audio) to a "ClearNote sync" folder, and
// pulls in the files the other computers wrote. No server to run: Google
// Drive is the meeting point. Uses the same drive.file permission as saving,
// which lets every ClearNote install on the same Google account (and the same
// Google client ID) see the files ClearNote created.

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { db } from "./db.js";
import * as config from "./config.js";
import { connectionStatus } from "./google.js";
import { DRIVE, UPLOAD, call, subFolder } from "./drive.js";

const FORMAT = 1;
// Child tables copied with a meeting. Their own row ids are local, so dropped.
const CHILDREN = {
  segments: "seq",
  action_items: "id",
  insights: "id",
  tags: "tag",
  participants: "name",
};
const LOCAL_COLS = new Set(["sync_hash", "sync_at", "sync_device", "sync_file_id"]);

const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
for (const [c, def] of [
  ["sync_hash", "TEXT"], // hash of the content last sent or received
  ["sync_at", "INTEGER"], // when that content was written
  ["sync_device", "TEXT"], // the computer that recorded it (null: this one)
  ["sync_file_id", "TEXT"], // its file in Drive
]) {
  if (!cols("meetings").includes(c)) db.exec(`ALTER TABLE meetings ADD COLUMN ${c} ${def}`);
}

const state = { running: false, lastAt: null, error: null, sent: 0, received: 0, removed: 0 };
export const syncState = () => ({ ...state, enabled: syncEnabled(), device: deviceName() });

export function deviceName() {
  const set = config.get("deviceName");
  if (set) return set;
  try {
    return execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim() || os.hostname();
  } catch {
    return os.hostname().replace(/\.local$/, "");
  }
}

function deviceId() {
  let id = config.get("deviceId");
  if (!id) {
    id = randomUUID();
    config.update({ deviceId: id });
  }
  return id;
}

export function syncEnabled() {
  return config.get("syncDrive") !== false && !!connectionStatus().drive;
}

// ------------------------------------------------------------------ content

/** Everything about a meeting that travels: rows, minus local bookkeeping. */
export function meetingContent(id) {
  const m = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(id);
  if (!m) return null;
  const meeting = Object.fromEntries(Object.entries(m).filter(([k]) => !LOCAL_COLS.has(k)));
  const children = {};
  for (const [table, order] of Object.entries(CHILDREN)) {
    children[table] = db
      .prepare(`SELECT * FROM ${table} WHERE meeting_id = ? ORDER BY ${order}`)
      .all(id)
      .map(({ id: _rowId, meeting_id: _m, ...row }) => row);
  }
  const exp = db.prepare(`SELECT notes_doc_id, audio_json, saved_at FROM meeting_exports WHERE meeting_id = ?`).get(id) || null;
  return { meeting, children, exports: exp };
}

// Key order differs between databases (columns added in a different order),
// so hash a canonical form: otherwise two computers would keep re-sending.
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
      : v;
export const hashOf = (content) => createHash("sha256").update(JSON.stringify(canonical(content))).digest("hex").slice(0, 32);

/** Write a meeting received from another computer into this one's database. */
export function applyContent(content, { hash, at, device, fileId }) {
  const { meeting, children, exports: exp } = content;
  const id = meeting.id;
  const mcols = new Set(cols("meetings"));
  const keys = Object.keys(meeting).filter((k) => mcols.has(k) && !LOCAL_COLS.has(k));
  db.transaction(() => {
    const exists = db.prepare(`SELECT 1 FROM meetings WHERE id = ?`).get(id);
    if (exists) {
      // Update in place: deleting the row would also delete any audio kept here.
      db.prepare(`UPDATE meetings SET ${keys.filter((k) => k !== "id").map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`).run(meeting);
    } else {
      db.prepare(`INSERT INTO meetings (${keys.join(", ")}) VALUES (${keys.map((k) => `@${k}`).join(", ")})`).run(
        Object.fromEntries(keys.map((k) => [k, meeting[k]])),
      );
    }
    for (const [table, rows] of Object.entries(children || {})) {
      if (!(table in CHILDREN)) continue;
      const tcols = new Set(cols(table));
      db.prepare(`DELETE FROM ${table} WHERE meeting_id = ?`).run(id);
      for (const row of rows) {
        const r = Object.fromEntries(Object.entries(row).filter(([k]) => tcols.has(k) && k !== "id"));
        r.meeting_id = id;
        const ks = Object.keys(r);
        db.prepare(`INSERT INTO ${table} (${ks.join(", ")}) VALUES (${ks.map((k) => `@${k}`).join(", ")})`).run(r);
      }
    }
    if (exp) {
      db.prepare(
        `INSERT INTO meeting_exports (meeting_id, notes_doc_id, audio_json, saved_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(meeting_id) DO UPDATE SET notes_doc_id = excluded.notes_doc_id, audio_json = excluded.audio_json, saved_at = excluded.saved_at`,
      ).run(id, exp.notes_doc_id, exp.audio_json, exp.saved_at);
    }
    db.prepare(`UPDATE meetings SET sync_hash = ?, sync_at = ?, sync_device = ?, sync_file_id = ? WHERE id = ?`).run(
      hash,
      at,
      device === deviceName() ? null : device,
      fileId,
      id,
    );
  })();
  onReceived(id);
}

let onReceived = () => {};
/** Called with a meeting id after one arrives from another computer. */
export function onMeetingReceived(fn) {
  onReceived = fn;
}

// ------------------------------------------------------------------ Drive

// The "Sync" subfolder of the ClearNote folder, shared by every computer on
// the account. An older top-level "ClearNote sync" folder is moved in.
async function findFolder() {
  const id = await subFolder("sync", { name: "Sync", legacyId: config.get("syncFolderId"), legacyTag: ["clearnoteSync", "1"] });
  if (id !== config.get("syncFolderId")) config.update({ syncFolderId: id });
  return id;
}

async function listRemote(folderId) {
  const out = [];
  let pageToken = "";
  do {
    const q = `'${folderId}' in parents and trashed=false`;
    const r = await (
      await call(
        `${DRIVE}/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=nextPageToken,files(id,name,appProperties)${pageToken ? `&pageToken=${pageToken}` : ""}`,
      )
    ).json();
    out.push(...(r.files || []));
    pageToken = r.nextPageToken || "";
  } while (pageToken);
  return out;
}

async function writeRemote({ fileId, folderId, name, body, props }) {
  const boundary = `cn${randomUUID()}`;
  const meta = fileId ? { appProperties: props } : { name, parents: [folderId], mimeType: "application/json", appProperties: props };
  const payload =
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}\r\n--${boundary}--`;
  const res = await call(
    fileId ? `${UPLOAD}/files/${fileId}?uploadType=multipart&fields=id` : `${UPLOAD}/files?uploadType=multipart&fields=id`,
    { method: fileId ? "PATCH" : "POST", body: payload, raw: true, headers: { "content-type": `multipart/related; boundary=${boundary}` } },
  );
  return (await res.json()).id;
}

const readRemote = async (fileId) => (await call(`${DRIVE}/files/${fileId}?alt=media`)).json();

// ------------------------------------------------------------------ one round

/** Pull what changed elsewhere, then push what changed here. */
export async function syncNow() {
  if (state.running || !syncEnabled()) return syncState();
  state.running = true;
  let sent = 0;
  let received = 0;
  let removed = 0;
  try {
    const me = deviceId();
    const myName = deviceName();
    const folderId = await findFolder();
    const remote = await listRemote(folderId);
    const byMeeting = new Map(remote.map((f) => [f.appProperties?.meeting || f.name.replace(/\.json$/, ""), f]));

    // Pull
    for (const [id, f] of byMeeting) {
      const p = f.appProperties || {};
      const local = db.prepare(`SELECT id, sync_hash, sync_at, ended_at FROM meetings WHERE id = ?`).get(id);
      if (p.deleted === "1") {
        if (local && p.by !== me) {
          db.prepare(`DELETE FROM meetings WHERE id = ?`).run(id);
          onRemoved(id);
          removed++;
        }
        continue;
      }
      if (!p.hash || (local && local.sync_hash === p.hash)) continue;
      if (local) {
        // Changed here too since the last sync? Keep whichever was written last.
        const c = meetingContent(id);
        const localChanged = hashOf(c) !== local.sync_hash;
        if (localChanged && Number(p.at || 0) <= Number(local.sync_at || 0)) continue;
      }
      const doc = await readRemote(f.id);
      if (doc?.format !== FORMAT || !doc.content?.meeting?.id) continue;
      applyContent(doc.content, { hash: p.hash, at: Number(p.at || Date.now()), device: doc.device || p.device || "", fileId: f.id });
      received++;
      console.log(`[clearnote] sync: received ${id} from ${doc.device || "another computer"}`);
    }

    // Push
    const rows = db
      .prepare(`SELECT id, sync_hash, sync_file_id, sync_device FROM meetings WHERE ended_at IS NOT NULL AND status != 'live'`)
      .all();
    for (const r of rows) {
      const content = meetingContent(r.id);
      const hash = hashOf(content);
      if (hash === r.sync_hash) continue;
      const at = Date.now();
      const origin = r.sync_device || myName;
      const fileId = await writeRemote({
        fileId: r.sync_file_id || byMeeting.get(r.id)?.id,
        folderId,
        name: `${r.id}.json`,
        body: { format: FORMAT, device: origin, writtenBy: myName, at, content },
        props: { meeting: r.id, hash, at: String(at), by: me, device: origin.slice(0, 60) },
      });
      db.prepare(`UPDATE meetings SET sync_hash = ?, sync_at = ?, sync_file_id = ? WHERE id = ?`).run(hash, at, fileId, r.id);
      sent++;
      console.log(`[clearnote] sync: sent ${r.id}`);
    }
    Object.assign(state, { lastAt: Date.now(), error: null, sent, received, removed });
  } catch (err) {
    state.error = String(err.message || err).slice(0, 300);
    console.error("[clearnote] sync failed:", state.error);
  } finally {
    state.running = false;
  }
  return syncState();
}

let onRemoved = () => {};
export function onMeetingRemoved(fn) {
  onRemoved = fn;
}

/** A meeting deleted here: tell the other computers. */
export async function markDeleted(meetingId, fileId) {
  if (!fileId || !syncEnabled()) return;
  try {
    await writeRemote({
      fileId,
      body: { format: FORMAT, deleted: true, at: Date.now() },
      props: { meeting: meetingId, deleted: "1", by: deviceId(), at: String(Date.now()), hash: "" },
    });
  } catch (err) {
    console.error("[clearnote] couldn't mark a deleted meeting in Drive:", err.message);
  }
}

let timer = null;
export function startSyncLoop(everyMs = 3 * 60 * 1000) {
  clearInterval(timer);
  setTimeout(() => syncNow().catch(() => {}), 15_000);
  timer = setInterval(() => syncNow().catch(() => {}), everyMs);
}
