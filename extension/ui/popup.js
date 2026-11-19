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

// ------------------------------------------------------------ audio recording
// Clicking the extension icon is the gesture Chrome needs before an extension
// may capture a tab's sound, so the tab's stream id is fetched here.

async function paintAudio() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const btn = document.getElementById("rec");
  const hint = document.getElementById("recHint");
  if (!tab?.id) return;
  const st = await ask("tabState", { tabId: tab.id });
  if (st.recording) {
    btn.hidden = false;
    btn.textContent = "Stop recording";
    btn.className = "rec on";
    hint.textContent = st.recording.mic ? "Recording the call and your mic." : "Recording the call (mic not available).";
    btn.onclick = async () => {
      await ask("stopRecording");
      paintAudio();
    };
  } else if (st.session) {
    btn.hidden = false;
    btn.textContent = "Record audio";
    btn.className = "rec";
    hint.textContent = st.busy
      ? "Already recording another tab."
      : "Adds a local transcript from the audio. Shortcut: Option+Shift+R.";
    btn.disabled = !!st.busy;
    btn.onclick = async () => {
      btn.textContent = "Starting…";
      let streamId;
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      } catch (err) {
        hint.textContent = `Chrome refused: ${err.message}`;
        return;
      }
      const res = await ask("startRecording", { tabId: tab.id, streamId });
      if (!res.ok) hint.textContent = res.error || "Could not start recording.";
      paintAudio();
    };
  } else {
    btn.hidden = true;
    hint.textContent = "Join a call with captions running to record its audio.";
  }
}

paintAudio();
