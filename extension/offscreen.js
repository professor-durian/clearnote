// Offscreen recorder. MV3 service workers cannot hold a media stream, so the
// recording lives here. Two tracks, uploaded in chunks as the call runs:
//   tab: the meeting's sound (everyone else), clean, straight from the tab
//   mic: you, if microphone access was granted in Settings
// Capturing a tab silences it, so the tab's sound is played back to you here.

const CHUNK_MS = 5000;

let rec = null; // { sessionId, startedAt, serverUrl, token, myName, tracks: [], ctx }

function upload(state, track, blob) {
  const seq = state.seq[track]++;
  const url =
    `${state.serverUrl.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(state.sessionId)}` +
    `/audio/${track}/chunk?seq=${seq}&offsetMs=${state.offsetMs[track]}`;
  // Chained per track so chunks arrive in order; each retries a few times.
  state.chain[track] = state.chain[track].then(async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/octet-stream", "x-clearnote-token": state.token || "" },
          body: blob,
        });
        if (res.ok) return;
        console.warn(`[ClearNote] ${track} chunk ${seq} -> ${res.status}`);
      } catch (err) {
        console.warn(`[ClearNote] ${track} chunk ${seq} failed: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  });
  return state.chain[track];
}

function startTrack(state, track, stream) {
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  const mr = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 });
  state.seq[track] = 0;
  state.chain[track] = Promise.resolve();
  state.offsetMs[track] = Math.max(0, Date.now() - state.startedAt);
  mr.ondataavailable = (e) => {
    if (e.data && e.data.size) upload(state, track, e.data);
  };
  mr.start(CHUNK_MS);
  state.tracks.push({ track, mr, stream });
}

async function start({ streamId, sessionId, startedAt, serverUrl, token, myName, withMic }) {
  if (rec) return { ok: false, error: "already recording" };
  const state = { sessionId, startedAt, serverUrl, token, myName, tracks: [], seq: {}, chain: {}, offsetMs: {}, mic: false };

  const tab = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false,
  });
  // Keep the call audible.
  state.ctx = new AudioContext();
  state.ctx.createMediaStreamSource(tab).connect(state.ctx.destination);
  startTrack(state, "tab", tab);
  // Closing the tab or Chrome stopping the capture ends the recording.
  tab.getAudioTracks()[0].addEventListener("ended", () => stop("tab_ended"));

  if (withMic) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      startTrack(state, "mic", mic);
      state.mic = true;
    } catch (err) {
      console.warn("[ClearNote] mic not available, recording the tab only:", err.message);
    }
  }
  rec = state;
  return { ok: true, mic: state.mic };
}

async function stop(reason = "stopped") {
  const state = rec;
  if (!state) return { ok: true };
  rec = null;
  const endMs = Date.now() - state.startedAt;
  await Promise.all(
    state.tracks.map(
      ({ track, mr, stream }) =>
        new Promise((resolve) => {
          mr.onstop = async () => {
            stream.getTracks().forEach((t) => t.stop());
            // The final chunk is queued by the dataavailable that precedes onstop.
            await state.chain[track];
            try {
              await fetch(
                `${state.serverUrl.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(state.sessionId)}/audio/${track}/finish`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json", "x-clearnote-token": state.token || "" },
                  body: JSON.stringify({ endMs, myName: state.myName, reason }),
                },
              );
            } catch (err) {
              console.warn(`[ClearNote] finish ${track} failed: ${err.message}`);
            }
            resolve();
          };
          if (mr.state !== "inactive") mr.stop();
          else mr.onstop();
        }),
    ),
  );
  state.ctx?.close();
  chrome.runtime.sendMessage({ type: "recordingStopped", payload: { reason } });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.target !== "offscreen") return false;
  const fn = msg.type === "start" ? start : msg.type === "stop" ? stop : null;
  if (!fn) return false;
  fn(msg.payload || {})
    .then(respond)
    .catch((err) => respond({ ok: false, error: err.message }));
  return true;
});
