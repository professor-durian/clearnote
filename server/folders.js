// Folder browser for choosing where audio is saved on this computer. Lists
// folders only (never files), inside your home folder or on an external drive.

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const ROOTS = [HOME, "/Volumes"];

export function expand(p) {
  return path.resolve(String(p || HOME).replace(/^~(?=$|\/)/, HOME));
}

function allowed(p) {
  return ROOTS.some((r) => p === r || p.startsWith(`${r}${path.sep}`));
}

const tilde = (p) => (p === HOME || p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p);

/** Shortcuts shown above the list: only the ones that exist on this Mac. */
function places() {
  const list = [
    { name: "Home", path: HOME },
    { name: "Desktop", path: path.join(HOME, "Desktop") },
    { name: "Documents", path: path.join(HOME, "Documents") },
    { name: "iCloud Drive", path: path.join(HOME, "Library/Mobile Documents/com~apple~CloudDocs") },
  ];
  // Google Drive for desktop, Dropbox, OneDrive and others mount here.
  const cloud = path.join(HOME, "Library/CloudStorage");
  if (existsSync(cloud)) {
    for (const name of readdirSync(cloud)) {
      const p = path.join(cloud, name);
      const myDrive = path.join(p, "My Drive");
      list.push({
        name: name.startsWith("GoogleDrive-") ? `Google Drive (${name.slice(12)})` : name.split("-")[0],
        path: existsSync(myDrive) ? myDrive : p,
      });
    }
  }
  return list.filter((p) => existsSync(p.path)).map((p) => ({ ...p, display: tilde(p.path) }));
}

export function listDirs(p) {
  const dir = expand(p);
  if (!allowed(dir)) throw Object.assign(new Error("Choose a folder inside your home folder or on an external drive."), { status: 400 });
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw Object.assign(new Error("That folder doesn't exist."), { status: 404 });
  let dirs = [];
  try {
    dirs = readdirSync(dir, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith("."))
      .filter((d) => {
        try {
          return statSync(path.join(dir, d.name)).isDirectory();
        } catch {
          return false;
        }
      })
      .map((d) => d.name)
      .filter((n) => !(dir === HOME && n === "Library"))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    // macOS may refuse a protected folder; show it as empty rather than fail.
  }
  const parent = path.dirname(dir);
  return {
    path: dir,
    display: tilde(dir),
    parent: dir !== parent && allowed(parent) ? parent : null,
    dirs,
    places: places(),
  };
}

export function makeDir(parentPath, name) {
  const clean = String(name || "").trim().replace(/[\/\\:]/g, "-");
  if (!clean || clean.startsWith(".")) throw Object.assign(new Error("Give the folder a name."), { status: 400 });
  const dir = path.join(expand(parentPath), clean);
  if (!allowed(dir)) throw Object.assign(new Error("Not allowed there."), { status: 400 });
  mkdirSync(dir, { recursive: true });
  return listDirs(dir);
}
