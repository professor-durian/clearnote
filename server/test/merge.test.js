import test from "node:test";
import assert from "node:assert/strict";
import { merge, phrases, removeEcho, attributeTab, norm } from "../merge.js";

// Spread a sentence's words evenly across [startMs, endMs].
function words(text, startMs, endMs) {
  const parts = text.split(" ");
  const step = (endMs - startMs) / parts.length;
  return parts.map((t, i) => ({
    text: t,
    startMs: Math.round(startMs + i * step),
    endMs: Math.round(startMs + (i + 1) * step - 20),
  }));
}

test("norm strips case, punctuation and accents", () => {
  assert.equal(norm("Café,"), "cafe");
  assert.equal(norm("don't"), "don't");
  assert.equal(norm("—"), "");
});

test("phrases split at pauses", () => {
  const w = [...words("hello there", 0, 800), ...words("new thought", 2000, 2800)];
  const p = phrases(w);
  assert.equal(p.length, 2);
  assert.equal(p[0].text, "hello there");
  assert.equal(p[1].startMs, 2000);
});

test("captions only when there is no audio", () => {
  const captions = [{ speaker: "Ana", text: "hi", startMs: 0, endMs: 500 }];
  const r = merge({ captions, tabWords: null, micWords: null });
  assert.equal(r.recordType, "captions");
  assert.equal(r.lines[0].source, "captions");
});

test("tab phrases take the speaker of the matching caption despite caption lag", () => {
  const captions = [
    { speaker: "Ana", text: "we should ship the pricing page friday", startMs: 1800, endMs: 4500 },
    { speaker: "Ben", text: "agreed but legal needs a look first", startMs: 6200, endMs: 9000 },
  ];
  const tabWords = [
    ...words("We should ship the pricing page Friday.", 0, 2600),
    ...words("Agreed, but legal needs a look first.", 4400, 7200),
  ];
  const r = merge({ captions, tabWords, micWords: null });
  assert.equal(r.recordType, "merged");
  assert.deepEqual(
    r.lines.map((l) => [l.speaker, l.text]),
    [
      ["Ana", "We should ship the pricing page Friday."],
      ["Ben", "Agreed, but legal needs a look first."],
    ],
  );
  assert.ok(r.lagMs > 1000 && r.lagMs < 2500, `lag ${r.lagMs}`);
});

test("audio words win over garbled caption words", () => {
  const captions = [{ speaker: "Ana", text: "the cue for report is late", startMs: 1500, endMs: 3500 }];
  const tabWords = words("The Q4 report is late.", 0, 2000);
  const r = merge({ captions, tabWords });
  assert.equal(r.lines[0].speaker, "Ana");
  assert.equal(r.lines[0].text, "The Q4 report is late.");
});

test("an unmatched phrase borrows the nearest speaker and is marked inferred", () => {
  const captions = [{ speaker: "Ana", text: "let's start with the budget review", startMs: 1500, endMs: 3500 }];
  const tabWords = [
    ...words("Let's start with the budget review.", 0, 2000),
    ...words("Mmhm okay.", 2800, 3300),
  ];
  const { phrases: out } = attributeTab(phrases(tabWords), captions);
  assert.equal(out[1].speaker, "Ana");
  assert.equal(out[1].inferred, true);
});

test("mic phrases become your lines, named from settings", () => {
  const captions = [{ speaker: "You", text: "thanks everyone for joining", startMs: 1200, endMs: 3000 }];
  const micWords = words("Thanks everyone for joining.", 0, 1800);
  const r = merge({ captions, tabWords: [], micWords, myName: "Scott Pressimone" });
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].speaker, "Scott Pressimone");
});

test("your own caption lines are never used to name the other side", () => {
  const captions = [
    { speaker: "You", text: "can you share the deck", startMs: 1000, endMs: 2500 },
    { speaker: "Ana", text: "sure sharing the deck now", startMs: 4000, endMs: 5500 },
  ];
  const tabWords = words("Sure, sharing the deck now.", 2500, 4000);
  const micWords = words("Can you share the deck?", 0, 1500);
  const r = merge({ captions, tabWords, micWords, myName: "Scott" });
  assert.deepEqual(
    r.lines.map((l) => l.speaker),
    ["Scott", "Ana"],
  );
});

test("echo of the other side picked up by the mic is removed", () => {
  const tabWords = words("the numbers look good this quarter", 0, 2000);
  const echo = phrases(words("the numbers look good this quarter", 150, 2150));
  const mine = phrases(words("great to hear", 4000, 5000));
  const kept = removeEcho([...echo, ...mine], tabWords);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].text, "great to hear");
});

test("captions before recording started are kept and the record is partial", () => {
  const captions = [
    { speaker: "Ana", text: "early chat before recording", startMs: 0, endMs: 2000 },
    { speaker: "Ana", text: "now the main agenda item", startMs: 61500, endMs: 63500 },
  ];
  const tabWords = words("Now the main agenda item.", 60000, 62000);
  const r = merge({ captions, tabWords, audioStartMs: 60000 });
  assert.equal(r.recordType, "partial");
  assert.deepEqual(
    r.lines.map((l) => [l.source, l.text]),
    [
      ["captions", "early chat before recording"],
      ["audio", "Now the main agenda item."],
    ],
  );
});

test("consecutive phrases from one speaker join into one line", () => {
  const captions = [
    { speaker: "Ana", text: "first point about hiring", startMs: 1500, endMs: 3000 },
    { speaker: "Ana", text: "second point about budget", startMs: 3800, endMs: 5200 },
  ];
  const tabWords = [
    ...words("First point about hiring.", 0, 1400),
    ...words("Second point about budget.", 2200, 3600),
  ];
  const r = merge({ captions, tabWords });
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].text, "First point about hiring. Second point about budget.");
});

test("back-to-back speakers with no pause are split at the sentence end", () => {
  const captions = [
    { speaker: "Ana", text: "is the contract signed", startMs: 1500, endMs: 3000 },
    { speaker: "Ben", text: "yes it went out this morning", startMs: 3200, endMs: 5000 },
  ];
  // Contiguous word timings, as whisper.cpp produces them.
  const tabWords = words("Is the contract signed? Yes, it went out this morning.", 0, 3500);
  const r = merge({ captions, tabWords });
  assert.deepEqual(
    r.lines.map((l) => [l.speaker, l.text]),
    [
      ["Ana", "Is the contract signed?"],
      ["Ben", "Yes, it went out this morning."],
    ],
  );
});
