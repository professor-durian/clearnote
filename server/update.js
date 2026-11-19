// Updates from the GitHub copy this install was cloned from. The dashboard
// shows when there's something new; one click pulls it and restarts the
// server (launchd starts it again), and the extension reloads itself.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = async (...args) => (await run("git", ["-C", ROOT, ...args], { timeout: 120_000 })).stdout.trim();

const state = { checkedAt: null, behind: 0, changes: [], error: null, applying: false, dirty: false };

async function safe(fn, fallback = "") {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** What's running now. The extension compares extensionCommit with what it loaded. */
export async function versionInfo() {
  return {
    commit: await safe(() => git("rev-parse", "--short", "HEAD")),
    extensionCommit: await safe(() => git("log", "-1", "--format=%h", "--", "extension")),
    branch: await safe(() => git("rev-parse", "--abbrev-ref", "HEAD")),
    remote: await safe(() => git("remote", "get-url", "origin")),
  };
}

export async function checkForUpdate() {
  try {
    const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
    await git("fetch", "--quiet", "origin", branch);
    const behind = Number(await git("rev-list", "--count", `HEAD..origin/${branch}`)) || 0;
    const log = behind ? await git("log", "--format=%s", "--no-merges", `HEAD..origin/${branch}`) : "";
    const dirty = !!(await localChanges());
    Object.assign(state, { checkedAt: Date.now(), behind, changes: log ? log.split("\n").slice(0, 20) : [], error: null, dirty });
  } catch (err) {
    Object.assign(state, { checkedAt: Date.now(), error: String(err.stderr || err.message || err).trim().split("\n").pop() });
  }
  return updateState();
}

export const updateState = () => ({ ...state });

// npm rewrites the package lock on some Node versions; that isn't a change of
// the user's, so it neither blocks an update nor survives one.
const LOCK = "server/package-lock.json";
async function localChanges() {
  const out = await git("status", "--porcelain", "--untracked-files=no");
  return out
    .split("\n")
    .filter((l) => l.trim() && !l.endsWith(LOCK))
    .join("\n");
}

/** Pull, install any new dependencies, then exit so launchd restarts us. */
export async function applyUpdate() {
  if (state.applying) return { ok: false, error: "An update is already running." };
  state.applying = true;
  try {
    await git("checkout", "--", LOCK).catch(() => {});
    const before = await git("rev-parse", "HEAD");
    const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
    await git("pull", "--ff-only", "--quiet", "origin", branch);
    const changed = await git("diff", "--name-only", before, "HEAD");
    if (/^server\/package(-lock)?\.json$/m.test(changed)) {
      const npm = path.join(path.dirname(process.execPath), "npm");
      // ci installs exactly what the lock says and leaves it untouched.
      await run(npm, ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: path.join(ROOT, "server"), timeout: 10 * 60_000 });
    }
    // A non-zero exit makes launchd start the server again (KeepAlive on failure).
    setTimeout(() => process.exit(75), 400);
    return { ok: true, restarting: true };
  } catch (err) {
    state.applying = false;
    const msg = String(err.stderr || err.message || err).trim();
    return {
      ok: false,
      error: /local changes|would be overwritten|not possible to fast-forward|diverg/i.test(msg)
        ? "This computer has its own changes to ClearNote's files, so it can't update automatically."
        : msg.split("\n").pop(),
    };
  }
}

let timer = null;
export function startUpdateChecks(everyMs = 6 * 60 * 60 * 1000) {
  clearInterval(timer);
  setTimeout(() => checkForUpdate().catch(() => {}), 30_000);
  timer = setInterval(() => checkForUpdate().catch(() => {}), everyMs);
}
