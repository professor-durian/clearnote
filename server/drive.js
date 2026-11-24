// Google Drive and Docs, through the same Google connection as the calendar.
// Uses the drive.file permission: ClearNote sees only what it created.

import { readFileSync } from "node:fs";
import { accessToken } from "./google.js";
import * as config from "./config.js";

export const DRIVE = "https://www.googleapis.com/drive/v3";
export const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const DOCS = "https://docs.googleapis.com/v1/documents";
const FOLDER = "application/vnd.google-apps.folder";
const GDOC = "application/vnd.google-apps.document";

export async function call(url, { method = "GET", body, headers = {}, raw = false } = {}) {
  const token = await accessToken();
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body && !raw ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = text.slice(0, 300);
    try {
      msg = JSON.parse(text).error?.message || msg;
    } catch {
      /* not JSON */
    }
    const err = new Error(`google ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

const json = async (...a) => (await call(...a)).json();

export const fileUrl = (id) => `https://drive.google.com/file/d/${id}/view`;
export const docUrl = (id) => `https://docs.google.com/document/d/${id}/edit`;
export const folderUrl = (id) => `https://drive.google.com/drive/folders/${id}`;

/** Still there and not in the bin? */
async function alive(id) {
  if (!id) return false;
  try {
    const f = await json(`${DRIVE}/files/${id}?fields=id,trashed`);
    return !f.trashed;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

/*
 * One ClearNote folder in My Drive: notes Docs at the top, audio in an
 * "Audio" subfolder, sync data in a "Sync" subfolder. Each folder carries a
 * hidden role tag, so every computer on the account finds the same ones. You
 * can rename or move them in Drive; ClearNote keeps using them by ID and tag.
 * Folders made by older versions (three side by side) are moved in and
 * renamed the first time they're used.
 */
const ROLE = "clearnoteRole";

async function folderInfo(id) {
  if (!id) return null;
  try {
    const f = await json(`${DRIVE}/files/${id}?fields=id,trashed,parents,appProperties`);
    return f.trashed ? null : f;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function findByRole(role, parentId) {
  const q = [
    `mimeType='${FOLDER}'`,
    "trashed=false",
    `appProperties has { key='${ROLE}' and value='${role}' }`,
    parentId ? `'${parentId}' in parents` : null,
  ]
    .filter(Boolean)
    .join(" and ");
  const r = await json(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive&orderBy=createdTime`);
  return r.files?.[0]?.id || null;
}

/** Tag an older folder with its role, put it under `parentId` and give it `name`. */
async function adopt(f, role, { parentId, name }) {
  const from = (f.parents || []).filter((p) => p !== parentId).join(",");
  const move = parentId && !(f.parents || []).includes(parentId) ? `&addParents=${parentId}${from ? `&removeParents=${from}` : ""}` : "";
  await call(`${DRIVE}/files/${f.id}?fields=id${move}`, { method: "PATCH", body: { appProperties: { [ROLE]: role }, ...(name ? { name } : {}) } });
  return f.id;
}

/** The main ClearNote folder (notes live here). */
export async function mainFolder() {
  let id = await findByRole("main");
  if (!id) {
    const old = await folderInfo(config.get("notesFolderId"));
    id = old
      ? await adopt(old, "main", { name: config.get("notesFolderName") })
      : (await json(`${DRIVE}/files?fields=id`, { method: "POST", body: { name: config.get("notesFolderName"), mimeType: FOLDER, appProperties: { [ROLE]: "main" } } })).id;
  }
  if (id !== config.get("notesFolderId")) config.update({ notesFolderId: id });
  return id;
}

/** A subfolder of the main folder: "audio" or "sync". */
export async function subFolder(role, { name, legacyId, legacyTag } = {}) {
  const parentId = await mainFolder();
  let id = await findByRole(role, parentId);
  if (!id) {
    // A folder from an older version: by its saved ID, or by the tag it had.
    let old = await folderInfo(legacyId);
    if (!old && legacyTag) {
      const q = `mimeType='${FOLDER}' and trashed=false and appProperties has { key='${legacyTag[0]}' and value='${legacyTag[1]}' }`;
      const r = await json(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`);
      old = await folderInfo(r.files?.[0]?.id);
    }
    id = old
      ? await adopt(old, role, { parentId, name })
      : (await json(`${DRIVE}/files?fields=id`, { method: "POST", body: { name, mimeType: FOLDER, parents: [parentId], appProperties: { [ROLE]: role } } })).id;
  }
  return id;
}

/** Bring folders made by older versions into the one ClearNote folder. */
export async function tidyFolders() {
  await mainFolder();
  if (await folderInfo(config.get("audioFolderId"))) await ensureFolder("audio");
}

/** Where notes or audio go. */
export async function ensureFolder(kind) {
  if (kind === "notes") return mainFolder();
  const id = await subFolder("audio", { name: config.get("audioFolderName") || "Audio", legacyId: config.get("audioFolderId") });
  if (id !== config.get("audioFolderId")) config.update({ audioFolderId: id });
  return id;
}

/** Upload (or replace) a file. Returns its Drive ID. */
export async function uploadFile(path, { name, mimeType, folderId, existingId }) {
  const data = readFileSync(path);
  const reuse = await alive(existingId);
  const meta = reuse ? { name } : { name, parents: [folderId] };
  const start = await call(
    reuse
      ? `${UPLOAD}/files/${existingId}?uploadType=resumable&fields=id`
      : `${UPLOAD}/files?uploadType=resumable&fields=id`,
    {
      method: reuse ? "PATCH" : "POST",
      body: meta,
      headers: { "x-upload-content-type": mimeType, "x-upload-content-length": String(data.length) },
    },
  );
  const session = start.headers.get("location");
  const done = await call(session, { method: "PUT", body: data, raw: true, headers: { "content-type": mimeType } });
  return (await done.json()).id;
}

export async function createDoc(name, folderId) {
  const f = await json(`${DRIVE}/files?fields=id`, {
    method: "POST",
    body: { name, mimeType: GDOC, parents: [folderId] },
  });
  return f.id;
}

/** Move to the Drive bin (recoverable for 30 days). */
export async function trashFile(id) {
  await call(`${DRIVE}/files/${id}?fields=id`, { method: "PATCH", body: { trashed: true } });
}

export async function renameFile(id, name) {
  await call(`${DRIVE}/files/${id}?fields=id`, { method: "PATCH", body: { name } });
}

/**
 * Lay a paragraph list out as Docs requests for one tab, starting at index 1.
 * Each paragraph: { text, style?: "TITLE"|"HEADING_1"|"HEADING_2"|"HEADING_3",
 * bold?: [start,end] within text, link?: url (whole paragraph) }.
 */
export function tabRequests(tabId, paragraphs) {
  let text = "";
  const styles = [];
  for (const p of paragraphs) {
    const start = 1 + text.length;
    const body = String(p.text ?? "").replace(/\n+/g, " ");
    text += `${body}\n`;
    const end = start + body.length;
    if (p.style) {
      styles.push({
        updateParagraphStyle: {
          range: { startIndex: start, endIndex: end + 1, tabId },
          paragraphStyle: { namedStyleType: p.style },
          fields: "namedStyleType",
        },
      });
    }
    if (p.bold && p.bold[1] > p.bold[0]) {
      styles.push({
        updateTextStyle: {
          range: { startIndex: start + p.bold[0], endIndex: start + p.bold[1], tabId },
          textStyle: { bold: true },
          fields: "bold",
        },
      });
    }
    if (p.link && body.length) {
      styles.push({
        updateTextStyle: {
          range: { startIndex: start, endIndex: end, tabId },
          textStyle: { link: { url: p.link } },
          fields: "link",
        },
      });
    }
  }
  if (!text) return [];
  // New text takes the style of where it lands; reset to normal first.
  return [
    { insertText: { text, location: { index: 1, tabId } } },
    {
      updateParagraphStyle: {
        range: { startIndex: 1, endIndex: 1 + text.length, tabId },
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        fields: "namedStyleType",
      },
    },
    ...styles,
  ];
}

/**
 * Write the doc as named tabs, replacing whatever they held. Tabs are found by
 * title; missing ones are added. tabs: [{ title, paragraphs }].
 */
export async function writeTabs(docId, tabs) {
  const doc = await json(`${DOCS}/${docId}?includeTabsContent=true`);
  const existing = (doc.tabs || []).map((t) => ({
    id: t.tabProperties.tabId,
    title: t.tabProperties.title,
    end: (t.documentTab?.body?.content || []).reduce((m, c) => Math.max(m, c.endIndex || 0), 1),
  }));

  const setup = [];
  const ids = {};
  for (const [i, tab] of tabs.entries()) {
    const found = existing.find((t) => t.title === tab.title);
    if (found) {
      ids[tab.title] = found;
    } else if (i === 0 && existing.length === 1 && existing[0].end <= 2 && !tabs.some((t) => t.title === existing[0].title)) {
      // A new doc's untitled first tab becomes the first of ours.
      setup.push({
        updateDocumentTabProperties: { tabProperties: { tabId: existing[0].id, title: tab.title }, fields: "title" },
      });
      ids[tab.title] = existing[0];
    }
  }
  if (setup.length) await call(`${DOCS}/${docId}:batchUpdate`, { method: "POST", body: { requests: setup } });

  for (const tab of tabs) {
    if (ids[tab.title]) continue;
    const r = await json(`${DOCS}/${docId}:batchUpdate`, {
      method: "POST",
      body: { requests: [{ addDocumentTab: { tabProperties: { title: tab.title } } }] },
    });
    ids[tab.title] = { id: r.replies[0].addDocumentTab.tabProperties.tabId, end: 1 };
  }

  for (const tab of tabs) {
    const { id, end } = ids[tab.title];
    const requests = [];
    // A tab always keeps its final newline; clear everything before it.
    if (end > 2) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1, tabId: id } } });
    requests.push(...tabRequests(id, tab.paragraphs));
    if (requests.length) await call(`${DOCS}/${docId}:batchUpdate`, { method: "POST", body: { requests } });
  }
}
