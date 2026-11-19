const ask = (type, payload) =>
  new Promise((r) =>
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      // A worker that is still starting up can drop the reply; treat it as empty.
      void chrome.runtime.lastError;
      r(res || {});
    }),
  );

async function paint() {
  const s = await ask("status");
  const server = document.getElementById("server");
  server.textContent = s.reachable ? "connected" : "unreachable";
  server.className = `v ${s.reachable ? "ok" : "bad"}`;

  const pending = document.getElementById("pending");
  pending.textContent = s.pending ? `${s.pending} batches` : "nothing";
  pending.className = `v ${s.pending ? "warn" : "ok"}`;

  document.getElementById("auto").textContent = s.autoCapture ? "on" : "off";
  document.getElementById("dash").href = s.dashboardUrl || "http://localhost:8787";
  document.getElementById("settingsLink").href = `${(s.dashboardUrl || "http://localhost:8787").replace(/\/$/, "")}/#/settings`;
}

document.getElementById("retry").onclick = async (e) => {
  e.target.textContent = "Syncing…";
  await ask("retryNow");
  e.target.textContent = "Retry sync";
  paint();
};


paint();

// ------------------------------------------------------------ what to do here
// Clicking the extension icon is the gesture Chrome needs before an extension
// may capture a tab's sound, so recording is started from here. With "one click
// to record" on, opening this popup does the main action for the page at once:
//   a call        → capture it (if rules held it back) and record its audio
//   YouTube       → take the video's transcript
//   any other page → record its audio

let autoDone = false;

const $ = (id) => document.getElementById(id);

function show(btn, label, onClick, cls = "rec") {
  btn.hidden = false;
  btn.disabled = false;
  btn.textContent = label;
  btn.className = cls;
  btn.onclick = onClick;
}

async function streamFor(tabId) {
  return chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
}

async function waitForSession(tabId, ms = 20000) {
  for (let t = 0; t < ms; t += 500) {
    const st = await ask("tabState", { tabId });
    if (st.session) return st;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function paintAudio() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const btn = $("rec");
  const alt = $("rec2");
  const hint = $("recHint");
  btn.hidden = alt.hidden = true;
  if (!tab?.id) return;

  const [st, info, s] = await Promise.all([
    ask("tabState", { tabId: tab.id }),
    ask("pageInfo", { tabId: tab.id, url: tab.url }),
    ask("getSettings"),
  ]);
  const actions = info.decision?.actions || {};
  const rule = info.decision?.rule?.name;
  const oneClick = s.oneClickRecord !== false && !autoDone;
  const fail = (msg) => {
    hint.textContent = msg;
    paintAudio();
  };

  if (st.recording) {
    show(btn, "Stop recording", async () => {
      await ask("stopRecording");
      paintAudio();
    }, "rec on");
    hint.textContent = st.recording.mic ? "Recording this tab and your mic." : "Recording this tab (mic not available).";
    return;
  }
  if (st.busy) {
    hint.textContent = "Already recording another tab. Stop that one first.";
    return;
  }

  const recordAudio = async () => {
    btn.textContent = "Starting…";
    try {
      const streamId = await streamFor(tab.id);
      const res = st.session
        ? await ask("startRecording", { tabId: tab.id, streamId })
        : await ask("startAudioOnly", { tabId: tab.id, streamId, url: tab.url, title: tab.title });
      if (!res.ok) return fail(res.error || "Could not start recording.");
    } catch (err) {
      return fail(`Chrome refused: ${err.message}`);
    }
    paintAudio();
  };

  if (info.kind === "meeting") {
    if (st.session) {
      show(btn, "Record audio", recordAudio);
      hint.textContent = "Captions are being captured. Recording adds an accurate transcript from the audio. Shortcut: Option+Shift+R.";
      if (oneClick && actions.audio !== "off") {
        autoDone = true;
        recordAudio();
      }
      return;
    }
    const captureCall = async (withAudio) => {
      btn.textContent = "Starting…";
      await chrome.tabs.sendMessage(tab.id, { type: "startCapture" }).catch(() => null);
      hint.textContent = "Starting capture… (join the call if you haven't yet)";
      const ready = await waitForSession(tab.id);
      if (!ready) return fail("Capture hasn't started yet. Join the call and make sure captions are allowed, then click again.");
      if (withAudio) {
        st.session = ready.session;
        await recordAudio();
      } else paintAudio();
    };
    show(btn, "Capture this call", () => captureCall(actions.audio !== "off"));
    show(alt, "Captions only", () => captureCall(false), "");
    hint.textContent = rule
      ? `Not capturing: your rule “${rule}” keeps ClearNote off here. Capture anyway?`
      : "Not capturing yet.";
    if (oneClick && actions.captions === "click") {
      autoDone = true;
      captureCall(actions.audio !== "off");
    }
    return;
  }

  if (info.kind === "youtube") {
    let yt = await chrome.tabs.sendMessage(tab.id, { type: "ytState" }).catch(() => null);
    if (!yt) {
      // A tab opened before ClearNote was (re)loaded has no reader yet: add it.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["platforms/youtube.js"] }).catch(() => null);
      yt = await chrome.tabs.sendMessage(tab.id, { type: "ytState" }).catch(() => null);
    }
    if (!yt) {
      hint.textContent = "ClearNote couldn't read this page. Reload it and try again.";
      show(alt, "Record audio instead", recordAudio, "");
      return;
    }
    if (yt.live) {
      show(btn, "Stop reading captions", async () => {
        const r = await chrome.tabs.sendMessage(tab.id, { type: "ytStop" }).catch(() => ({}));
        hint.textContent = `Stopped. ${r.lines || 0} lines captured; the summary follows.`;
        paintAudio();
      }, "rec on");
      hint.textContent = "Reading the captions as the video plays.";
      return;
    }
    const grab = async (again = false) => {
      btn.textContent = "Reading…";
      const r = await chrome.tabs.sendMessage(tab.id, { type: "ytCapture", again }).catch((e) => ({ ok: false, error: e.message }));
      if (!r.ok) return fail(r.error || "Couldn't read this video.");
      if (r.mode === "exists") {
        hint.innerHTML = "";
        hint.append("Already captured. ");
        const a = Object.assign(document.createElement("a"), {
          href: `${(s.dashboardUrl || "http://localhost:8787").replace(/\/$/, "")}/#/m/${r.id}`,
          target: "_blank",
          textContent: "Open it in the dashboard",
        });
        hint.append(a);
        show(btn, "Capture again", () => grab(true), "");
        alt.hidden = true;
        return;
      }
      hint.textContent =
        r.mode === "transcript"
          ? `Took the full transcript (${r.lines} lines). The summary and notes follow in the dashboard.`
          : "This video has no transcript, so ClearNote reads the captions as it plays. Play the video; click again to stop.";
      if (r.mode === "live") paintAudio();
      else btn.hidden = true;
    };
    show(btn, "Get transcript", () => grab(false));
    show(alt, "Record audio instead", recordAudio, "");
    hint.textContent = "Takes the video's transcript, or reads its captions as it plays.";
    if (oneClick && actions.captions !== "off") {
      autoDone = true;
      grab(false);
    }
    return;
  }

  if (info.kind === "web") {
    show(btn, actions.audio === "off" ? "Record anyway" : "Record audio", recordAudio);
    hint.textContent =
      actions.audio === "off"
        ? `Recording is off here (${rule || "your rules"}).`
        : "Records this tab's sound and transcribes it on your Mac. No speaker names on websites. Shortcut: Option+Shift+R.";
    if (oneClick && actions.audio !== "off") {
      autoDone = true;
      recordAudio();
    }
    return;
  }

  hint.textContent = "Open a call, a video or a web page to record it.";
}

paintAudio();
