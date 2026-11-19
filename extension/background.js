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
const SERVER_FIELDS = ["displayName", "autoCapture", "hideCaptions", "recordMic", "debug", "panelMode", "oneClickRecord"];

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
 * its colour shows the state (see setIconState), plus a small grey count when
 * lines are waiting to sync. No badges, nothing blinks.
 */
async function badge() {
  const { [QUEUE_KEY]: q = [] } = await chrome.storage.local.get(QUEUE_KEY);
  const { [REC_KEY]: rec = null, [SESSIONS_KEY]: sessions = {} } = await chrome.storage.session.get([REC_KEY, SESSIONS_KEY]);
  const state = rec ? "recording" : Object.keys(sessions).length ? "capturing" : "idle";
  const title = {
    recording: "ClearNote: recording audio",
    capturing: "ClearNote: capturing captions",
    idle: "ClearNote",
  }[state];
  await setIconState(state);
  // A small grey count only when lines are waiting to sync; never a REC badge.
  await chrome.action.setBadgeBackgroundColor({ color: "#52525b" });
  await chrome.action.setBadgeText({ text: q.length ? String(Math.min(q.length, 99)) : "" });
  await chrome.action.setTitle({ title: q.length ? `${title} · ${q.length} waiting to sync` : title });
}

/**
 * The icon itself shows the state: grey when idle, its normal colours while
 * captions are captured, tinted a muted red while audio is recorded.
 */
let iconState = null;
async function setIconState(state) {
  if (state === iconState) return;
  iconState = state;
  try {
    const imageData = {};
    for (const size of [16, 32]) {
      const blob = await (await fetch(chrome.runtime.getURL(`icons/icon-${size}.png`))).blob();
      const bmp = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext("2d");
      if (state === "idle") ctx.filter = "grayscale(1) opacity(0.75)";
      ctx.drawImage(bmp, 0, 0, size, size);
      if (state === "recording") {
        ctx.globalCompositeOperation = "source-atop";
        ctx.fillStyle = "rgba(185, 64, 64, 0.85)";
        ctx.fillRect(0, 0, size, size);
      }
      imageData[size] = ctx.getImageData(0, 0, size, size);
    }
    await chrome.action.setIcon({ imageData });
  } catch (err) {
    console.warn("[ClearNote] icon update failed", err);
  }
}

chrome.alarms.create("cn-drain", { periodInMinutes: 0.25 });
chrome.alarms.create("cn-update", { periodInMinutes: 10 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "cn-drain") drain();
  if (a.name === "cn-update") reloadIfUpdated();
});

// ---------------------------------------------------------------- updates
// When the server has been updated (Settings › Advanced › Update, or a git
// pull), the extension files on disk change too. Chrome only picks them up on
// a reload, so reload, but never while a call or recording might be affected.

const EXT_KEY = "cn_loaded_extension_commit";
const CALL_TABS = ["https://meet.google.com/*", "https://*.zoom.us/*", "https://teams.microsoft.com/*", "https://teams.live.com/*"];

async function reloadIfUpdated({ justLoaded = false } = {}) {
  try {
    const { serverUrl } = await settings();
    const res = await fetch(`${serverUrl.replace(/\/$/, "")}/api/version`);
    if (!res.ok) return;
    const { extensionCommit } = await res.json();
    if (!extensionCommit) return;
    const { [EXT_KEY]: loaded } = await chrome.storage.local.get(EXT_KEY);
    // Just (re)loaded: the files Chrome read are the ones on disk now.
    if (!loaded || justLoaded) return chrome.storage.local.set({ [EXT_KEY]: extensionCommit });
    if (loaded === extensionCommit) return;
    const { [REC_KEY]: rec = null, [SESSIONS_KEY]: sessions = {} } = await chrome.storage.session.get([REC_KEY, SESSIONS_KEY]);
    if (rec || Object.keys(sessions).length) return; // try again later
    const callTabs = await chrome.tabs.query({ url: CALL_TABS });
    if (callTabs.length) return; // a call page open now would lose its reader
    await chrome.storage.local.set({ [EXT_KEY]: extensionCommit });
    console.log("[ClearNote] new version on disk, reloading");
    chrome.runtime.reload();
  } catch {
    /* server offline: try later */
  }
}
chrome.runtime.onStartup.addListener(() => reloadIfUpdated({ justLoaded: true }));
chrome.runtime.onInstalled.addListener(() => reloadIfUpdated({ justLoaded: true }));

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
      const { id, existing } = await api("/api/sessions", payload);
      if (existing) return { sessionId: id, existing: true };
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

  // Rules: ask the server what to do on a page; remembered per tab.
  async evaluateRule(payload, sender) {
    return evaluateFor(sender.tab?.id, payload);
  },

  /** What the toolbar popup should offer on a tab. */
  async pageInfo({ tabId, url }) {
    const kind = pageKind(url);
    const call = kind === "meeting" ? callMeta(url) : null;
    const decision = await evaluateFor(tabId, { url, platform: call?.platform || (kind === "youtube" ? "youtube" : ""), meetingKey: call?.meetingKey });
    return { kind, decision, call };
  },

  /** YouTube transcript plus audio: the session ends when the recording stops. */
  async endWithRecording(_payload, sender) {
    const { [SESSIONS_KEY]: sessions = {} } = await chrome.storage.session.get(SESSIONS_KEY);
    if (sessions[sender.tab?.id]) {
      sessions[sender.tab.id].audioOnly = true;
      await chrome.storage.session.set({ [SESSIONS_KEY]: sessions });
    }
    return { ok: true };
  },

  /** Audio-only recording of any page: a session with no captions. */
  async startAudioOnly({ tabId, streamId, url, title, platform, meetingKey, platformLabel }) {
    const startedAt = Date.now();
    let host = "web";
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      /* keep "web" */
    }
    // On a call, the recording belongs to that call (so its calendar match and
    // rule apply); anywhere else it is a session of its own.
    const { id } = await api("/api/sessions", {
      meetingKey: meetingKey || `web:${url}:${startedAt}`,
      platform: platform || "web",
      platformLabel: platformLabel || host,
      title: title || host,
      url,
      startedAt,
    });
    await rememberTabSession(tabId, { sessionId: id, startedAt, audioOnly: true });
    const r = await startRecording(tabId, streamId);
    if (!r.ok) {
      await api(`/api/sessions/${encodeURIComponent(id)}/end`, { endedAt: Date.now(), reason: "recording_failed" }).catch(() => {});
      await forgetTabSession(tabId);
    }
    return r;
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

const RULES_KEY = "cn_tab_rules";

/** Platform and meeting key for a call URL, matching what the page script sends. */
function callMeta(url = "") {
  const meet = url.match(/meet\.google\.com\/(?:[\w-]+\/)*([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i);
  if (meet) return { platform: "google_meet", platformLabel: "Google Meet", meetingKey: meet[1].toLowerCase() };
  const zoom = url.match(/zoom\.us\/(?:j|wc|s)\/(\d{9,12})/i);
  if (zoom) return { platform: "zoom", platformLabel: "Zoom", meetingKey: `zoom:${zoom[1]}` };
  if (/teams\.(microsoft|live)\.com|cloud\.microsoft\.com/.test(url)) return { platform: "teams", platformLabel: "Microsoft Teams", meetingKey: `teams:${url.split("?")[0]}` };
  return null;
}

function pageKind(url = "") {
  if (/^https:\/\/(meet\.google\.com|[\w.-]*zoom\.us|teams\.(microsoft|live)\.com|[\w.-]*cloud\.microsoft\.com)\//.test(url)) return "meeting";
  if (/^https:\/\/(www\.|m\.)?youtube\.com\/watch/.test(url)) return "youtube";
  if (/^https?:\/\//.test(url)) return "web";
  return "none";
}

async function evaluateFor(tabId, payload) {
  let decision = null;
  try {
    decision = await api("/api/rules/evaluate", payload);
  } catch {
    // Server down: behave as before rules existed.
    const s = await settings();
    decision = { rule: null, actions: { captions: s.autoCapture === false ? "click" : "auto", panel: s.panelMode || "compact", audio: "click" } };
  }
  if (tabId != null) {
    const { [RULES_KEY]: cache = {} } = await chrome.storage.session.get(RULES_KEY);
    cache[tabId] = decision;
    await chrome.storage.session.set({ [RULES_KEY]: cache });
  }
  return decision;
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
  const { [SESSIONS_KEY]: sessions = {} } = await chrome.storage.session.get(SESSIONS_KEY);
  const audioOnly = sessions[rec.tabId]?.audioOnly ? sessions[rec.tabId] : null;
  const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (ctx.length) await chrome.runtime.sendMessage({ target: "offscreen", type: "stop", payload: { reason } });
  await chrome.storage.session.remove(REC_KEY);
  notifyTab(rec.tabId, false);
  if (audioOnly) {
    // An audio-only recording is the whole session: end it so it gets transcribed and summarised.
    await enqueue({
      path: `/api/sessions/${encodeURIComponent(audioOnly.sessionId)}/end`,
      body: { endedAt: Date.now(), reason },
    });
    drain();
    await forgetTabSession(rec.tabId);
  }
  await badge();
}

// Keyboard shortcut (Alt+Shift+R by default) toggles recording on the active tab.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-audio" || !tab?.id) return;
  const rec = await recording();
  if (rec?.tabId === tab.id) return stopRecording("stopped");
  const { [SESSIONS_KEY]: sessions = {} } = await chrome.storage.session.get(SESSIONS_KEY);
  const res = sessions[tab.id]
    ? await startRecording(tab.id)
    : await handlers.startAudioOnly({ tabId: tab.id, streamId: await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }), url: tab.url, title: tab.title });
  if (!res.ok) notifyTab(tab.id, false, { error: res.error });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await recording();
  if (rec?.tabId === tabId) await stopRecording("tab_closed");
  await forgetTabSession(tabId);
  await badge();
});
