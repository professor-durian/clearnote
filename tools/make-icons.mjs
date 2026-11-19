// Draws ClearNote's icon and writes the PNGs Chrome needs, plus an SVG for the
// dashboard and the in-app marks.
//
//   node tools/make-icons.mjs
//
// Rendered procedurally rather than checked in as binaries nobody can edit:
// the shape is defined once, below, and every size comes from it. PNGs are
// encoded by hand (zlib is built in) so this needs no dependencies.
//
// The mark: a rounded teal tile carrying a white sound wave. Deliberately plain, because the icon is read at 16px in
// a toolbar far more often than it is admired at 128.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

// ----------------------------------------------------------------- geometry
// Everything is in a 0..1 square, so one definition serves every size.

const TILE = { inset: 0.035, radius: 0.205 };
// A sound wave: four rounded vertical bars of different heights. Wide bars
// with real gaps, so it still reads as a wave at 16px in the toolbar.
const BAR_W = 0.1;
const BAR_GAP = 0.05;
const HEIGHTS = [0.2, 0.48, 0.32, 0.56];
const LEFT = (1 - (HEIGHTS.length * BAR_W + (HEIGHTS.length - 1) * BAR_GAP)) / 2;

const BARS = HEIGHTS.map((h, i) => ({
  x: LEFT + i * (BAR_W + BAR_GAP),
  y: (1 - h) / 2,
  w: BAR_W,
  h,
  r: BAR_W / 2,
}));

// A deep teal: distinct from Google's blue Docs and Meet icons in the toolbar.
const C1 = [0x0f, 0x6e, 0x56];
const C2 = [0x0f, 0x6e, 0x56];

const inRoundedRect = (px, py, x, y, w, h, r) => {
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
};

/** Colour at a point, or null for transparent. Coordinates are 0..1. */
function sample(px, py) {
  const i = TILE.inset;
  const side = 1 - i * 2;
  if (!inRoundedRect(px, py, i, i, side, side, TILE.radius)) return null;

  for (const b of BARS) {
    if (inRoundedRect(px, py, b.x, b.y, b.w, b.h, b.r)) return [255, 255, 255];
  }
  const t = Math.min(1, Math.max(0, (px + py) / 2));
  return [0, 1, 2].map((k) => Math.round(C1[k] + (C2[k] - C1[k]) * t));
}

// -------------------------------------------------------------- PNG encoding

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 10..12: compression, filter, interlace — all zero.

  // One filter byte per scanline; filter 0 (none) compresses well enough here.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const from = y * size * 4;
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, from, from + size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Supersample, then box-filter down — the antialiasing the shapes need. */
function renderRgba(size, ss = 8) {
  const n = size * ss;
  const out = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((x * ss + sx + 0.5) / n, (y * ss + sy + 0.5) / n);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 255;
          }
        }
      }
      const hits = a / 255;
      const i = (y * size + x) * 4;
      // Average only the covered samples, so edge pixels keep their colour
      // instead of darkening towards black.
      out[i] = hits ? Math.round(r / hits) : 0;
      out[i + 1] = hits ? Math.round(g / hits) : 0;
      out[i + 2] = hits ? Math.round(b / hits) : 0;
      out[i + 3] = Math.round(a / (ss * ss));
    }
  }
  return out;
}

// ----------------------------------------------------------------------- SVG

function svg() {
  const pct = (v) => +(v * 100).toFixed(2);
  const i = TILE.inset;
  const side = 1 - i * 2;
  const bars = BARS.map(
    (b) =>
      `  <rect x="${pct(b.x)}" y="${pct(b.y)}" width="${pct(b.w)}" height="${pct(b.h)}" rx="${pct(
        b.r,
      )}" fill="#fff"/>`,
  ).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="ClearNote">
  <rect x="${pct(i)}" y="${pct(i)}" width="${pct(side)}" height="${pct(side)}" rx="${pct(
    TILE.radius,
  )}" fill="#0f6e56"/>
${bars}
</svg>
`;
}

// ---------------------------------------------------------------------- write

const iconDir = path.join(root, "extension", "icons");
fs.mkdirSync(iconDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const file = path.join(iconDir, `icon-${size}.png`);
  fs.writeFileSync(file, encodePng(size, renderRgba(size)));
  console.log(`wrote ${path.relative(root, file)}`);
}

for (const file of [
  path.join(iconDir, "mark.svg"),
  path.join(root, "server", "public", "mark.svg"),
]) {
  fs.writeFileSync(file, svg());
  console.log(`wrote ${path.relative(root, file)}`);
}
