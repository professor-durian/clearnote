// One-click setup for local transcription: installs whisper.cpp and ffmpeg
// with Homebrew (if missing) and downloads the speech and silence models.
// Optional: ClearNote works from captions alone without any of this.

import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MODEL, VAD_MODEL, binPath } from "./transcribe.js";

const DOWNLOADS = [
  { file: MODEL, url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin", label: "speech model" },
  { file: VAD_MODEL, url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin", label: "silence model" },
];

export const MODEL_MB = 575;

const state = { running: false, step: "", pct: null, error: null, done: false };
export const setupState = () => ({ ...state });

export function brewPath() {
  for (const p of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) if (existsSync(p)) return p;
  return null;
}

function brewInstall(brew, formulas) {
  return new Promise((resolve, reject) =>
    execFile(brew, ["install", ...formulas], { timeout: 30 * 60 * 1000, maxBuffer: 1 << 26, env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1" } }, (err, _o, stderr) =>
      err ? reject(new Error(`Homebrew couldn't install ${formulas.join(", ")}: ${String(stderr || err.message).trim().split("\n").pop()}`)) : resolve(),
    ),
  );
}

async function download({ file, url, label }) {
  if (existsSync(file)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Couldn't download the ${label} (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0;
  const part = `${file}.part`;
  const counter = new TransformStream({
    transform(chunk, ctl) {
      got += chunk.length;
      if (total) state.pct = Math.round((100 * got) / total);
      ctl.enqueue(chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(part));
    renameSync(part, file);
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
}

/** Runs in the background; poll setupState(). Calls onReady when finished. */
export async function runSetup(onReady = () => {}) {
  if (state.running) return;
  Object.assign(state, { running: true, error: null, done: false, pct: null });
  try {
    const missing = [];
    if (!binPath("whisper-cli")) missing.push("whisper-cpp");
    if (!binPath("ffmpeg")) missing.push("ffmpeg");
    if (missing.length) {
      const brew = brewPath();
      if (!brew) throw new Error("Homebrew isn't installed. Install it from brew.sh, then try again.");
      state.step = `Installing ${missing.join(" and ")} with Homebrew…`;
      await brewInstall(brew, missing);
    }
    for (const d of DOWNLOADS) {
      state.step = `Downloading the ${d.label}…`;
      state.pct = 0;
      await download(d);
    }
    Object.assign(state, { step: "Ready", pct: null, done: true });
    onReady();
  } catch (err) {
    state.error = String(err.message || err);
  } finally {
    state.running = false;
  }
}
