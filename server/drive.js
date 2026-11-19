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

/**
 * The folder ClearNote saves into, created in My Drive on first use. You can
 * rename or move it in Drive; ClearNote keeps using it by its ID. If it is
 * deleted, a new one is made.
 */
export async function ensureFolder(kind) {
  const idKey = `${kind}FolderId`;
  const id = config.get(idKey);
  if (await alive(id)) return id;
  const f = await json(`${DRIVE}/files?fields=id`, {
    method: "POST",
    body: { name: config.get(`${kind}FolderName`), mimeType: FOLDER },
  });
  config.update({ [idKey]: f.id });
  return f.id;
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
