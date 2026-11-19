// Service worker: owns settings, the outbound queue and the server handshake.
//
// MV3 workers are killed aggressively, so every segment goes into a
// chrome.storage.local queue before it is sent, and an alarm drains the queue.
// Nothing is lost if the worker is torn down mid-meeting.

const DEFAULTS = {
  serverUrl: "http://localhost:8787",
  dashboardUrl: "http://localhost:8787",
  token: "",
  displayName: "",
  autoCapture: true,
  hideCaptions: true,
  debug: false,
  recordMic: true,
};

const QUEUE_KEY = "cn_queue";
const CLAIMS_KEY = "cn_claims";

// Connection details (server address, token) live in Chrome. Everything else
// (your name, capture options) lives in the dashboard's Settings, so there is
// one place to change it; the last copy fetched is kept for when the server is
// down.
const SERVER_SETTINGS_KEY = "cn_server_settings";
const SERVER_FIELDS = ["displayName", "autoCapture", "hideCaptions", "recordMic", "debug", "panelMode"];

async function settings() {
  const local = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  let remote = null;
  try {
    const res = await fetch(`${local.serverUrl.replace(/\/$/, "")}/api/extension-settings`, {
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) {
      remote = await res.json();
      // One-time move: a name typed into the old extension options goes to the server.
      if (!remote.displayName && local.displayName) {
        await fetch(`${local.serverUrl.replace(/\/$/, "")}/api/settings`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName: local.displayName }),
        }).catch(() => {});
        remote.displayName = local.displayName;
      }
      await chrome.storage.local.set({ [SERVER_SETTINGS_KEY]: remote });
    }
  } catch {
    /* server down: use the last copy */
  }
  if (!remote) ({ [SERVER_SETTINGS_KEY]: remote = {} } = await chrome.storage.local.get(SERVER_SETTINGS_KEY));
  const merged = { ...local };
  for (const k of SERVER_FIELDS) if (remote[k] !== undefined) merged[k] = remote[k];
  return merged;
}

async function api(path, body, method = "POST") {
  const { serverUrl, token } = await settings();
  const res = await fetch(`${serverUrl.replace(/\/$/, "")}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-clearnote-token": token || "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? {} : res.json();
}

// ---------------------------------------------------------------- queue

async function enqueue(item) {
  const { [QUEUE_KEY]: q = [] } = await chrome.storage.local.get(QUEUE_KEY);
  q.push(item);
  await chrome.storage.local.set({ [QUEUE_KEY]: q });
}

let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const { [QUEUE_KEY]: q = [] } = await chrome.storage.local.get(QUEUE_KEY);
      if (!q.length) break;

      // Coalesce consecutive segment batches for the same session into one call.
      const head = q[0];
      let take = 1;
      let payload = head.body;
      if (head.path.endsWith("/segments")) {
        while (take < q.length && q[take].path === head.path) {
          payload = { segments: payload.segments.concat(q[take].body.segments) };
          take++;
        }
      }

      try {
        await api(head.path, payload, head.method || "POST");
      } catch (err) {
        console.warn("[ClearNote] send failed, will retry:", err.message);
        break; // leave the queue intact; the next alarm retries
      }
      const { [QUEUE_KEY]: cur = [] } = await chrome.storage.local.get(QUEUE_KEY);
      await chrome.storage.local.set({ [QUEUE_KEY]: cur.slice(take) });
    }
  } finally {
    draining = false;
    await badge();
  }
}

/**
 * The toolbar icon is the steady, off-screen signal of what ClearNote is doing:
 * red REC while audio is recorded, grey ON while captions are captured, a count
 * when lines are waiting to sync. Nothing blinks.
 */
async function badge() {
  const { [QUEUE_KEY]: q = [] } = await chrome.storage.local.get(QUEUE_KEY);
  const { [REC_KEY]: rec = null, [SESSIONS_KEY]: sessions = {} } = await chrome.storage.session.get([REC_KEY, SESSIONS_KEY]);
  let text = "";
  let color = "#52525b";
  let title = "ClearNote";
  if (rec) {
    text = "REC";
    color = "#dc2626";
    title = "ClearNote: recording audio and captions";
  } else if (Object.keys(sessions).length) {
    text = "ON";
    title = "ClearNote: capturing captions";
  }
  if (q.length && !rec) {
    text = String(Math.min(q.length, 99));
    color = "#b45309";
    title = `ClearNote: ${q.length} batches waiting to sync`;
  }
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  await chrome.action.setTitle({ title });
}

chrome.alarms.create("cn-drain", { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "cn-drain") drain();
});

// ---------------------------------------------------------------- messages

const handlers = {
  async getSettings() {
    return settings();
  },

  // Keeps two frames of the same meeting from both opening a session.
  async claimSession({ meetingKey }, sender) {
    const { [CLAIMS_KEY]: claims = {} } = await chrome.storage.local.get(CLAIMS_KEY);
    const mine = `${sender.tab?.id}:${sender.frameId}`;
    const held = claims[meetingKey];
    if (held && held.owner !== mine && Date.now() - held.at < 60000) return { owner: false };
    claims[meetingKey] = { owner: mine, at: Date.now() };
    await chrome.storage.local.set({ [CLAIMS_KEY]: claims });
    return { owner: true };
  },

  async startSession(payload, sender) {
    // Created synchronously so the content script gets a real id to stream to.
    try {
      const { id } = await api("/api/sessions", payload);
      await rememberTabSession(sender.tab?.id, { sessionId: id, startedAt: payload.startedAt });
      await badge();
      return { sessionId: id };
    } catch (err) {
      console.warn("[ClearNote] could not reach the server:", err.message);
      // Fall back to the deterministic key; the server upserts on it, so the
      // queued segments still land in the right meeting once it comes back.
      await enqueue({ path: "/api/sessions", body: payload });
      await rememberTabSession(sender.tab?.id, { sessionId: payload.meetingKey, startedAt: payload.startedAt });
      return { sessionId: payload.meetingKey };
    }
  },

  async segments({ sessionId, segments }) {
    await enqueue({
      path: `/api/sessions/${encodeURIComponent(sessionId)}/segments`,
      body: { segments },
    });
    drain();
    return { ok: true };
  },

  async endSession(payload, sender) {
    const { displayName } = await settings();
    payload = { ...payload, myName: displayName || "" };
    const rec = await recording();
    if (rec && rec.tabId === sender.tab?.id) await stopRecording("call_ended");
    await enqueue({
      path: `/api/sessions/${encodeURIComponent(payload.sessionId)}/end`,
      body: payload,
    });
    await drain();
    await forgetTabSession(sender.tab?.id);
    await badge();
    return { ok: true };
  },

  // Audio: started from the popup (a click on the extension is the gesture
  // Chrome requires before it lets an extension capture a tab's sound).
  async tabState({ tabId }) {
    const { [SESSIONS_KEY]: sessions = {} } = await chrome.storage.session.get(SESSIONS_KEY);
    const rec = await recording();
    return { session: sessions[tabId] || null, recording: rec?.tabId === tabId ? rec : null, busy: !!rec && rec.tabId !== tabId };
  },

  async startRecording({ tabId, streamId }) {
    return startRecording(tabId, streamId);
  },

  async stopRecording() {
    await stopRecording("stopped");
    return { ok: true };
  },

  async recordingStopped({ reason } = {}) {
    remoteLog(`audio recording stopped (${reason || "stopped"})`);
    const rec = await recording();
    await chrome.storage.session.remove(REC_KEY);
    if (rec) notifyTab(rec.tabId, false);
    return { ok: true };
  },

  async retryNow() {
    await drain();
    const { [QUEUE_KEY]: q = [] } = await chrome.storage.local.get(QUEUE_KEY);
    return { pending: q.length };
  },

  async status() {
    const { [QUEUE_KEY]: q = [] } = await chrome.storage.local.get(QUEUE_KEY);
    const s = await settings();
    let reachable = false;
    try {
      await api("/api/health", undefined, "GET");
      reachable = true;
    } catch {
      /* server down */
    }
    return { pending: q.length, reachable, ...s };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.target === "offscreen") return false;
  const fn = handlers[msg?.type];
  if (!fn) return false;
  Promise.resolve(fn(msg.payload || {}, sender))
    .then(respond)
    .catch((err) => {
      console.error(`[ClearNote] ${msg.type} failed`, err);
      respond({ error: err.message });
    });
  return true; // async response
});

// ---------------------------------------------------------------- audio

const SESSIONS_KEY = "cn_tab_sessions";
const REC_KEY = "cn_recording";

async function rememberTabSession(tabId, info) {
  if (tabId == null) return;
  const { [SESSIONS_KEY]: sessions = {} } = await chrome.storage.session.get(SESSIONS_KEY);
  sessions[tabId] = info;
  await chrome.storage.session.set({ [SESSIONS_KEY]: sessions });
}

async function forgetTabSession(tabId) {
  if (tabId == null) return;
  const { [SESSIONS_KEY]: sessions = {} } = await chrome.storage.session.get(SESSIONS_KEY);
  delete sessions[tabId];
  await chrome.storage.session.set({ [SESSIONS_KEY]: sessions });
}

async function recording() {
  const { [REC_KEY]: rec = null } = await chrome.storage.session.get(REC_KEY);
  return rec;
}

function notifyTab(tabId, on, extra = {}) {
  chrome.tabs.sendMessage(tabId, { type: "recordingState", payload: { on, ...extra } }).catch(() => {});
}

/** Send a line to the server's log. Never throws. */
async function remoteLog(message, level = "info") {
  try {
    await api("/api/log", { message, level });
  } catch {
    /* server down: nothing to do */
  }
}

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Record the meeting tab and microphone for local transcription.",
  });
}

async function startRecording(tabId, streamId) {
  try {
    const r = await startRecordingInner(tabId, streamId);
    remoteLog(r.ok ? `audio recording started (mic: ${r.mic ? "yes" : "no"})` : `audio recording did not start: ${r.error}`, r.ok ? "info" : "error");
    return r;
  } catch (err) {
    remoteLog(`audio recording failed: ${err.message}`, "error");
    return { ok: false, error: err.message };
  }
}

async function startRecordingInner(tabId, streamId) {
  const { [SESSIONS_KEY]: sessions = {} } = await chrome.storage.session.get(SESSIONS_KEY);
  const session = sessions[tabId];
  if (!session) return { ok: false, error: "ClearNote has not started capturing this call yet." };
  if (await recording()) return { ok: false, error: "Already recording another tab." };
  if (!streamId) streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  const s = await settings();
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "start",
    payload: {
      streamId,
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      serverUrl: s.serverUrl,
      token: s.token,
      myName: s.displayName || "",
      withMic: s.recordMic !== false,
    },
  });
  if (!res?.ok) return { ok: false, error: res?.error || "Could not start recording." };
  await chrome.storage.session.set({ [REC_KEY]: { tabId, sessionId: session.sessionId, mic: res.mic, at: Date.now() } });
  notifyTab(tabId, true, { mic: res.mic });
  await badge();
  return { ok: true, mic: res.mic };
}

async function stopRecording(reason) {
  const rec = await recording();
  if (!rec) return;
  const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (ctx.length) await chrome.runtime.sendMessage({ target: "offscreen", type: "stop", payload: { reason } });
  await chrome.storage.session.remove(REC_KEY);
  notifyTab(rec.tabId, false);
  await badge();
}

// Keyboard shortcut (Alt+Shift+R by default) toggles recording on the active tab.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-audio" || !tab?.id) return;
  const rec = await recording();
  if (rec?.tabId === tab.id) return stopRecording("stopped");
  const res = await startRecording(tab.id);
  if (!res.ok) notifyTab(tab.id, false, { error: res.error });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await recording();
  if (rec?.tabId === tabId) await stopRecording("tab_closed");
  await forgetTabSession(tabId);
  await badge();
});
