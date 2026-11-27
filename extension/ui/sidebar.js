// Draggable in-call panel: capture status, live transcript, dashboard link.
// Rendered into a shadow root so the meeting app's stylesheet cannot touch it.
(function () {
  const CN = (window.ClearNote = window.ClearNote || {});

  // A relative url() inside the shadow root would resolve against the meeting
  // page, so the mark is addressed by its extension URL.
  const MARK = (() => {
    try {
      return `url("${chrome.runtime.getURL("icons/mark.svg")}")`;
    } catch {
      return "linear-gradient(140deg,#6fd3ff,#2f7cf6)"; // outside the extension (test harness)
    }
  })();

  const STYLE = `
    :host { all: initial; --cn-mark: ${MARK};
      position: fixed; bottom: 80px; right: 20px; z-index: 2147483647;
      width: 320px;
      /* The box around the panel can be taller than what's drawn (after a
         drag it is pinned top and bottom). Only the visible parts take
         clicks, so the call's own buttons underneath keep working. */
      pointer-events: none; }
    :host > * { pointer-events: auto; }
    :host(.cn-sharing) { display: none !important; }
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .panel {
      display: flex; flex-direction: column; max-height: calc(100vh - 80px);
      background: #11161d; color: #e6edf3; border: 1px solid #2a3340;
      border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden;
    }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      background: #161c25; border-bottom: 1px solid #2a3340; cursor: grab; user-select: none; }
    .head:active { cursor: grabbing; }
    .mark { width: 20px; height: 20px; flex: none;
      background: var(--cn-mark) center/contain no-repeat; }
    .title { font-size: 13px; font-weight: 650; letter-spacing: .01em; }
    .spacer { flex: 1; }
    .state { font-size: 11px; color: #8b97a6; white-space: nowrap; }
    .state.warn { color: #f0b429; }
    .iconbtn { background: none; border: 0; color: #8b97a6; cursor: pointer;
      font-size: 15px; line-height: 1; padding: 4px 6px; border-radius: 6px; }
    .iconbtn:hover { background: #222b36; color: #e6edf3; }
    .meta { padding: 8px 12px; font-size: 11px; color: #8b97a6;
      border-bottom: 1px solid #202834; display: flex; gap: 10px; }
    .meta b { color: #c6d2e0; font-weight: 600; }
    .feed { overflow-y: auto; padding: 6px 12px 12px; flex: 1 1 0; min-height: 300px;
      scrollbar-width: thin; scrollbar-color: #2a3340 transparent; }
    .seg { padding: 7px 0; border-bottom: 1px solid #1a212b; }
    .seg:last-child { border-bottom: 0; }
    .who { font-size: 11px; font-weight: 650; color: #6fd3ff; display: flex; gap: 6px; }
    .who .t { color: #5b6675; font-weight: 500; font-variant-numeric: tabular-nums; }
    .say { font-size: 12.5px; line-height: 1.45; margin-top: 2px; color: #d7e0ea; }
    .seg.partial .say { color: #94a3b4; font-style: italic; }
    .empty { font-size: 12px; color: #7a8492; padding: 14px 2px; line-height: 1.5; }
    .foot { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #202834; background: #0e131a; }
    .btn { flex: 1; text-align: center; font-size: 12px; font-weight: 600; padding: 7px 10px;
      border-radius: 8px; border: 1px solid #2a3340; background: #1a222c; color: #d7e0ea;
      cursor: pointer; text-decoration: none; }
    .btn:hover { background: #222c38; }
    .btn.primary { background: #2f7cf6; border-color: #2f7cf6; color: #fff; }
    .btn.primary:hover { background: #3f88fb; }
    .foot.debug { border-top: 0; padding-top: 0; }
    .btn.rec { border-color: #f0734a; color: #f0734a; }
    .note { padding: 9px 12px; font-size: 11.5px; line-height: 1.5; color: #e6c88a;
      background: rgba(240,180,41,.09); border-top: 1px solid #202834; }
    .collapsed { padding: 8px 10px; display: flex; align-items: center; gap: 8px;
      background: #11161d; border: 1px solid #2a3340; border-radius: 999px; cursor: pointer; }
    .collapsed .title { font-size: 12px; }
  `;

  class Sidebar {
    constructor({ dashboardUrl, onToggleCapture, debug = false, onDiagnose, onRecord, collapsed = false }) {
      this.dashboardUrl = dashboardUrl;
      this.onToggleCapture = onToggleCapture;
      this.debug = debug;
      this.onDiagnose = onDiagnose;
      this.onRecord = onRecord;
      this.recording = false;
      this.collapsed = collapsed;
      this.host = document.createElement("div");
      this.host.id = "clearnote-host";
      this.root = this.host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = STYLE;
      this.root.append(style);
      this.body = document.createElement("div");
      this.root.append(this.body);
      document.documentElement.append(this.host);
      this.state = {
        status: "idle",
        statusText: "Waiting for the call",
        segments: [],
        speakers: [],
        note: "",
      };
      this.render();
      this._drag();
      this._watchScreenShare();
    }

    update(patch) {
      Object.assign(this.state, patch);
      this.render();
    }

    render() {
      const s = this.state;
      this.host.dataset.collapsed = String(this.collapsed);

      if (this.collapsed) {
        this.body.innerHTML = `<div class="collapsed"><span class="mark"></span>
          <span class="title">ClearNote</span>
          <span class="state ${s.status === "error" ? "warn" : ""}">${esc(this._short(s))}</span></div>`;
        this.body.querySelector(".collapsed").onclick = () => {
          this.collapsed = false;
          this.render();
        };
        return;
      }

      const rows = s.segments.length
        ? s.segments
            .map(
              (seg) => `<div class="seg ${seg.partial ? "partial" : ""}">
                <div class="who">${esc(seg.speaker)}<span class="t">${CN.fmtClock(seg.startMs)}</span></div>
                <div class="say">${esc(seg.text)}</div></div>`,
            )
            .join("")
        : `<div class="empty">${esc(
            s.status === "capturing"
              ? "Listening. Lines appear here as people speak."
              : s.statusText,
          )}</div>`;

      this.body.innerHTML = `
        <div class="panel">
          <div class="head" part="head">
            <span class="mark"></span><span class="title">ClearNote</span>
            <span class="spacer"></span>
            <button class="iconbtn" data-act="collapse" title="Make small">–</button>
          </div>
          <div class="meta">
            <span><b>${s.segments.filter((x) => !x.partial).length}</b> lines</span>
            <span><b>${s.speakers.length}</b> speakers</span>
            <span class="spacer"></span>
            <span>${esc(s.statusText)}</span>
          </div>
          <div class="feed">${rows}</div>
          ${s.note ? `<div class="note">${esc(s.note)}</div>` : ""}
          <div class="foot">
            <button class="btn" data-act="toggle">${s.status === "capturing" ? "Pause" : "Resume"}</button>
            <a class="btn primary" href="${esc(this.dashboardUrl)}" target="_blank" rel="noreferrer">Dashboard</a>
          </div>
          ${
            this.debug
              ? `<div class="foot debug">
                   <button class="btn" data-act="diagnose">Diagnose</button>
                   <button class="btn ${this.recording ? "rec" : ""}" data-act="record">
                     ${this.recording ? "Stop & save" : "Record"}
                   </button>
                 </div>`
              : ""
          }
        </div>`;

      this.body.querySelector('[data-act="collapse"]').onclick = () => {
        this.collapsed = true;
        this.render();
      };
      this.body.querySelector('[data-act="toggle"]').onclick = () => this.onToggleCapture?.();

      const diagnose = this.body.querySelector('[data-act="diagnose"]');
      if (diagnose) diagnose.onclick = () => this.onDiagnose?.();
      const record = this.body.querySelector('[data-act="record"]');
      if (record)
        record.onclick = () => {
          this.recording = !this.recording;
          this.onRecord?.(this.recording);
          this.render();
        };

      const feed = this.body.querySelector(".feed");
      if (feed) feed.scrollTop = feed.scrollHeight;
    }

    /** One or two words for the small pill. */
    _short(s) {
      if (s.recordingAudio) return "recording audio";
      if (s.status === "capturing") return "captions on";
      if (s.status === "paused") return "paused";
      if (s.status === "error") return "needs attention";
      return "waiting";
    }

    _drag() {
      let sx = 0,
        sy = 0,
        ox = 0,
        oy = 0,
        dragging = false;
      const down = (e) => {
        const head = e.target.closest?.(".head");
        if (!head || e.target.closest("button")) return;
        dragging = true;
        const r = this.host.getBoundingClientRect();
        sx = e.clientX;
        sy = e.clientY;
        ox = r.left;
        oy = r.top;
        e.preventDefault();
      };
      const move = (e) => {
        if (!dragging) return;
        this.host.style.left = `${ox + e.clientX - sx}px`;
        this.host.style.top = `${oy + e.clientY - sy}px`;
        this.host.style.right = "auto";
      };
      const up = () => (dragging = false);
      this.root.addEventListener("mousedown", down);
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    }

    _watchScreenShare() {
      const host = this.host;
      const orig = navigator.mediaDevices?.getDisplayMedia;
      if (!orig) return;
      navigator.mediaDevices.getDisplayMedia = function (...args) {
        return orig.apply(this, args).then((stream) => {
          host.classList.add("cn-sharing");
          const onEnd = () => host.classList.remove("cn-sharing");
          for (const track of stream.getTracks()) {
            track.addEventListener("ended", onEnd);
          }
          stream.addEventListener("removetrack", () => {
            if (stream.getTracks().length === 0) onEnd();
          });
          return stream;
        });
      };
    }

    destroy() {
      this.host.remove();
    }
  }

  function esc(s) {
    return String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  CN.Sidebar = Sidebar;
})();
