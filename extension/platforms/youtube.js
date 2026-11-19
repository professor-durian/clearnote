// YouTube reader. Nothing happens on YouTube until you click the ClearNote icon.
// Then it takes the video's full transcript (the "Show transcript" panel), or,
// for a video without one, reads the captions as the video plays.
//
// YouTube captions carry no speaker names, so every line is credited to the
// channel. Selectors fall back through a few known shapes; YouTube changes them.
(function () {
  if (window.__clearnoteYouTube) return;
  window.__clearnoteYouTube = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (type, payload) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (res) => {
          void chrome.runtime.lastError;
          resolve(res || {});
        });
      } catch {
        resolve({});
      }
    });

  const videoId = () => new URLSearchParams(location.search).get("v");
  const title = () =>
    document.querySelector("h1.ytd-watch-metadata yt-formatted-string, h1.title")?.textContent?.trim() ||
    document.title.replace(/ - YouTube$/, "");
  const channel = () =>
    document.querySelector("ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a, #channel-name a")?.textContent?.trim() ||
    "Speaker";
  const video = () => document.querySelector("video.html5-main-video, video");

  /** "1:02:03" → ms */
  function parseStamp(s) {
    const parts = String(s || "").trim().split(":").map(Number);
    if (parts.some(Number.isNaN)) return 0;
    return parts.reduce((acc, n) => acc * 60 + n, 0) * 1000;
  }

  const SEGMENTS = "ytd-transcript-segment-renderer, transcript-segment-view-model";

  /** Open the transcript panel if needed and read every line. */
  async function readTranscriptPanel() {
    let rows = document.querySelectorAll(SEGMENTS);
    if (!rows.length) {
      document.querySelector("#description-inline-expander #expand, tp-yt-paper-button#expand, #expand")?.click();
      await sleep(400);
      const btn =
        document.querySelector("ytd-video-description-transcript-section-renderer button") ||
        [...document.querySelectorAll("button")].find((b) => /transcript/i.test(b.getAttribute("aria-label") || b.textContent || ""));
      if (!btn) return null;
      btn.click();
      for (let i = 0; i < 40 && !document.querySelectorAll(SEGMENTS).length; i++) await sleep(250);
      rows = document.querySelectorAll(SEGMENTS);
    }
    if (!rows.length) return null;
    const lines = [...rows]
      .map((r) => ({
        // 2026 layout: .ytwTranscriptSegmentViewModelTimestamp; older: .segment-timestamp
        startMs: parseStamp(
          r.querySelector(".ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp")?.textContent ||
            [...r.querySelectorAll("div, span")].find((n) => /^\s*\d+(:\d{2}){1,2}\s*$/.test(n.textContent))?.textContent,
        ),
        text: (r.querySelector(".segment-text, yt-formatted-string, [class*='segment-text'], span[role='text']")?.textContent || r.textContent || "")
          .replace(/^\s*[\d:]+\s*/, "")
          .replace(/\s+/g, " ")
          .trim(),
      }))
      .filter((l) => l.text);
    return lines.length ? lines : null;
  }

  // ---- live captions, for videos without a transcript
  let live = null; // { sessionId, seq, last, observer, timer }

  async function startLiveCaptions(sessionId) {
    const v = video();
    // Turn captions on if YouTube offers them.
    const cc = document.querySelector(".ytp-subtitles-button");
    if (cc && cc.getAttribute("aria-pressed") === "false") cc.click();
    live = { sessionId, seq: 0, last: "", buffer: [] };
    const read = () => {
      const text = [...document.querySelectorAll(".ytp-caption-segment")].map((n) => n.textContent).join(" ").replace(/\s+/g, " ").trim();
      if (!text || text === live.last) return;
      // Keep only what is new compared with the previous caption window.
      const fresh = text.startsWith(live.last) ? text.slice(live.last.length).trim() : text;
      live.last = text;
      if (!fresh) return;
      const t = Math.round((v?.currentTime || 0) * 1000);
      live.seq += 1;
      send("segments", { sessionId, segments: [{ seq: live.seq, speaker: channel(), text: fresh, startMs: t, endMs: t + 2000 }] });
    };
    live.timer = setInterval(read, 700);
    v?.addEventListener("ended", () => stopLive("video_ended"), { once: true });
  }

  async function stopLive(reason = "stopped") {
    if (!live) return;
    clearInterval(live.timer);
    const { sessionId, seq } = live;
    live = null;
    await send("endSession", { sessionId, endedAt: Date.now(), reason, speakers: [channel()], title: title() });
    return seq;
  }
  window.addEventListener("yt-navigate-start", () => stopLive("navigated"));

  async function capture({ again = false } = {}) {
    if (!videoId()) return { ok: false, error: "Open a video first." };
    if (live) return { ok: true, mode: "live", note: "Already reading this video's captions." };
    const startedAt = Date.now();
    const base = {
      meetingKey: `youtube:${videoId()}`,
      platform: "youtube",
      platformLabel: "YouTube",
      title: title(),
      url: `https://www.youtube.com/watch?v=${videoId()}`,
      startedAt,
    };
    if (!again) {
      const prior = await send("startSession", { ...base, reuse: true });
      if (prior.existing) return { ok: true, mode: "exists", id: prior.sessionId };
      if (prior.sessionId) {
        // No earlier capture: this new session is the one to fill.
        return fill(prior.sessionId, startedAt);
      }
      return { ok: false, error: "ClearNote's server isn't reachable." };
    }
    const created = await send("startSession", base);
    if (!created.sessionId) return { ok: false, error: "ClearNote's server isn't reachable." };
    return fill(created.sessionId, startedAt);
  }

  async function fill(sessionId, startedAt) {
    const lines = await readTranscriptPanel();

    if (lines) {
      const who = channel();
      const segments = lines.map((l, i) => ({
        seq: i + 1,
        speaker: who,
        text: l.text,
        startMs: l.startMs,
        endMs: lines[i + 1]?.startMs ?? l.startMs + 4000,
      }));
      for (let i = 0; i < segments.length; i += 200) await send("segments", { sessionId, segments: segments.slice(i, i + 200) });
      const durationMs = Math.round((video()?.duration || 0) * 1000) || segments[segments.length - 1].endMs;
      await send("endSession", { sessionId, endedAt: startedAt + durationMs, reason: "transcript", speakers: [who], title: title() });
      return { ok: true, mode: "transcript", lines: segments.length };
    }
    await startLiveCaptions(sessionId);
    return { ok: true, mode: "live" };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type === "ytCapture") {
      capture({ again: !!msg.again }).then(respond).catch((err) => respond({ ok: false, error: err.message }));
      return true;
    }
    if (msg?.type === "ytStop") {
      stopLive("stopped").then((n) => respond({ ok: true, lines: n || 0 }));
      return true;
    }
    if (msg?.type === "ytState") {
      respond({ live: !!live, video: !!videoId() });
      return false;
    }
    return false;
  });
})();
