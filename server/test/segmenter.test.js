// The segmenter is the piece that decides whether a transcript is readable or
// a wall of duplicated prefixes, so it gets tested against the caption
// behaviour each platform actually exhibits.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(here, "..", "..", "extension");

/** Load the content-script bundle's lib files into a fake window. */
function loadLib() {
  const sandbox = { window: {}, crypto: { randomUUID: () => Math.random().toString(36) } };
  sandbox.window.window = sandbox.window;
  sandbox.setInterval = () => 0;
  sandbox.clearInterval = () => {};
  sandbox.console = console;
  vm.createContext(sandbox);
  for (const f of ["lib/util.js", "lib/segmenter.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ext, f), "utf8"), sandbox, { filename: f });
  }
  return sandbox.window.ClearNote;
}

const CN = loadLib();

function collect(script, { silenceMs = 2500 } = {}) {
  const out = [];
  const seg = new CN.Segmenter({ startedAt: 0, silenceMs, onSegment: (s) => out.push(s) });
  for (const step of script) {
    if (step.idle) {
      // Pretend time passed, then close anything that has gone quiet.
      for (const state of seg.open.values()) state.updatedAt -= silenceMs + 1;
      seg.flushIdle();
      continue;
    }
    seg.observe(step.key, step.speaker, step.text);
  }
  seg.flushAll();
  return out;
}

test("mergeRolling collapses a caption that grows word by word", () => {
  const m = CN._mergeRolling;
  assert.equal(m("I think", "I think we"), "I think we");
  assert.equal(m("I think we should", "I think we"), "I think we should", "ignores repaint flicker");
  assert.equal(m("", "hello"), "hello");
});

test("mergeRolling rejoins a caption whose front was trimmed", () => {
  // Meet drops leading words once a block gets long; the overlap is the seam.
  const prev = "we should ship the pricing page on Thursday";
  const next = "ship the pricing page on Thursday and tell support";
  assert.equal(
    CN._mergeRolling(prev, next),
    "we should ship the pricing page on Thursday and tell support",
  );
});

test("mergeRolling reports unrelated text so a recycled node starts a new line", () => {
  assert.equal(CN._mergeRolling("the budget is approved", "completely different sentence"), null);
});

test("a rolling caption becomes one segment, not one per keystroke", () => {
  const segs = collect([
    { key: "a", speaker: "Ada", text: "I think" },
    { key: "a", speaker: "Ada", text: "I think we should" },
    { key: "a", speaker: "Ada", text: "I think we should ship it" },
  ]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].speaker, "Ada");
  assert.equal(segs[0].text, "I think we should ship it");
});

test("a speaker change on the same node splits the segment", () => {
  const segs = collect([
    { key: "a", speaker: "Ada", text: "sounds good to me" },
    { key: "a", speaker: "Grace", text: "I disagree" },
    { key: "a", speaker: "Grace", text: "I disagree with that" },
  ]);
  assert.deepEqual(
    segs.map((s) => [s.speaker, s.text]),
    [
      ["Ada", "sounds good to me"],
      ["Grace", "I disagree with that"],
    ],
  );
});

test("a recycled subtitle node splits on unrelated text (the Zoom case)", () => {
  // Zoom's subtitle bar is a single element reused for every utterance.
  const segs = collect([
    { key: "bar", speaker: "Ada", text: "the deploy went out" },
    { key: "bar", speaker: "Ada", text: "the deploy went out at noon" },
    { key: "bar", speaker: "Ada", text: "did anyone see the alert" },
  ]);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].text, "the deploy went out at noon");
  assert.equal(segs[1].text, "did anyone see the alert");
});

test("interleaved speakers on separate nodes stay separate (the Meet case)", () => {
  const segs = collect([
    { key: "r1", speaker: "Ada", text: "so about the roadmap" },
    { key: "r2", speaker: "Grace", text: "one second" },
    { key: "r1", speaker: "Ada", text: "so about the roadmap, Q4" },
    { key: "r2", speaker: "Grace", text: "one second, my mic" },
  ]);
  const byWho = Object.fromEntries(segs.map((s) => [s.speaker, s.text]));
  assert.equal(byWho.Ada, "so about the roadmap, Q4");
  assert.equal(byWho.Grace, "one second, my mic");
});

test("a speaker resuming in the same row contributes only the new words", () => {
  const segs = collect([
    { key: "a", speaker: "Ada", text: "let me check" },
    { idle: true },
    { key: "a", speaker: "Ada", text: "let me check that again" },
  ]);
  assert.equal(segs.length, 2, "after a pause the continuation is its own line");
  assert.equal(segs[0].text, "let me check");
  assert.equal(segs[1].text, "that again", "the already-written words are not repeated");
});

// Found by tools/caption-replay.html: a finished caption row stays in the DOM
// showing its last words, and every later poll re-read it as a new utterance.
test("a closed row left on screen is not transcribed twice", () => {
  const segs = collect([
    { key: "a", speaker: "Ada", text: "ship it Thursday" },
    { idle: true },
    // The row has not changed; polling must produce nothing further.
    { key: "a", speaker: "Ada", text: "ship it Thursday" },
    { key: "a", speaker: "Ada", text: "ship it Thursday" },
  ]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, "ship it Thursday");
});

test("stale rows do not accumulate without bound", () => {
  const seg = new CN.Segmenter({ startedAt: 0, onSegment: () => {} });
  for (let i = 0; i < 500; i++) {
    seg.observe(`row-${i}`, "Ada", `line number ${i}`);
    seg.finalize(`row-${i}`);
  }
  assert.ok(seg.committed.size <= 200, `kept ${seg.committed.size} entries`);
});

test("an exact repeat of the line just closed is dropped", () => {
  const segs = collect([
    { key: "a", speaker: "Ada", text: "approved" },
    { idle: true },
    { key: "b", speaker: "Ada", text: "approved" },
  ]);
  assert.equal(segs.length, 1);
});

test("timestamps and sequence numbers come out monotonic", () => {
  const segs = collect([
    { key: "a", speaker: "Ada", text: "first" },
    { idle: true },
    { key: "b", speaker: "Grace", text: "second" },
    { idle: true },
    { key: "c", speaker: "Ada", text: "third" },
  ]);
  assert.deepEqual(
    segs.map((s) => s.seq),
    [0, 1, 2],
  );
  for (let i = 1; i < segs.length; i++) {
    assert.ok(segs[i].startMs >= segs[i - 1].startMs);
    assert.ok(segs[i].endMs >= segs[i].startMs);
  }
});

test("whitespace noise and empty captions are discarded", () => {
  const segs = collect([
    { key: "a", speaker: "  Ada  ", text: "   " },
    { key: "b", speaker: "Ada", text: "  real   line\n  here " },
  ]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].speaker, "Ada");
  assert.equal(segs[0].text, "real line here");
});

test("speakers are collected for the participant list", () => {
  const seg = new CN.Segmenter({ startedAt: 0, onSegment: () => {} });
  seg.observe("a", "Ada Lovelace", "hello");
  seg.observe("b", "Unknown speaker", "mumble");
  seg.observe("c", "Grace Hopper", "hi");
  assert.deepEqual(Array.from(seg.speakers).sort(), ["Ada Lovelace", "Grace Hopper"]);
});

// ---------------------------------------------------------------------------
// Captured from a real Google Meet call. The recogniser revises what it has
// already displayed — punctuation first, then whole words — which turned three
// spoken sentences into sixteen transcript lines.
// ---------------------------------------------------------------------------

test("punctuation revised mid-utterance does not split the line", () => {
  // Meet showed "Yes." then re-rendered it as "Yes," once the sentence grew.
  const segs = collect([
    { key: "a", speaker: "You", text: "Yes." },
    { key: "a", speaker: "You", text: "Yes, this." },
    { key: "a", speaker: "You", text: "Yes, this is a test." },
    { key: "a", speaker: "You", text: "Yes, this is a test and." },
    { key: "a", speaker: "You", text: "Yes, this is a test, and I think." },
    { key: "a", speaker: "You", text: "Yes, this is a test, and I think it works. That's." },
    { key: "a", speaker: "You", text: "Yes, this is a test, and I think it works. That's perfect!" },
  ]);
  assert.equal(segs.length, 1, "seven caption frames, one thing said");
  assert.equal(segs[0].text, "Yes, this is a test, and I think it works. That's perfect!");
});

test("a word the recogniser corrects later keeps the line together", () => {
  // "One." was a mishearing of "When", corrected once more context arrived.
  const segs = collect([
    { key: "a", speaker: "You", text: "One." },
    { key: "a", speaker: "You", text: "One captions." },
    { key: "a", speaker: "You", text: "One. Captions are on." },
    { key: "a", speaker: "You", text: "One. Captions are on everything." },
    { key: "a", speaker: "You", text: "One. Captions are on everything works." },
    { key: "a", speaker: "You", text: "When captions are on everything works." },
  ]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, "When captions are on everything works.", "the correction wins");
});

test("a correction after the line was already closed does not repeat it", () => {
  const segs = collect([
    { key: "a", speaker: "You", text: "One. Captions are on everything works." },
    { idle: true },
    { key: "a", speaker: "You", text: "When captions are on everything works." },
  ]);
  assert.ok(segs.length <= 2);
  assert.ok(
    !segs.some((s) => /^One\. Captions.*\n?.*One\. Captions/.test(s.text)),
    "no duplicated text",
  );
});

test("two genuinely different sentences still split", () => {
  // The revision rules must not glue unrelated speech together.
  const segs = collect([
    { key: "a", speaker: "You", text: "Yes, this is a test, and I think it works." },
    { key: "a", speaker: "You", text: "When captions are on everything works." },
  ]);
  assert.equal(segs.length, 2);
});

test("short unrelated utterances are not merged by a single shared word", () => {
  const segs = collect([
    { key: "a", speaker: "Ada", text: "No way." },
    { key: "a", speaker: "Ada", text: "No idea." },
  ]);
  assert.equal(segs.length, 2);
});

// ---------------------------------------------------------------------------
// Meeting platforms label the local participant "You", which reads oddly in a
// transcript and can never be reconciled with a calendar invitee.
// ---------------------------------------------------------------------------

test("the platform's self label becomes your name", () => {
  for (const label of ["You", "you", "Me", "You (You)", "You (host)"]) {
    assert.equal(CN.resolveSpeaker(label, "Ada Lovelace"), "Ada Lovelace", label);
  }
});

test("everyone else keeps their own name", () => {
  assert.equal(CN.resolveSpeaker("Grace Hopper", "Ada Lovelace"), "Grace Hopper");
  // A name that merely contains "you" is not the self label.
  assert.equal(CN.resolveSpeaker("Young Kim", "Ada Lovelace"), "Young Kim");
  assert.equal(CN.resolveSpeaker("Unknown speaker", "Ada Lovelace"), "Unknown speaker");
});

test("with no name configured the label is left alone", () => {
  // Better an honest "You" than a wrong name.
  assert.equal(CN.resolveSpeaker("You", ""), "You");
  assert.equal(CN.resolveSpeaker("You", undefined), "You");
});

test("your own lines group as one speaker through the segmenter", () => {
  const name = (s) => CN.resolveSpeaker(s, "Ada Lovelace");
  const segs = collect([
    { key: "a", speaker: name("You"), text: "I'll take the pricing page." },
    { idle: true },
    { key: "b", speaker: name("Grace Hopper"), text: "Thanks." },
    { idle: true },
    { key: "c", speaker: name("You"), text: "Done by Thursday." },
  ]);
  assert.deepEqual(
    segs.map((s) => s.speaker),
    ["Ada Lovelace", "Grace Hopper", "Ada Lovelace"],
  );
});

// ---------------------------------------------------------------------------
// Someone reading aloud never pauses, so silence never closes the utterance
// and a minute of speech lands as one line behind one timestamp. This is the
// real line captured from a live Meet call.
// ---------------------------------------------------------------------------

const MONOLOGUE =
  "To be straight with you. Captions can't be avoided. They're not at this " +
  "place setting that happens to expose text. They are the speech recognition " +
  "meet on the runs. The recognizer, while captions are enabled with them off, " +
  "there is no text anywhere in the page. A bottles tool that doesn't record " +
  "audio has nothing else to read. Ice cubes is the same, which is why their " +
  "docs list captions enabled under Google meet requirements.";

test("a short utterance is never split", () => {
  const one = "Let's ship the pricing page on Thursday.";
  // Length and value, not deepEqual: the array comes from the sandbox realm.
  const parts = CN._splitUtterance(one);
  assert.equal(parts.length, 1);
  assert.equal(parts[0], one);
});

test("a long monologue is broken at sentence ends", () => {
  const parts = CN._splitUtterance(MONOLOGUE);
  assert.ok(parts.length > 1, "it must not stay as one block");
  for (const p of parts) {
    assert.ok(p.length <= 480, `part too long: ${p.length}`);
    assert.ok(/[.!?]$/.test(p), `part does not end at a sentence: ${JSON.stringify(p.slice(-40))}`);
  }
});

test("splitting loses no words", () => {
  const parts = CN._splitUtterance(MONOLOGUE);
  const rejoined = parts.join(" ").replace(/\s+/g, " ").trim();
  assert.equal(rejoined, MONOLOGUE.replace(/\s+/g, " ").trim());
});

test("speech with no punctuation still gets broken up", () => {
  // Captions sometimes arrive with no sentence marks at all.
  const run = Array.from({ length: 160 }, (_, i) => `word${i}`).join(" ");
  const parts = CN._splitUtterance(run);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 480, `part too long: ${p.length}`);
  assert.equal(parts.join(" "), run, "no words dropped at a word-boundary cut");
});

test("each part gets its own timestamp across the utterance", () => {
  const out = [];
  const seg = new CN.Segmenter({ startedAt: 0, silenceMs: 100, onSegment: (s) => out.push(s) });
  seg.observe("a", "Matteo", MONOLOGUE);
  const state = seg.open.get("a");
  state.startMs = 19_300;
  state.updatedAt = 79_300; // a minute of talking
  seg.finalize("a");

  assert.ok(out.length > 1);
  assert.equal(out[0].startMs, 19_300, "the first part starts where the utterance did");
  assert.equal(out.at(-1).endMs, 79_300, "the last part ends where it ended");
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].startMs >= out[i - 1].endMs - 1, "parts advance through the utterance");
    assert.equal(out[i].seq, out[i - 1].seq + 1, "sequence numbers stay contiguous");
    assert.equal(out[i].speaker, "Matteo");
  }
});

test("a caption the recogniser corrects after a pause isn't written down twice", () => {
  let t = 0;
  const out = [];
  const seg = new CN.Segmenter({ startedAt: 0, silenceMs: 1000, onSegment: (s) => out.push(s.text), now: () => t, autoFlush: false });
  seg.observe("zoom-1", "Scott", "Hey there, this is a test of the caption");
  t = 1500;
  seg.flushIdle();
  seg.observe("zoom-1", "Scott", "Hey there, this is the test of the captions and it keeps going");
  t = 3000;
  seg.flushIdle();
  assert.deepEqual(out, ["Hey there, this is a test of the caption", "and it keeps going"]);
});
