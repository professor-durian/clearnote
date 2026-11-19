// Merges a local audio transcript with the platform's captions.
//
// Captions know WHO spoke but get words and timing slightly wrong. The audio
// transcript (whisper.cpp) gets words and timing right but has no names. Two
// audio tracks are recorded: the meeting tab (everyone else) and the mic (you).
//
//   tab words  -> phrases -> each phrase takes the speaker of the caption line
//                            whose wording it best matches (not its clock time,
//                            since captions lag the audio by a second or two)
//   mic words  -> your lines, minus anything that is the other side's audio
//                 leaking back through your speakers (echo)
//   captions   -> kept as-is for any part of the call with no audio
//
// Pure functions only: no I/O, so the whole thing is unit-tested.

const PHRASE_GAP_MS = 600; // a pause this long starts a new phrase
const LINE_GAP_MS = 1500; // same speaker, pause shorter than this -> same line
const SEARCH_BEFORE_MS = 8000; // how far a caption may lead the audio
const SEARCH_AFTER_MS = 15000; // how far a caption may lag the audio
const MIN_MATCH = 0.34; // share of a phrase's words found in a caption line
const ECHO_WINDOW_MS = 2000;
const ECHO_SHARE = 0.6; // a mic phrase this much echo is dropped

export const SELF_ALIASES = new Set(["you", "me"]);

export function norm(word) {
  return String(word || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}']+/gu, "")
    .replace(/^'+|'+$/g, "");
}

export function tokens(text) {
  return String(text || "")
    .split(/\s+/)
    .map(norm)
    .filter(Boolean);
}

/**
 * Group timed words into phrases, split at pauses and at sentence ends.
 * whisper.cpp leaves no gap between words, so a quick change of speaker often
 * shows only as a full stop or question mark.
 */
export function phrases(words, gapMs = PHRASE_GAP_MS) {
  const out = [];
  let cur = null;
  let sentenceEnded = false;
  for (const w of words) {
    if (!w || !String(w.text).trim()) continue;
    if (!cur || sentenceEnded || w.startMs - cur.endMs > gapMs) {
      cur = { words: [], startMs: w.startMs, endMs: w.endMs };
      out.push(cur);
    }
    cur.words.push(w);
    cur.endMs = Math.max(cur.endMs, w.endMs);
    sentenceEnded = /[.?!]["')\]]*$/.test(String(w.text).trim());
  }
  for (const p of out) p.text = joinWords(p.words.map((w) => w.text));
  return out;
}

function joinWords(parts) {
  return parts
    .map((p) => String(p).trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([,.!?;:])/g, "$1");
}

/** Share of a phrase's tokens that appear in the caption's tokens. */
function overlap(phraseTokens, captionSet) {
  if (!phraseTokens.length) return 0;
  let hit = 0;
  for (const t of phraseTokens) if (captionSet.has(t)) hit++;
  return hit / phraseTokens.length;
}

function isSelf(speaker, myName) {
  const s = norm(speaker);
  return SELF_ALIASES.has(s) || (!!myName && String(speaker).trim().toLowerCase() === myName.trim().toLowerCase());
}

/**
 * Give each tab phrase the speaker of its best-matching caption line.
 * A first pass measures how far captions lag the audio; the second pass uses
 * that to centre the search window.
 */
export function attributeTab(tabPhrases, captions) {
  const caps = captions.map((c) => ({ ...c, set: new Set(tokens(c.text)) }));

  const pass = (lagMs) =>
    tabPhrases.map((p) => {
      const pt = tokens(p.text);
      let best = null;
      let bestScore = 0;
      for (const c of caps) {
        if (c.startMs < p.startMs + lagMs - SEARCH_BEFORE_MS) continue;
        if (c.startMs > p.endMs + lagMs + SEARCH_AFTER_MS) continue;
        const score = overlap(pt, c.set);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      return { phrase: p, caption: bestScore >= MIN_MATCH ? best : null, score: bestScore };
    });

  const first = pass(0);
  const lags = first.filter((r) => r.caption && r.score >= 0.6).map((r) => r.caption.startMs - r.phrase.startMs);
  const lag = lags.length ? median(lags) : 0;
  const second = pass(lag);

  // Unmatched phrases take the speaker of the nearest matched neighbour.
  const out = second.map((r) => ({
    ...r.phrase,
    speaker: r.caption ? r.caption.speaker : null,
    inferred: !r.caption,
  }));
  for (let i = 0; i < out.length; i++) {
    if (out[i].speaker) continue;
    let prev = null;
    let next = null;
    for (let j = i - 1; j >= 0; j--) if (!out[j].inferred) { prev = out[j]; break; }
    for (let j = i + 1; j < out.length; j++) if (!out[j].inferred) { next = out[j]; break; }
    const pick =
      prev && next
        ? out[i].startMs - prev.endMs <= next.startMs - out[i].endMs ? prev : next
        : prev || next;
    out[i].speaker = pick ? pick.speaker : "Speaker";
  }
  return { phrases: out, lagMs: lag };
}

/** Drop mic phrases that are mostly the other side's audio coming back in. */
export function removeEcho(micPhrases, tabWords) {
  const tab = tabWords.map((w) => ({ t: norm(w.text), startMs: w.startMs })).filter((w) => w.t);
  return micPhrases.filter((p) => {
    const toks = p.words.map((w) => ({ t: norm(w.text), startMs: w.startMs })).filter((w) => w.t);
    if (!toks.length) return false;
    let echo = 0;
    for (const m of toks) {
      if (tab.some((w) => w.t === m.t && Math.abs(w.startMs - m.startMs) <= ECHO_WINDOW_MS)) echo++;
    }
    return echo / toks.length < ECHO_SHARE;
  });
}

/** Join consecutive phrases by the same speaker into transcript lines. */
export function toLines(items) {
  const sorted = [...items].sort((a, b) => a.startMs - b.startMs);
  const out = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (
      last &&
      last.speaker === it.speaker &&
      last.source === it.source &&
      last.inferred === it.inferred &&
      it.startMs - last.endMs <= LINE_GAP_MS
    ) {
      last.text = joinWords([last.text, it.text]);
      last.endMs = Math.max(last.endMs, it.endMs);
    } else {
      out.push({
        speaker: it.speaker,
        text: it.text,
        startMs: it.startMs,
        endMs: it.endMs,
        source: it.source,
        inferred: !!it.inferred,
      });
    }
  }
  return out;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param {object} input
 * @param {{speaker:string,text:string,startMs:number,endMs:number}[]} input.captions  meeting-relative ms
 * @param {{text:string,startMs:number,endMs:number}[]|null} input.tabWords   meeting-relative ms
 * @param {{text:string,startMs:number,endMs:number}[]|null} input.micWords   meeting-relative ms
 * @param {number} input.audioStartMs  when recording began, meeting-relative
 * @param {number} [input.audioEndMs]  when recording stopped, meeting-relative
 * @param {string} [input.myName]
 * @returns {{lines: object[], recordType: 'captions'|'merged'|'partial', lagMs: number}}
 */
export function merge({ captions = [], tabWords, micWords, audioStartMs = 0, audioEndMs = Infinity, myName = "" }) {
  if (!tabWords?.length && !micWords?.length) {
    return {
      lines: captions.map((c) => ({ ...c, source: "captions", inferred: false })),
      recordType: "captions",
      lagMs: 0,
    };
  }

  const others = captions.filter((c) => !isSelf(c.speaker, myName));
  const selfName = myName || captions.find((c) => isSelf(c.speaker, myName))?.speaker || "You";

  const tabPh = phrases(tabWords || []);
  const { phrases: tabOut, lagMs } = attributeTab(tabPh, others);
  const items = tabOut.map((p) => ({ ...p, source: "audio" }));

  if (micWords?.length) {
    for (const p of removeEcho(phrases(micWords), tabWords || [])) {
      items.push({ ...p, speaker: selfName, inferred: false, source: "audio" });
    }
  } else {
    // No mic track: your own lines come from the captions.
    for (const c of captions) {
      if (isSelf(c.speaker, myName) && c.startMs >= audioStartMs && c.startMs <= audioEndMs) {
        items.push({ ...c, speaker: selfName, inferred: false, source: "captions" });
      }
    }
  }

  // Captions outside the recorded span are kept as they are. A caption lagging
  // just past the start belongs to audio already, hence the lag allowance.
  const before = captions.filter((c) => c.endMs < audioStartMs + Math.max(0, lagMs));
  const after = captions.filter((c) => c.startMs > audioEndMs + Math.max(0, lagMs));
  for (const c of [...before, ...after]) items.push({ ...c, source: "captions", inferred: false });

  return {
    lines: toLines(items),
    recordType: before.length || after.length ? "partial" : "merged",
    lagMs,
  };
}
