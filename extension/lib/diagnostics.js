// Debug mode: tells you what the adapter actually sees in a live call, and
// records the caption region so a real meeting can be replayed offline.
//
// Selectors break when Google or Microsoft rotate their obfuscated class names,
// and you cannot tune a selector you cannot see. Two tools here:
//
//   probe()   a one-shot report — which selectors still match, which row the
//             adapter built from them, and whether it fell back to structure.
//   record()  captures the caption region's HTML on every change. The result
//             replays through tools/caption-replay.html, so a call that went
//             wrong becomes a fixture you can fix against without rejoining a
//             meeting.
//
// A recording contains what people said. `redact` strips that out while keeping
// the DOM shape that selector tuning depends on, so a fixture can be shared.
(function () {
  const CN = (window.ClearNote = window.ClearNote || {});

  const MAX_FRAMES = 3000;
  const MAX_HTML = 64 * 1024; // per frame; caption regions are small
  const MAX_TOTAL = 12 * 1024 * 1024;

  /** Which of a selector list's entries match right now, and how many nodes. */
  function probeList(selectors, root) {
    return (selectors || []).map((sel) => {
      let count = 0;
      let error = null;
      try {
        count = (root || document).querySelectorAll(sel).length;
      } catch (err) {
        error = err.message; // an invalid selector should report, not throw
      }
      return { selector: sel, count, error };
    });
  }

  class Diagnostics {
    constructor(adapter, segmenter) {
      this.adapter = adapter;
      this.segmenter = segmenter;
      this.recording = null;
      this.observer = null;
    }

    /** A snapshot of what the adapter can see at this instant. */
    probe() {
      const a = this.adapter;
      const sel = a.selectors || {};
      const root = a.captionRoot();
      const parsed = root ? a.readCaptions(root) : [];

      const report = {
        at: new Date().toISOString(),
        url: location.href,
        adapter: a.id,
        joined: !a.hasLeft(),
        captionRootFound: !!root,
        captionsOn: a.captionState?.() === "on",
        selectors: {
          captionRoot: probeList(sel.captionRoot, document),
          leave: probeList(sel.leave, document),
          rows: probeList(sel.rows, root),
          speaker: probeList(sel.speaker, root),
          text: probeList(sel.text, root),
        },
        rows: parsed.map((r) => ({ speaker: r.speaker, text: r.text, via: r.via })),
        usingFallback: parsed.some((r) => r.via === "fallback"),
        captionRootHtml: root ? truncate(root.outerHTML, 20000) : null,
        segments: this.segmenter ? this.segmenter.seq : 0,
      };

      // The diagnosis, so you do not have to read the tables to get the point.
      report.verdict = verdict(report);
      return report;
    }

    /** Print the probe as a readable console report. */
    show() {
      const r = this.probe();
      const g = console.group ? console.group.bind(console) : console.log.bind(console);
      g(`%cClearNote — ${r.adapter}`, "color:#4aa3df;font-weight:700");
      console.log(r.verdict);
      console.log(`caption region found: ${r.captionRootFound}   in call: ${r.joined}`);
      for (const [name, list] of Object.entries(r.selectors)) {
        const hits = list.filter((x) => x.count > 0);
        console.log(
          `  ${name.padEnd(12)} ${hits.length ? `✓ ${hits.map((h) => `${h.selector} (${h.count})`).join(", ")}` : "✗ no selector matched"}`,
        );
      }
      if (r.rows.length) console.table(r.rows);
      else console.log("  no caption rows parsed right now — is anyone speaking?");
      console.groupEnd?.();
      return r;
    }

    /**
     * Start recording the caption region. Captures the root's HTML whenever it
     * changes; identical consecutive frames are skipped.
     */
    record() {
      if (this.recording) return this.recording;
      const root = this.adapter.captionRoot();
      if (!root) {
        console.warn("[ClearNote] cannot record: no caption region found. Are captions on?");
        return null;
      }

      this.recording = {
        meta: {
          startedAt: Date.now(),
          adapter: this.adapter.id,
          url: location.href,
          title: this.adapter.meetingTitle(),
          userAgent: navigator.userAgent,
          redacted: false,
          // Replay has to use the same silence threshold to split utterances
          // where the live capture did.
          silenceMs: this.segmenter?.silenceMs ?? 2500,
        },
        frames: [],
        dropped: 0,
        bytes: 0,
      };

      let last = null;
      const capture = () => {
        const rec = this.recording;
        if (!rec) return;
        const live = this.adapter.captionRoot();
        if (!live) return;
        const html = live.outerHTML;
        if (html === last) return;
        last = html;

        if (rec.frames.length >= MAX_FRAMES || rec.bytes >= MAX_TOTAL) {
          rec.dropped++;
          return;
        }
        const clipped = truncate(html, MAX_HTML);
        rec.bytes += clipped.length;
        // The first frame is whatever was already on screen when recording
        // began — speech from before the recording. Replay primes the segmenter
        // with it instead of transcribing it as new.
        const frame = { t: Date.now() - rec.meta.startedAt, html: clipped };
        if (!rec.frames.length) frame.baseline = true;
        rec.frames.push(frame);
      };

      this.observer = new MutationObserver(capture);
      this.observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
      // The region is replaced outright when captions are toggled, and some
      // repaints fire no mutation record at all.
      this._timer = setInterval(capture, 500);
      capture();

      console.log("%c[ClearNote] recording the caption region", "color:#3ddc84;font-weight:700");
      console.log("  stop with  __clearnote.stop()   then  __clearnote.save()");
      return this.recording;
    }

    stop() {
      this.observer?.disconnect();
      clearInterval(this._timer);
      this.observer = null;
      const rec = this.recording;
      this.recording = null;
      if (!rec) return null;
      rec.meta.endedAt = Date.now();
      rec.meta.durationMs = rec.meta.endedAt - rec.meta.startedAt;
      console.log(
        `[ClearNote] recorded ${rec.frames.length} frames over ${Math.round(rec.meta.durationMs / 1000)}s` +
          (rec.dropped ? ` (${rec.dropped} dropped at the size cap)` : ""),
      );
      this.last = rec;
      return rec;
    }

    /**
     * Replace every word of visible text while keeping the DOM structure,
     * class names and word shapes. Selector tuning needs the structure; it does
     * not need to know what anybody said.
     */
    static redact(recording) {
      const doc = new DOMParser();
      const names = new Map();

      const scrub = (html) => {
        const parsed = doc.parseFromString(`<div id="cn-r">${html}</div>`, "text/html");
        const host = parsed.getElementById("cn-r");
        const walker = parsed.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const n of nodes) {
          const raw = n.nodeValue;
          if (!raw.trim()) continue;
          n.nodeValue = looksLikeName(raw) ? pseudonym(raw, names) : maskWords(raw);
        }
        return host.innerHTML;
      };

      return {
        meta: {
          ...recording.meta,
          redacted: true,
          url: redactUrl(recording.meta.url),
          title: "(redacted)",
        },
        frames: recording.frames.map((f) => ({ t: f.t, baseline: f.baseline, html: scrub(f.html) })),
        speakerMap: Object.fromEntries(names),
      };
    }

    /** Download a recording (or the probe) as JSON. */
    save({ redact = true, what } = {}) {
      let data = what || this.last;
      if (!data) {
        console.warn("[ClearNote] nothing recorded yet — run __clearnote.record() first");
        return;
      }
      if (redact && data.frames) data = Diagnostics.redact(data);

      const name = `clearnote-${data.meta?.adapter || "probe"}-${
        redact && data.frames ? "redacted-" : ""
      }${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      console.log(`[ClearNote] saved ${name}`);
      return name;
    }
  }

  // ---------------------------------------------------------------- helpers

  function truncate(s, n) {
    return s.length > n ? `${s.slice(0, n)}<!-- clearnote: truncated -->` : s;
  }

  function redactUrl(url) {
    try {
      const u = new URL(url);
      return `${u.origin}/(redacted)`; // meeting codes are credentials
    } catch {
      return "(redacted)";
    }
  }

  // Two to four capitalised words and no sentence punctuation reads as a name.
  function looksLikeName(s) {
    const t = s.trim();
    if (t.length > 48 || /[.!?,;:]/.test(t)) return false;
    const words = t.split(/\s+/);
    return words.length <= 4 && words.every((w) => /^[\p{Lu}][\p{L}'’-]*$/u.test(w));
  }

  function pseudonym(raw, names) {
    const key = raw.trim();
    if (!names.has(key)) names.set(key, `Speaker ${String.fromCharCode(65 + names.size)}`);
    return raw.replace(key, names.get(key));
  }

  // Keep word lengths and punctuation; replace the letters and digits.
  function maskWords(s) {
    return s.replace(/[\p{L}\p{N}]/gu, (ch) => (/\p{Lu}/u.test(ch) ? "X" : /\p{N}/u.test(ch) ? "0" : "x"));
  }

  function verdict(r) {
    if (!r.captionRootFound) {
      if (r.joined && r.captionsOn) return "Captions are on, but nothing has been said yet, so there is nothing to read.";
      return r.joined
        ? "No caption region found. Either captions are off in the call, or the captionRoot selectors need updating."
        : "Not in a call yet, so there is nothing to find.";
    }
    if (!r.rows.length) {
      return "Caption region found but no rows parsed. If someone is speaking, the row selectors need updating.";
    }
    if (r.usingFallback) {
      return "Working, but via the structural fallback — the named selectors have gone stale and should be updated.";
    }
    const unknown = r.rows.filter((x) => x.speaker === "Unknown speaker").length;
    if (unknown === r.rows.length) {
      return "Captions are being read but no speaker names are resolving — the speaker selectors need updating.";
    }
    return "Healthy: caption region found and parsed with the named selectors.";
  }

  CN.Diagnostics = Diagnostics;
  CN._diagInternals = { looksLikeName, maskWords, redactUrl, verdict, probeList };
})();
