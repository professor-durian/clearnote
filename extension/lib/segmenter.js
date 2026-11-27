// Turns the platform's rolling live captions into stable transcript segments.
//
// Every meeting platform renders captions as a small set of DOM nodes that it
// rewrites in place while someone keeps talking, then recycles for the next
// speaker. A naive MutationObserver dump therefore produces the same sentence
// dozens of times, each one a prefix of the next. The segmenter collapses that
// stream: one observation per mutation in, one finalized segment per utterance
// out.
(function () {
  const CN = (window.ClearNote = window.ClearNote || {});

  // Speech recognisers revise what they have already shown: punctuation first
  // ("Yes." becomes "Yes,"), then whole words once more context arrives
  // ("One. Captions are on" becomes "When captions are on"). Comparing raw
  // strings therefore reports a brand new utterance every few hundred
  // milliseconds, so comparisons ignore case and punctuation.
  const forCompare = (s) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ")
      .trim();

  const wordsOf = (s) => forCompare(s).split(" ").filter(Boolean);

  function commonPrefix(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }
  function commonSuffix(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
    return i;
  }

  // Reconcile a caption node's previous text with its new text.
  // Returns the merged string, or null when `next` is a different utterance.
  function mergeRolling(prev, next) {
    if (!prev) return next;
    if (next === prev) return prev;

    const p = forCompare(prev);
    const n = forCompare(next);

    // Same words, new punctuation or casing: the newer rendering is the better one.
    if (n === p) return next;
    if (n.startsWith(p)) return next; // growth
    if (p.startsWith(n)) return prev; // repaint flicker

    // Platforms trim words off the front once a caption block gets long, so the
    // new text can be a continuation that no longer contains the start. Find
    // the longest suffix of `prev` that is a prefix of `next` and join there.
    const max = Math.min(prev.length, next.length);
    for (let k = max; k >= 12; k--) {
      if (prev.endsWith(next.slice(0, k))) return prev + next.slice(k);
    }

    // The recogniser rewrote words it had already shown. If most of the words
    // still line up — from either end — this is the same utterance being
    // corrected, and the correction is what we want to keep.
    const pw = wordsOf(prev);
    const nw = wordsOf(next);
    const shorter = Math.min(pw.length, nw.length);
    if (shorter) {
      const enough = Math.min(Math.max(2, Math.ceil(shorter / 2)), shorter);
      if (commonPrefix(pw, nw) >= enough || commonSuffix(pw, nw) >= enough) return next;
    }

    return null; // genuinely unrelated -> this node was recycled
  }

  // What a node has added since its last segment. A revision can rewrite words
  // the earlier segment already carried, so the stored prefix is not always a
  // literal prefix any more — fall back to the whole text rather than slicing
  // at the wrong place and truncating the line.
  function newPart(state) {
    const { text, prefix } = state;
    if (!prefix) return text;
    if (text.startsWith(prefix)) return text.slice(prefix.length);
    // The recogniser corrected words it had already shown (Zoom does this), so
    // the text no longer starts with exactly what was written down. Line the
    // two up word by word; if most of what was written is still there at the
    // start, keep only the words after it.
    return startsLike(prefix, text) ? words(text).slice(words(prefix).length).join(" ") : text;
  }

  const words = (t) => t.split(/\s+/).filter(Boolean);
  const wordKey = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  /** Does `text` begin with (a corrected version of) `prefix`? Most words must line up. */
  function startsLike(prefix, text) {
    const pw = words(prefix);
    const tw = words(text);
    if (pw.length < 3 || tw.length < pw.length) return false;
    let same = 0;
    for (let i = 0; i < pw.length; i++) if (wordKey(pw[i]) === wordKey(tw[i])) same++;
    return same / pw.length >= 0.6;
  }

  // Someone who talks without pausing produces one enormous line: correct, but
  // unreadable, and it leaves a whole minute of speech behind a single
  // timestamp. Past a threshold an utterance is broken at sentence ends — the
  // only cut that does not land mid-thought.
  const SPLIT_OVER = 320; // leave anything shorter alone
  const TARGET = 200; // aim for chunks around this size
  const HARD = 480; // a "sentence" longer than this gets cut at a word

  function sentencesOf(text) {
    return text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [text];
  }

  function splitUtterance(text) {
    if (text.length <= SPLIT_OVER) return [text];

    const out = [];
    let cur = "";
    const flushLongRun = () => {
      // No punctuation to work with; fall back to word boundaries rather than
      // emitting something unreadable.
      while (cur.length > HARD) {
        const space = cur.lastIndexOf(" ", HARD);
        const at = space > HARD / 2 ? space : HARD;
        out.push(cur.slice(0, at).trim());
        cur = cur.slice(at).trim();
      }
    };

    for (const raw of sentencesOf(text)) {
      const s = raw.trim();
      if (!s) continue;
      if (cur && cur.length + 1 + s.length > TARGET) {
        out.push(cur);
        cur = s;
      } else {
        cur = cur ? `${cur} ${s}` : s;
      }
      flushLongRun();
    }
    if (cur) out.push(cur);
    return out.filter(Boolean);
  }

  /** Spread one utterance's time range over its parts, by length. */
  function timeSlices(parts, startMs, endMs) {
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    const span = Math.max(0, endMs - startMs);
    let at = 0;
    return parts.map((p) => {
      const from = startMs + Math.round((at / total) * span);
      at += p.length;
      return { text: p, startMs: from, endMs: startMs + Math.round((at / total) * span) };
    });
  }

  class Segmenter {
    /**
     * @param {object} opts
     * @param {number} opts.startedAt   epoch ms the meeting capture began
     * @param {number} opts.silenceMs   finalize an utterance after this long with no update
     * @param {(seg: object) => void} opts.onSegment  called once per finalized segment
     * @param {() => number} opts.now  clock source; replaced when replaying a
     *   recorded meeting offline, so timestamps and silence gaps come out the
     *   same as they did live
     * @param {boolean} opts.autoFlush  run the idle timer (off for replay)
     */
    constructor({ startedAt, silenceMs = 2500, onSegment, now = Date.now, autoFlush = true }) {
      this.startedAt = startedAt;
      this.silenceMs = silenceMs;
      this.onSegment = onSegment;
      this.now = now;
      this.seq = 0;
      this.open = new Map(); // nodeKey -> state being spoken right now
      this.committed = new Map(); // nodeKey -> text already emitted for that node
      this.speakers = new Set();
      this.lastFinalized = null;
      this._timer = autoFlush ? setInterval(() => this.flushIdle(), 1000) : null;
    }

    /** Record what a caption node currently says. Safe to call on every mutation. */
    observe(nodeKey, speaker, text) {
      text = CN.normalize(text);
      speaker = CN.normalize(speaker) || "Unknown speaker";
      if (!text) return;
      if (speaker !== "Unknown speaker") this.speakers.add(speaker);

      const now = this.now();
      const state = this.open.get(nodeKey);

      if (state) {
        // A different speaker, or text unrelated to what this node was saying,
        // means the utterance is over and the node has moved on.
        const merged = state.speaker === speaker ? mergeRolling(state.text, text) : null;
        if (merged !== null) {
          state.text = merged;
          state.updatedAt = now;
          return;
        }
        this.finalize(nodeKey);
        return this.observe(nodeKey, speaker, text);
      }

      // No open utterance for this node. It is still in the DOM showing whatever
      // it said last, so re-reading it must not emit that line a second time.
      const prior = this.committed.get(nodeKey);
      let prefix = "";
      if (prior) {
        const merged = mergeRolling(prior, text);
        if (merged === prior) return; // nothing new to say
        if (merged !== null) {
          // The speaker carried on in the same node after a pause: emit only
          // the part that was not already written down.
          prefix = prior;
          text = merged;
        }
        // A correction of what was already written, carrying on: emit only
        // the words after it.
        else if (startsLike(prior, text)) prefix = prior;
        // Otherwise the node was recycled for a fresh utterance.
      }

      this.open.set(nodeKey, { speaker, text, prefix, startMs: now - this.startedAt, updatedAt: now });
    }

    /** Close out any utterance that has stopped changing. */
    flushIdle() {
      const now = this.now();
      const due = [];
      for (const [key, state] of this.open) {
        if (now - state.updatedAt >= this.silenceMs) due.push([key, state]);
      }
      this.finalizeInOrder(due);
    }

    // When several people are captioned at once, several utterances close in
    // the same pass. Emit them in the order they were started, not in whatever
    // order the map happens to hold, so the transcript reads chronologically.
    finalizeInOrder(entries) {
      entries.sort((a, b) => a[1].startMs - b[1].startMs);
      for (const [key] of entries) this.finalize(key);
    }

    finalize(nodeKey) {
      const state = this.open.get(nodeKey);
      this.open.delete(nodeKey);
      if (!state) return;

      this.remember(nodeKey, state.text);
      // Only the growth since this node's last segment is new.
      const text = CN.normalize(newPart(state));
      if (text.length < 2) return;

      // Platforms occasionally re-render a whole caption block after it was
      // already closed; drop an exact repeat from the same speaker.
      if (
        this.lastFinalized &&
        this.lastFinalized.speaker === state.speaker &&
        this.lastFinalized.text === text
      ) {
        return;
      }

      // Never let the end precede the start; the system clock can be adjusted
      // mid-meeting, and a backwards range breaks every consumer downstream.
      const endMs = Math.max(state.startMs, state.updatedAt - this.startedAt);

      for (const part of timeSlices(splitUtterance(text), state.startMs, endMs)) {
        const seg = { seq: this.seq++, speaker: state.speaker, ...part };
        this.lastFinalized = seg;
        this.onSegment(seg);
      }
    }

    // What each node has already contributed, so a row left sitting in the DOM
    // is never transcribed twice. Bounded: a long meeting churns through many
    // nodes and only the recent ones can still be on screen.
    remember(nodeKey, text) {
      this.committed.set(nodeKey, text);
      if (this.committed.size > 200) {
        this.committed.delete(this.committed.keys().next().value);
      }
    }

    /**
     * Tell the segmenter a node has already said this, without transcribing it.
     * Used when capture starts mid-call: the captions already on screen are
     * context, not new speech, and must not become transcript lines.
     */
    prime(nodeKey, text) {
      const t = CN.normalize(text);
      if (t) this.remember(nodeKey, t);
    }

    /** Close everything — call when the meeting ends. */
    flushAll() {
      this.finalizeInOrder(Array.from(this.open.entries()));
    }

    /** Text of the utterances still being spoken, for the live sidebar. */
    pending() {
      return Array.from(this.open.values())
        .map((s) => ({
          speaker: s.speaker,
          text: CN.normalize(newPart(s)),
          startMs: s.startMs,
          partial: true,
        }))
        .filter((s) => s.text);
    }

    destroy() {
      clearInterval(this._timer);
      this.flushAll();
    }
  }

  CN.Segmenter = Segmenter;
  CN._mergeRolling = mergeRolling; // exported for the unit test
  CN._splitUtterance = splitUtterance;
})();
