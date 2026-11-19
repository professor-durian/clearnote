// Orchestrator. Picks the adapter for this page, waits until the call is
// actually joined, turns the platform's captions on, watches the caption region
// and streams finalized segments to the service worker.
(function () {
  const CN = (window.ClearNote = window.ClearNote || {});
  if (window.__clearnoteBooted) return;
  window.__clearnoteBooted = true;

  // One line on every page the script runs on, debug mode or not. Without it,
  // "nothing happened" is indistinguishable from "the script never loaded",
  // which is the hardest thing to tell apart when a selector goes stale.
  const banner = "color:#4aa3df;font-weight:700";

  const adapter = (CN.adapters || []).find((a) => {
    try {
      return a.matches();
    } catch {
      return false;
    }
  });
  if (!adapter) {
    console.log(
      "%c[ClearNote]",
      banner,
      `loaded, but ${location.host}${location.pathname} is not a meeting page — nothing to capture here.`,
    );
    return;
  }
  console.log("%c[ClearNote]", banner, `${adapter.label} detected. Waiting for you to join the call.`);

  const isTop = window.top === window;
  let session = null; // { id, startedAt }
  let segmenter = null;
  let observer = null;
  let sidebar = null;
  let capturing = false;
  let paused = false;
  let leftTicks = 0;
  let myName = "";
  let wantHide = false;
  const finalized = [];

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

  function paint(patch = {}) {
    if (!sidebar) return;
    const tail = finalized.slice(-40).concat(segmenter ? segmenter.pending() : []);
    sidebar.update({
      segments: tail,
      speakers: segmenter ? Array.from(segmenter.speakers) : [],
      ...patch,
    });
  }

  // Debug console API. Content scripts run in an isolated world, so this is
  // reached by switching the DevTools console context to "ClearNote" — see the
  // README. It is deliberately not injected into the page's own world, where
  // the meeting site could reach it.
  const diag = new CN.Diagnostics(adapter, null);
  window.__clearnote = {
    adapter,
    probe: () => diag.probe(),
    show: () => diag.show(),
    record: () => diag.record(),
    stop: () => diag.stop(),
    save: (opts) => diag.save(opts),
    saveProbe: () => diag.save({ redact: false, what: diag.probe() }),
    get segmenter() {
      return segmenter;
    },
    get transcript() {
      return finalized.slice();
    },
  };

  // Captions have to be on for there to be anything to read, but they do not
  // have to be in your way: ClearNote shows the same text in its own panel.
  // We collapse the overlay to zero height so it reclaims its screen space,
  // but keep it in the DOM (not display:none) so Meet keeps updating it.
  const HIDE_PROPS = [
    "position:fixed",
    "height:0",
    "min-height:0",
    "max-height:0",
    "overflow:hidden",
    "padding:0",
    "margin:0",
    "border:none",
    "opacity:0",
    "pointer-events:none",
    "z-index:-1",
  ].map((p) => `${p} !important`).join(";");

  function hideCaptionOverlay() {
    const sel = (adapter.selectors?.overlay || []).join(",");
    if (!sel) return;
    const style = document.createElement("style");
    style.id = "clearnote-hide-captions";
    style.textContent = `${sel} { ${HIDE_PROPS}; }`;
    document.documentElement.append(style);
    CN.log("hiding the platform's caption overlay (CSS)");
  }

  // CSS selectors catch known containers, but scheduled meetings may wrap
  // captions in a parent the selectors don't cover. This function finds the
  // live caption root element and walks up, collapsing any ancestor that
  // looks like a caption overlay (positioned container whose only purpose
  // is to display captions).
  function hideCaptionOverlayDynamic() {
    const root = adapter.captionRoot();
    if (!root) return;
    const tag = "clearnoteHidden";
    if (root.dataset[tag]) return;
    root.style.cssText += `;${HIDE_PROPS}`;
    root.dataset[tag] = "1";

    let el = root.parentElement;
    for (let i = 0; i < 5 && el && el !== document.body; i++, el = el.parentElement) {
      const s = getComputedStyle(el);
      const isOverlay =
        s.position === "fixed" || s.position === "absolute" ||
        /caption/i.test(el.className) ||
        /caption/i.test(el.getAttribute("aria-label") || "") ||
        /caption/i.test(el.getAttribute("data-tid") || "");
      if (isOverlay) {
        el.style.cssText += `;${HIDE_PROPS}`;
        el.dataset[tag] = "1";
        CN.log(`collapsed caption ancestor: <${el.tagName.toLowerCase()}> class="${el.className}"`);
      }
    }
    CN.log("dynamic caption overlay hiding applied");
  }

  async function boot() {
    const settings = await send("getSettings");
    CN.debug = !!settings.debug;
    myName = CN.normalize(settings.displayName);
    wantHide = !!settings.hideCaptions;
    if (wantHide) hideCaptionOverlay();

    if (CN.debug) {
      CN.log(`debug mode on — __clearnote.show() reports what ${adapter.label} is exposing`);
    }

    // "full" panel, "compact" pill, or "hidden" (nothing on the page; the
    // ClearNote icon in Chrome's toolbar still shows the state).
    const panelMode = settings.panelMode || "compact";
    if (isTop && panelMode !== "hidden") {
      sidebar = new CN.Sidebar({
        collapsed: panelMode === "compact",
        dashboardUrl: settings.dashboardUrl || "http://localhost:8787",
        debug: CN.debug,
        onToggleCapture: () => {
          paused = !paused;
          paint({ status: paused ? "paused" : "capturing", statusText: paused ? "Paused" : "Capturing" });
        },
        onDiagnose: () => {
          const r = diag.show();
          paint({ note: r.verdict });
        },
        onRecord: (on) => {
          if (on) {
            const started = diag.record();
            paint({ note: started ? "Recording the caption region." : "No caption region to record." });
          } else {
            const rec = diag.stop();
            if (!rec) return paint({ note: "Nothing was recorded." });
            diag.save({ redact: true });
            paint({ note: `Saved ${rec.frames.length} frames, redacted. Replay it in caption-replay.html.` });
          }
        },
      });
      if (settings.autoCapture === false) {
        paint({ status: "idle", statusText: "Auto-capture is off" });
        return;
      }
      paint({ statusText: `Waiting to join the ${adapter.label} call` });
    }

    CN.log(`adapter: ${adapter.id}, url: ${location.href}`);
    await adapter.waitForJoin();
    CN.log(`joined — url now: ${location.href}, key: ${adapter.meetingKey()}`);
    if (isTop) paint({ statusText: "Turning on captions" });

    const ok = await adapter.enableCaptions();
    if (!ok) {
      CN.log("captions did not appear");
      if (isTop) {
        paint({
          status: "error",
          statusText: "Turn on captions in the call to start capturing",
        });
      }
      // Keep trying: the user may switch them on by hand.
      const root = await CN.waitFor(() => adapter.captionRoot(), {
        timeout: 0x7fffffff,
        interval: 2000,
      });
      if (!root) return;
    }

    if (wantHide) hideCaptionOverlayDynamic();

    // Only one frame owns the session for a given meeting.
    const meetingKey = adapter.meetingKey();
    const claim = await send("claimSession", { meetingKey });
    if (claim.owner === false) {
      CN.log("another frame already owns this meeting");
      return;
    }

    const startedAt = Date.now();
    const created = await send("startSession", {
      meetingKey,
      platform: adapter.id,
      platformLabel: adapter.label,
      title: adapter.meetingTitle(),
      url: location.href,
      startedAt,
    });
    session = { id: created.sessionId || meetingKey, startedAt };

    segmenter = new CN.Segmenter({
      startedAt,
      onSegment: (seg) => {
        finalized.push(seg);
        send("segments", { sessionId: session.id, segments: [seg] });
        paint();
      },
    });

    diag.segmenter = segmenter;
    startObserving();
    capturing = true;
    if (isTop) {
      paint({
        status: "capturing",
        statusText: "Capturing",
        note: "Captions on. To record audio too, click the ClearNote icon in Chrome's toolbar (or press Option+Shift+R).",
      });
    }
    watchForEnd();
  }

  function startObserving() {
    let root = adapter.captionRoot();
    // Joining a call already in progress means captions are already on screen.
    // Those words were spoken before we started; record them as context so they
    // are not transcribed, rather than attributing them to this moment.
    let primed = false;

    const read = () => {
      if (paused || !segmenter) return;
      if (!root || !root.isConnected) {
        root = adapter.captionRoot();
        if (!root) return;
        if (wantHide) hideCaptionOverlayDynamic();
        attach();
      }
      for (const { key, speaker, text } of adapter.readCaptions(root)) {
        if (primed) segmenter.observe(key, CN.resolveSpeaker(speaker, myName), text);
        else segmenter.prime(key, text);
      }
      primed = true;
    };

    const attach = () => {
      observer?.disconnect();
      observer = new MutationObserver(read);
      if (root) {
        observer.observe(root, { childList: true, subtree: true, characterData: true });
        CN.log("observing the caption region");
      }
    };

    attach();
    read();
    // Captions can be toggled off and back on, which replaces the container, and
    // a few renders mutate text without firing a characterData record.
    setInterval(read, 1000);
    setInterval(() => paint(), 1200);
  }

  function watchForEnd() {
    const tick = setInterval(async () => {
      if (!adapter.hasLeft()) {
        leftTicks = 0;
        return;
      }
      // Three consecutive checks, so a re-render of the toolbar is not mistaken
      // for leaving the call.
      if (++leftTicks < 3) return;
      clearInterval(tick);
      await end("left_call");
    }, 2000);

    window.addEventListener("pagehide", () => end("page_closed"), { once: true });
  }

  let ended = false;
  async function end(reason) {
    if (ended || !session) return;
    ended = true;
    capturing = false;
    observer?.disconnect();
    segmenter?.flushAll();
    segmenter?.destroy();
    await send("endSession", {
      sessionId: session.id,
      endedAt: Date.now(),
      reason,
      speakers: segmenter ? Array.from(segmenter.speakers) : [],
      title: adapter.meetingTitle(),
    });
    CN.log(`session ended (${reason}), ${finalized.length} segments`);
    if (isTop) {
      paint({
        status: "idle",
        statusText: `Saved ${finalized.length} lines — writing the summary`,
      });
    }
  }

  // Audio recording is started from the extension icon; reflect it here.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "recordingState" || !isTop) return;
    const { on, mic, error } = msg.payload || {};
    paint({
      recordingAudio: !!on && !error,
      note: error
        ? error
        : on
          ? `Recording audio${mic ? " and your mic" : ""}. Stop from the ClearNote icon or Option+Shift+R.`
          : "Audio recording stopped. Captions continue.",
    });
  });

  boot().catch((err) => {
    console.error("[ClearNote] boot failed", err);
    if (isTop) paint({ status: "error", statusText: "ClearNote hit an error — see the console" });
  });
})();
