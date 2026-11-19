// Spending log: one row per AI call (summary, question, test), with the
// provider, model, tokens and cost.
//
// OpenRouter reports what each call cost, so those costs are exact. Anthropic
// reports tokens only, so the cost is estimated from its list prices below;
// the Anthropic Console's billing page is the exact record.

import { db } from "./db.js";

db.exec(`
CREATE TABLE IF NOT EXISTS ai_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  meeting_id    TEXT,
  task          TEXT NOT NULL,          -- summary | question | test
  provider      TEXT NOT NULL,          -- anthropic | openrouter
  model         TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  cache_write   INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL,                   -- null when the price is unknown
  cost_exact    INTEGER NOT NULL DEFAULT 0,
  ok            INTEGER NOT NULL DEFAULT 1,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS ai_usage_at ON ai_usage(at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_meeting ON ai_usage(meeting_id);
`);

// US$ per million tokens: input, output, cache read, cache write (5-minute).
// Anthropic list prices; extend when models change.
export const PRICES = {
  "claude-fable-5-2": [8, 40, 0.2, 10],
  "claude-fable-5-1": [10, 50, 0.25, 12.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-opus-4-8": [5, 25, 0.5, 6.25],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

export function estimateAnthropicCost(model, u = {}) {
  const p = PRICES[model];
  if (!p) return null;
  const per = (n, price) => ((n || 0) / 1e6) * price;
  return (
    per(u.input_tokens, p[0]) +
    per(u.output_tokens, p[1]) +
    per(u.cache_read_input_tokens, p[2]) +
    per(u.cache_creation_input_tokens, p[3])
  );
}

const insert = db.prepare(
  `INSERT INTO ai_usage (at, meeting_id, task, provider, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, cost_exact, ok, error)
   VALUES (@at, @meeting_id, @task, @provider, @model, @input_tokens, @output_tokens, @cache_read, @cache_write, @cost_usd, @cost_exact, @ok, @error)`,
);

/** Log one call. `usage` is the provider's usage object (either shape). */
export function recordUsage({ task, provider, model, meetingId = null, usage = {}, error = null }) {
  let row;
  if (provider === "openrouter") {
    const cost = typeof usage.cost === "number" ? usage.cost : null;
    row = {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      cache_read: usage.prompt_tokens_details?.cached_tokens || 0,
      cache_write: 0,
      cost_usd: cost,
      cost_exact: cost == null ? 0 : 1,
    };
  } else {
    row = {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_read: usage.cache_read_input_tokens || 0,
      cache_write: usage.cache_creation_input_tokens || 0,
      cost_usd: error ? 0 : estimateAnthropicCost(model, usage),
      cost_exact: 0,
    };
  }
  try {
    insert.run({
      at: Date.now(),
      meeting_id: meetingId,
      task,
      provider,
      model: model || null,
      ok: error ? 0 : 1,
      error: error ? String(error).slice(0, 300) : null,
      ...row,
    });
  } catch (err) {
    console.warn(`[clearnote] could not log AI usage: ${err.message}`);
  }
}

/** Totals plus the recent calls, for the Usage page. */
export function usageReport({ limit = 200 } = {}) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const total = (where = "1=1", args = []) =>
    db
      .prepare(
        `SELECT COUNT(*) calls, COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output,
                SUM(CASE WHEN cost_usd IS NULL AND ok = 1 THEN 1 ELSE 0 END) unpriced
         FROM ai_usage WHERE ${where}`,
      )
      .get(...args);
  return {
    allTime: total(),
    thisMonth: total("at >= ?", [monthStart]),
    last7: total("at >= ?", [Date.now() - 7 * 864e5]),
    byProvider: db
      .prepare(
        `SELECT provider, model, COUNT(*) calls, COALESCE(SUM(cost_usd),0) cost, MAX(cost_exact) exact
         FROM ai_usage WHERE at >= ? GROUP BY provider, model ORDER BY cost DESC`,
      )
      .all(monthStart),
    byTask: db
      .prepare(`SELECT task, COUNT(*) calls, COALESCE(SUM(cost_usd),0) cost FROM ai_usage WHERE at >= ? GROUP BY task ORDER BY cost DESC`)
      .all(monthStart),
    recent: db
      .prepare(
        `SELECT u.*, m.title FROM ai_usage u LEFT JOIN meetings m ON m.id = u.meeting_id ORDER BY u.at DESC LIMIT ?`,
      )
      .all(limit),
  };
}

export function meetingUsage(meetingId) {
  return db
    .prepare(`SELECT COUNT(*) calls, COALESCE(SUM(cost_usd),0) cost, MIN(cost_exact) exact FROM ai_usage WHERE meeting_id = ?`)
    .get(meetingId);
}
