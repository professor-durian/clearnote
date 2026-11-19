// Local transcription with whisper.cpp. Turns a recorded track into timed words.
//
// launchd starts the server with no shell PATH, so the binaries are looked up
// in the usual Homebrew locations unless set in ~/.clearnote.env.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function findBin(envVar, name) {
  if (process.env[envVar]) return process.env[envVar];
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    const p = path.join(dir, name);
    if (existsSync(p)) return p;
  }
  return name; // fall back to PATH
}

export const WHISPER_BIN = findBin("CLEARNOTE_WHISPER_BIN", "whisper-cli");
export const FFMPEG_BIN = findBin("CLEARNOTE_FFMPEG_BIN", "ffmpeg");
export const MODEL =
  process.env.CLEARNOTE_WHISPER_MODEL ||
  path.join(os.homedir(), ".clearnote", "models", "ggml-large-v3-turbo-q5_0.bin");
// Silence detection. Without it whisper.cpp mistimes words that follow a long
// silence (common on the mic track), which breaks lining up with captions.
export const VAD_MODEL =
  process.env.CLEARNOTE_VAD_MODEL || path.join(os.homedir(), ".clearnote", "models", "ggml-silero-v5.1.2.bin");
const LANGUAGE = process.env.CLEARNOTE_WHISPER_LANGUAGE || "auto";

export function transcriptionStatus() {
  const missing = [];
  if (!existsSync(MODEL)) missing.push(`model (${MODEL})`);
  if (!existsSync(VAD_MODEL)) missing.push(`VAD model (${VAD_MODEL})`);
  for (const bin of [WHISPER_BIN, FFMPEG_BIN]) {
    if (path.isAbsolute(bin) && !existsSync(bin)) missing.push(bin);
  }
  return { ready: missing.length === 0, missing, model: path.basename(MODEL) };
}

/**
 * Parse whisper.cpp JSON output (-oj with -ml 1 -sow: one entry per word)
 * into [{text, startMs, endMs}], times relative to the start of the file.
 */
export function parseWhisperJson(json) {
  const items = json?.transcription || [];
  const out = [];
  for (const it of items) {
    const text = String(it.text || "").trim();
    if (!text || /^\[.*\]$/.test(text)) continue; // [BLANK_AUDIO], [Music] ...
    out.push({ text, startMs: Number(it.offsets?.from || 0), endMs: Number(it.offsets?.to || 0) });
  }
  return out;
}

/** Transcribe one recorded file (webm/opus). Returns timed words. */
export async function transcribeFile(file) {
  const base = file.replace(/\.[^.]+$/, "");
  const wav = `${base}.16k.wav`;
  try {
    await run(FFMPEG_BIN, ["-y", "-loglevel", "error", "-i", file, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], {
      maxBuffer: 1 << 24,
    });
    await run(
      WHISPER_BIN,
      ["-m", MODEL, "-f", wav, "-l", LANGUAGE, "-ml", "1", "-sow", "-oj", "-of", base, "-np", "--vad", "-vm", VAD_MODEL],
      { maxBuffer: 1 << 26, timeout: 2 * 60 * 60 * 1000 },
    );
    return parseWhisperJson(JSON.parse(readFileSync(`${base}.json`, "utf8")));
  } finally {
    rmSync(wav, { force: true });
  }
}
