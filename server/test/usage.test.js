import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "clearnote-usage-"));
process.env.CLEARNOTE_DB = path.join(dir, "t.db");
const { estimateAnthropicCost, recordUsage, usageReport } = await import("../usage.js");

test("Anthropic cost is estimated from list prices, cache included", () => {
  const c = estimateAnthropicCost("claude-opus-5-5", {
    input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0,
  });
  assert.ok(Math.abs(c - (4 + 2 + 0.2)) < 1e-9);
  assert.equal(estimateAnthropicCost("some-unknown-model", { input_tokens: 5 }), null);
});

test("calls are logged with exact OpenRouter costs and estimated Anthropic ones", () => {
  recordUsage({ task: "summary", provider: "openrouter", model: "anthropic/claude-opus-5.5", meetingId: "m1",
    usage: { prompt_tokens: 1000, completion_tokens: 200, cost: 0.0123 } });
  recordUsage({ task: "summary", provider: "anthropic", model: "claude-opus-5-5", meetingId: "m1",
    usage: { input_tokens: 10000, output_tokens: 1000 } });
  recordUsage({ task: "question", provider: "anthropic", model: "claude-opus-5-5", error: "boom" });
  const r = usageReport();
  assert.equal(r.allTime.calls, 3);
  assert.ok(Math.abs(r.allTime.cost - (0.0123 + 0.04 + 0.02)) < 1e-9);
  const or = r.recent.find((x) => x.provider === "openrouter");
  assert.equal(or.cost_exact, 1);
  assert.equal(r.recent.find((x) => x.error === "boom").ok, 0);
});
