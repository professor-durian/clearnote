// The AI layer: one structured pass over a finished transcript that produces
// the summary, action items, insights and tags, plus a chat endpoint for
// questions about a meeting.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import * as config from "./config.js";
import { PRICES, recordUsage } from "./usage.js";

// Two providers: Anthropic directly, or OpenRouter. Keys are pasted in the
// dashboard's Settings (or set in the environment). One is primary; if it
// fails, the other is tried when "use the other as backup" is on.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Rebuilt when the key changes, so a pasted key works without a restart.
let _client = null;
let _clientKey = null;
function client() {
  const key = config.get("anthropicKey");
  if (!_client || key !== _clientKey) {
    // With no key in settings, the SDK falls back to its own credential lookup.
    _client = key ? new Anthropic({ apiKey: key }) : new Anthropic();
    _clientKey = key;
  }
  return _client;
}

function hasAnthropic() {
  return !!(config.get("anthropicKey") || process.env.ANTHROPIC_AUTH_TOKEN);
}
function hasOpenRouter() {
  return !!config.get("openrouterKey");
}

/** Providers to try, in order. */
export function providerOrder() {
  const available = { anthropic: hasAnthropic(), openrouter: hasOpenRouter() };
  const primary = config.get("aiPrimary") === "openrouter" ? "openrouter" : "anthropic";
  const other = primary === "anthropic" ? "openrouter" : "anthropic";
  const order = [];
  if (available[primary]) order.push(primary);
  if (available[other] && (config.get("aiBackup") || !available[primary])) order.push(other);
  return order;
}

export function aiConfigured() {
  return providerOrder().length > 0;
}

const modelFor = (provider) => config.get(provider === "openrouter" ? "openrouterModel" : "anthropicModel");

/**
 * Try each provider in order. Every attempt, successful or not, goes in the
 * spending log. Each provider function returns { ..., usage, model? }.
 */
async function withFallback(task, fns, meetingId = null) {
  const order = providerOrder();
  if (!order.length) throw new Error("no AI provider configured: add a key in Settings");
  let lastErr;
  for (const name of order) {
    try {
      const r = await fns[name]();
      recordUsage({ task, provider: name, model: r.model || modelFor(name), meetingId, usage: r.usage || {} });
      return r;
    } catch (err) {
      lastErr = err;
      recordUsage({ task, provider: name, model: modelFor(name), meetingId, usage: err.usage || {}, error: err.message });
      if (order.length > 1) console.warn(`[clearnote] ${task} via ${name} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

async function openRouter(body) {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.get("openrouterKey")}`,
      "content-type": "application/json",
      "x-title": "ClearNote",
    },
    // usage.include asks OpenRouter to report what the call cost.
    body: JSON.stringify({ model: config.get("openrouterModel"), usage: { include: true }, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${json?.error?.message || res.statusText}`);
  const choice = json.choices?.[0];
  if (!choice) throw new Error("OpenRouter returned no answer");
  return { text: String(choice.message?.content || "").trim(), usage: json.usage, model: json.model };
}

// ------------------------------------------------------------------ model lists
// The Settings page offers a list rather than a typed name, so a retired or
// mistyped model is visible before it fails a summary. Cached for an hour.

const modelCache = {};

async function anthropicModels() {
  const out = [];
  for await (const m of client().models.list()) {
    const p = PRICES[m.id];
    out.push({
      id: m.id,
      name: m.display_name || m.id,
      inPerM: p ? p[0] : null,
      outPerM: p ? p[1] : null,
      structured: m.capabilities?.structured_outputs?.supported !== false,
    });
  }
  return out;
}

async function openRouterModels() {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: config.get("openrouterKey") ? { authorization: `Bearer ${config.get("openrouterKey")}` } : {},
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${json?.error?.message || res.statusText}`);
  return (json.data || [])
    .filter((m) => (m.supported_parameters || []).includes("structured_outputs"))
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      // OpenRouter prices are dollars per token, as strings.
      inPerM: m.pricing?.prompt != null ? Number(m.pricing.prompt) * 1e6 : null,
      outPerM: m.pricing?.completion != null ? Number(m.pricing.completion) * 1e6 : null,
      structured: true,
    }))
    // Router placeholders are priced -1; ":batch" variants answer hours later.
    .filter((m) => !(m.inPerM < 0) && !m.id.endsWith(":batch"));
}

/** Models the provider offers now, plus whether the saved choice is among them. */
export async function listModels(provider) {
  const key = provider === "openrouter" ? config.get("openrouterKey") : config.get("anthropicKey");
  const cached = modelCache[provider];
  if (!cached || cached.key !== key || Date.now() - cached.at > 60 * 60 * 1000) {
    if (provider === "anthropic" && !hasAnthropic()) throw new Error("Add an Anthropic key first.");
    const models = provider === "openrouter" ? await openRouterModels() : await anthropicModels();
    modelCache[provider] = { at: Date.now(), key, models };
  }
  const models = modelCache[provider].models;
  const current = modelFor(provider);
  return { models, current, available: models.some((m) => m.id === current) };
}

/** Send a one-line test request to a provider; used by the Settings page. */
export async function testProvider(name) {
  if (name === "openrouter") {
    if (!hasOpenRouter()) throw new Error("no OpenRouter key set");
    try {
      const r = await openRouter({ max_tokens: 16, messages: [{ role: "user", content: "Reply with OK." }] });
      recordUsage({ task: "test", provider: "openrouter", model: r.model || modelFor("openrouter"), usage: r.usage || {} });
    } catch (err) {
      recordUsage({ task: "test", provider: "openrouter", model: modelFor("openrouter"), error: err.message });
      throw err;
    }
    return { ok: true, model: config.get("openrouterModel") };
  }
  if (!hasAnthropic()) throw new Error("no Anthropic key set");
  try {
    const r = await client().messages.create({
      model: config.get("anthropicModel"),
      max_tokens: 64,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "Reply with OK." }],
    });
    recordUsage({ task: "test", provider: "anthropic", model: r.model || modelFor("anthropic"), usage: r.usage });
  } catch (err) {
    recordUsage({ task: "test", provider: "anthropic", model: modelFor("anthropic"), error: err.message });
    throw err;
  }
  return { ok: true, model: config.get("anthropicModel") };
}

// Every field is required and nullable: strict JSON schemas do not take
// optional keys, and a null reads more clearly than an invented value.
const Analysis = z.object({
  summary: z.object({
    headline: z.string().describe("One sentence a reader can scan in the meeting list"),
    tldr: z.string().describe("Two to four sentences on what happened and what it means"),
    key_points: z.array(z.string()).describe("The substantive points, in the order discussed"),
    decisions: z.array(z.string()).describe("Decisions actually made. Empty if none were."),
    open_questions: z.array(z.string()).describe("Questions raised and left unresolved"),
    next_meeting: z.string().nullable().describe("Agreed follow-up or next session, else null"),
  }),
  action_items: z.array(
    z.object({
      text: z.string().describe("The task, phrased as an instruction"),
      owner: z.string().nullable().describe("Speaker name who owns it, else null"),
      due: z.string().nullable().describe("Due date as stated, ISO where possible, else null"),
      priority: z.enum(["high", "medium", "low"]),
      quote: z.string().nullable().describe("The short line in the transcript it came from"),
    }),
  ),
  insights: z.array(
    z.object({
      kind: z
        .enum([
          "objection",
          "buying_signal",
          "risk",
          "competitor",
          "pricing",
          "next_step",
          "commitment",
          "question",
          "sentiment",
        ])
        .describe("What kind of moment this was"),
      speaker: z.string().nullable(),
      quote: z.string().nullable().describe("Verbatim line from the transcript"),
      note: z.string().describe("Why it matters, in one sentence"),
    }),
  ),
  tags: z.array(z.string()).describe("Three to six lowercase topic tags, e.g. pricing, hiring, q4-roadmap"),
});

const SYSTEM = `You write meeting notes from live-caption transcripts.

The transcript comes from a meeting platform's automatic captions, so expect
misheard words, missing punctuation, and names attached to the wrong line when
people talk over each other. Read through the noise: infer what was meant, and
never quote a garbled line as if it were exact.

Rules:
- Only report what the transcript supports. No invented owners, dates or decisions.
- An action item needs a real commitment, not a passing idea. If nobody committed
  to anything, return an empty list.
- Attribute by the speaker names in the transcript. Where a name is "Unknown
  speaker", leave the owner null rather than guessing.
- When an invitee list is given, prefer those spellings for owners, and treat
  anyone on it as a plausible owner even if the captions garbled their name.
  Never invent an owner who is neither a speaker nor an invitee.
- Write plainly, in the participants' own vocabulary. No corporate filler.
- Insights are notable moments, not a second summary. Return none rather than padding.`;

/** `[12:05] Ada: text` — timestamps let the dashboard jump into the transcript. */
export function renderTranscript(segments) {
  const clock = (ms) => {
    const t = Math.max(0, Math.round(ms / 1000));
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
  };
  return segments.map((s) => `[${clock(s.start_ms)}] ${s.speaker}: ${s.text}`).join("\n");
}

function header(meeting, segments, context = {}) {
  const mins = meeting.ended_at
    ? Math.round((meeting.ended_at - meeting.started_at) / 60000)
    : null;
  const { event, attendees = [] } = context;

  // Calendar context is worth a lot here: it gives the model the real agenda
  // and real names, so owners stop being guessed from a caption spelling.
  const invited = attendees.length
    ? `Invited: ${attendees
        .map((a) => `${a.name || a.email}${a.organizer ? " (organizer)" : ""}`)
        .join(", ")}`
    : null;

  return [
    `Title: ${meeting.title || "Untitled meeting"}`,
    `Platform: ${meeting.platform_label || meeting.platform}`,
    `Date: ${new Date(meeting.started_at).toISOString()}`,
    mins !== null ? `Duration: ${mins} minutes` : null,
    event?.description ? `Calendar description: ${event.description.slice(0, 1500)}` : null,
    invited,
    `Transcript lines: ${segments.length}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * @param {object} meeting row from the meetings table
 * @param {object[]} segments rows from the segments table
 * @param {string=} template extra instructions for the summary shape
 */
export async function analyzeMeeting(meeting, segments, template, context = {}) {
  if (!segments.length) throw new Error("nothing to analyze: the transcript is empty");

  const system = template
    ? `${SYSTEM}\n\nThe reader asked for this summary shape — follow it:\n${template}`
    : SYSTEM;

  const userText = `${header(meeting, segments, context)}\n\n--- transcript ---\n${renderTranscript(segments)}`;

  const { parsed, usage } = await withFallback("summary", {
    anthropic: async () => {
      const response = await client().messages.parse({
        model: config.get("anthropicModel"),
        max_tokens: 16000,
        system,
        thinking: { type: "adaptive" },
        output_config: { effort: "high", format: zodOutputFormat(Analysis) },
        messages: [{ role: "user", content: userText }],
      });
      const fail = (msg) => Object.assign(new Error(msg), { usage: response.usage });
      if (response.stop_reason === "refusal") {
        throw fail(`the model declined to summarize this meeting (${response.stop_details?.category ?? "unknown"})`);
      }
      if (!response.parsed_output) throw fail("the model returned a summary that did not match the schema");
      return { parsed: response.parsed_output, usage: response.usage, model: response.model };
    },
    openrouter: async () => {
      const { text, usage, model } = await openRouter({
        max_tokens: 16000,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userText },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "meeting_analysis", strict: true, schema: z.toJSONSchema(Analysis) },
        },
      });
      const json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      return { parsed: Analysis.parse(json), usage, model };
    },
  }, meeting.id);

  return {
    summary: parsed.summary,
    actionItems: parsed.action_items,
    insights: parsed.insights,
    tags: parsed.tags.map((t) => t.toLowerCase().trim()).filter(Boolean),
    usage,
  };
}

/**
 * Question answering over one meeting. The transcript sits behind a cache
 * breakpoint so a back-and-forth about the same meeting only pays for it once.
 */
export async function askMeeting(meeting, segments, question, history = [], context = {}) {
  const transcript = `${header(meeting, segments, context)}\n\n--- transcript ---\n${renderTranscript(segments)}`;

  return withFallback("question", {
    anthropic: () => askAnthropic(transcript, question, history),
    openrouter: async () => {
      const { text, usage, model } = await openRouter({
        max_tokens: 4000,
        messages: [
          { role: "system", content: `${ASK_SYSTEM}\n\n${transcript}` },
          ...history.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) })),
          { role: "user", content: question },
        ],
      });
      return { text, usage, model };
    },
  }, meeting.id);
}

const ASK_SYSTEM = `You answer questions about one meeting, using only its transcript.

The transcript is from automatic captions, so it contains mishearings. Answer
what the transcript supports and say plainly when it does not settle the
question. Cite the timestamp in brackets when you refer to a specific moment.
Be brief — a couple of sentences unless more is genuinely needed.`;

async function askAnthropic(transcript, question, history) {
  const response = await client().messages.create({
    model: config.get("anthropicModel"),
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: [
      { type: "text", text: ASK_SYSTEM },
      { type: "text", text: transcript, cache_control: { type: "ephemeral" } },
    ],
    messages: [...history, { role: "user", content: question }],
  });

  if (response.stop_reason === "refusal") {
    return { text: "I can't answer that one.", usage: response.usage, model: response.model };
  }
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return { text, usage: response.usage, model: response.model };
}
