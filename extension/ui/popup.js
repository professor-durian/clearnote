// The toolbar popup. It shows where you are and what ClearNote is doing there,
// with the choices your rules suggest already ticked. One button starts them.
//
// Clicking the extension icon is the gesture Chrome needs before an extension
// may record a tab's sound, which is why recording is started from here.

const ask = (type, payload) =>
  new Promise((r) =>
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      // A worker that is still starting up can drop the reply; treat it as empty.
      void chrome.runtime.lastError;
      r(res || {});
    }),
  );

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let tab;
let settings = {};
let base = "http://localhost:8787";
let clockTimer = null;

const HOST_TEXT = { me: "You're the host", others: "Someone else is hosting", unknown: "Not on your calendar" };
const SITE_TEXT = { meet: "Google Meet", zoom: "Zoom", teams: "Microsoft Teams" };

function choice(id, title, sub, checked, disabled = false) {
  return `<label class="choice ${disabled ? "done" : ""}">
    <input type="checkbox" id="${id}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
    <div><b>${esc(title)}</b><span>${esc(sub)}</span></div></label>`;
}

function setMain(label, onClick, { quiet = false } = {}) {
  const go = $("go");
  go.hidden = false;
  go.disabled = false;
  go.textContent = label;
  go.className = `main ${quiet ? "quiet" : ""}`;
  go.onclick = async (e) => {
    e.preventDefault();
    go.disabled = true;
    try {
      await onClick();
    } catch (err) {
      $("msg").textContent = err.message;
    }
    render();
  };
}

async function streamFor() {
  return chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
}

async function startAudio({ meta } = {}) {
  const streamId = await streamFor();
  const st = await ask("tabState", { tabId: tab.id });
  const res = st.session
    ? await ask("startRecording", { tabId: tab.id, streamId })
    : await ask("startAudioOnly", { tabId: tab.id, streamId, url: tab.url, title: tab.title, ...(meta || {}) });
  if (!res.ok) throw new Error(res.error || "Couldn't start recording.");
}

// A call page whose address ClearNote doesn't recognise still gets a call
// identity, so audio and captions land in one capture.
function fallbackCall() {
  const zoom = (tab.url || "").match(/zoom\.us\/(?:j|wc|s)\/(?:join\/)?(\d{9,12})/i);
  return zoom ? { platform: "zoom", platformLabel: "Zoom", meetingKey: `zoom:${zoom[1]}` } : null;
}

async function waitForSession(ms = 20000) {
  for (let t = 0; t < ms; t += 500) {
    const st = await ask("tabState", { tabId: tab.id });
    if (st.session) return st;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function showRecording(rec) {
  $("recbox").hidden = false;
  $("rectext").textContent = rec.mic ? "Recording this tab and your mic" : "Recording this tab";
  clearInterval(clockTimer);
  const tick = () => {
    const s = Math.max(0, Math.round((Date.now() - (rec.at || Date.now())) / 1000));
    $("clock").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  tick();
  clockTimer = setInterval(tick, 1000);
}

async function render() {
  $("choices").innerHTML = "";
  $("go").hidden = true;
  $("recbox").hidden = true;
  if (!tab?.id) return;

  const [st, info] = await Promise.all([ask("tabState", { tabId: tab.id }), ask("pageInfo", { tabId: tab.id, url: tab.url })]);
  const d = info.decision || {};
  const a = d.actions || {};
  const ruleName = d.rule?.name;
  let hostname = "This page";
  try {
    hostname = new URL(tab.url).hostname.replace(/^www\./, "");
  } catch {
    /* keep */
  }
  $("site").textContent = info.kind === "meeting" ? SITE_TEXT[d.site] || "Call" : info.kind === "youtube" ? "YouTube" : hostname;
  $("detail").textContent = [d.host && HOST_TEXT[d.host], ruleName && `rule: ${ruleName}`].filter(Boolean).join(" · ");

  // ---- recording now: show it and a Stop button
  if (st.recording) {
    showRecording(st.recording);
    $("status").textContent = "";
    setMain("Stop recording", async () => {
      await ask("stopRecording");
      $("msg").innerHTML = `Stopped. The audio is transcribed on your Mac; it appears in the <a href="${base}/#/" target="_blank">dashboard</a> shortly.`;
    }, { quiet: true });
    return;
  }
  if (st.busy) {
    $("status").textContent = "ClearNote is recording another tab. Stop that one first.";
    return;
  }

  // ---- a call (Meet, Zoom, Teams)
  if (info.kind === "meeting") {
    $("site").textContent = SITE_TEXT[d.site] || "Call";
    $("detail").textContent = [d.host && HOST_TEXT[d.host], ruleName && `rule: ${ruleName}`].filter(Boolean).join(" · ");
    if (st.session) {
      $("status").textContent = "Capturing captions. Notes and the summary follow when the call ends.";
      $("msg").textContent = "Recording the audio as well gives a more accurate transcript and keeps the audio files.";
      setMain("Record audio too", () => startAudio());
      return;
    }
    $("status").textContent =
      a.captions === "off"
        ? d.host === "me"
          ? "Your own call: Gemini is taking the notes, so ClearNote stays off."
          : "ClearNote is off here by your rules."
        : "Not capturing yet.";
    $("choices").innerHTML =
      choice("audio", "Record audio", d.host === "me" ? "Keep the audio file. No duplicate notes." : "Records this call's sound and your mic.", a.audio !== "off") +
      choice("captions", "Capture captions and notes", "Transcript with speaker names, summary and notes Doc.", a.captions !== "off");
    setMain("Start", async () => {
      const wantCaptions = $("captions").checked;
      const wantAudio = $("audio").checked;
      if (!wantCaptions && !wantAudio) throw new Error("Tick at least one.");
      // Audio first: Chrome's permission to record this tab lasts only a few
      // seconds after the click, and audio must never wait on captions.
      // Both land in the same capture (same call, same meeting id).
      if (wantAudio) await startAudio({ meta: info.call || fallbackCall() });
      if (wantCaptions) {
        await chrome.tabs.sendMessage(tab.id, { type: "startCapture" }).catch(() => null);
        $("msg").textContent = wantAudio
          ? "Recording. Turning on captions too…"
          : "Starting… (join the call if you haven't yet)";
        const ready = await waitForSession(wantAudio ? 8000 : 20000);
        if (!ready && !wantAudio) throw new Error("Captions haven't started. Join the call in the browser and turn on captions, then try again.");
      }
    });
    return;
  }

  // ---- YouTube
  if (info.kind === "youtube") {
    $("site").textContent = "YouTube";
    $("detail").textContent = ruleName ? `rule: ${ruleName}` : "";
    let yt = await chrome.tabs.sendMessage(tab.id, { type: "ytState" }).catch(() => null);
    if (!yt) {
      // A tab opened before ClearNote was (re)loaded has no reader yet: add it.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["platforms/youtube.js"] }).catch(() => null);
      yt = await chrome.tabs.sendMessage(tab.id, { type: "ytState" }).catch(() => null);
    }
    if (yt?.live) {
      $("status").textContent = "Reading the captions as the video plays.";
      setMain("Stop", async () => {
        const r = await chrome.tabs.sendMessage(tab.id, { type: "ytStop" }).catch(() => ({}));
        $("msg").textContent = `Stopped: ${r.lines || 0} lines. The summary follows in the dashboard.`;
      }, { quiet: true });
      return;
    }
    $("status").textContent = yt ? "Nothing captured from this video yet." : "ClearNote can't read this page's captions; audio still works.";
    $("choices").innerHTML =
      choice("transcript", "Transcript", "The video's own captions, all at once.", !!yt && a.captions !== "off", !yt) +
      choice("audio", "Record audio", "Keeps the sound as a file while the video plays.", a.audio !== "off");
    const run = async (again = false) => {
      const wantT = $("transcript")?.checked;
      const wantA = $("audio").checked;
      if (!wantT && !wantA) throw new Error("Tick at least one.");
      if (wantT) {
        const r = await chrome.tabs.sendMessage(tab.id, { type: "ytCapture", again, keepOpen: wantA }).catch((e) => ({ ok: false, error: e.message }));
        if (!r.ok) throw new Error(r.error || "Couldn't read this video.");
        if (r.mode === "exists") {
          $("msg").innerHTML = `Already captured. <a href="${base}/#/m/${esc(r.id)}" target="_blank">Open it</a>, or start again to capture a fresh copy.`;
          setMain("Capture again", () => run(true), { quiet: true });
          throw Object.assign(new Error(""), { quiet: true });
        }
        $("msg").textContent =
          r.mode === "transcript"
            ? `Took the transcript (${r.lines} lines). Notes follow in the dashboard${wantA ? " when you stop the recording" : ""}.`
            : "No transcript on this video: reading the captions as it plays.";
      }
      if (wantA) await startAudio();
    };
    setMain("Start", () => run(false).catch((e) => { if (!e.quiet) throw e; }));
    return;
  }

  // ---- any other web page
  if (info.kind === "web") {
    let host = "This page";
    try {
      host = new URL(tab.url).hostname.replace(/^www\./, "");
    } catch {
      /* keep */
    }
    $("site").textContent = host;
    $("detail").textContent = ruleName ? `rule: ${ruleName}` : "";
    $("status").textContent = "Websites have no captions ClearNote can read, so it works from the audio. No speaker names.";
    $("choices").innerHTML = choice("audio", "Record audio", "Transcribed on your Mac, then summarised and saved.", a.audio !== "off");
    setMain("Start", async () => {
      if (!$("audio").checked) throw new Error("Tick Record audio to start.");
      await startAudio();
    });
    return;
  }

  $("site").textContent = "Nothing to capture here";
  $("status").textContent = "Open a call, a video or a web page.";
}

async function header() {
  const s = await ask("status");
  base = (s.dashboardUrl || "http://localhost:8787").replace(/\/$/, "");
  $("server").textContent = s.reachable ? "" : "server offline";
  $("server").className = `server ${s.reachable ? "" : "bad"}`;
  $("dash").href = base;
  $("settingsLink").href = `${base}/#/settings/rules`;
  if (s.pending) {
    $("retry").hidden = false;
    $("retry").textContent = `${s.pending} waiting · retry`;
    $("retry").onclick = async (e) => {
      e.preventDefault();
      await ask("retryNow");
      header();
    };
  }
}

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  settings = await ask("getSettings");
  header();
  await render();
  // Optional: start straight away with the ticked choices.
  if (settings.oneClickRecord === true && !$("go").hidden && $("go").textContent === "Start") $("go").click();
})();
