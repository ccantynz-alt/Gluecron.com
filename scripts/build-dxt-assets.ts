#!/usr/bin/env bun
/**
 * BLOCK Q1 — placeholder asset generator for the Claude Desktop .dxt bundle.
 *
 * Generates two PNGs into extension/gluecron.dxt/:
 *   - icon.png         256x256 — dark-bg "g" mark with accent gradient
 *   - screenshot-1.png 1280x800 — dark-bg wordmark placeholder
 *
 * These are intentionally simple: hand-rolled PNGs (no Canvas / sharp / etc.)
 * so the build works on any system with `bun` + system `zip`. The intent is
 * for a designer to replace them later; both files are committed as
 * placeholders so the .dxt is shippable today.
 *
 * Follow-up: replace icon.png with the actual brand "g" SVG-rasterised at
 * 256x256, and screenshot-1.png with a real product screenshot of Claude
 * opening a PR on Gluecron.
 *
 * Usage:
 *   bun run scripts/build-dxt-assets.ts
 *
 * Idempotent — re-running overwrites the files in place.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { deflateSync } from "node:zlib";

const OUT_DIR = join(import.meta.dir, "..", "extension", "gluecron.dxt");

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGB, no alpha, no filtering beyond filter=0).
// Hand-rolled to avoid pulling in a dependency just for placeholder assets.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const len = u32be(data.length);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.length);
  const crc = u32be(crc32(crcInput));
  const out = new Uint8Array(4 + 4 + data.length + 4);
  out.set(len, 0);
  out.set(typeBytes, 4);
  out.set(data, 8);
  out.set(crc, 8 + data.length);
  return out;
}

function encodePng(
  width: number,
  height: number,
  pixels: Uint8Array // RGB, length = width*height*3
): Uint8Array {
  if (pixels.length !== width * height * 3) {
    throw new Error("pixel buffer size mismatch");
  }
  // IHDR
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IDAT — prepend filter byte (0 = None) to every scanline.
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter type
    raw.set(pixels.subarray(y * width * 3, (y + 1) * width * 3), rowStart + 1);
  }
  const idat = deflateSync(Buffer.from(raw));

  const SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrChunk = chunk("IHDR", ihdr);
  const idatChunk = chunk("IDAT", new Uint8Array(idat));
  const iendChunk = chunk("IEND", new Uint8Array(0));

  const out = new Uint8Array(
    SIG.length + ihdrChunk.length + idatChunk.length + iendChunk.length
  );
  let off = 0;
  out.set(SIG, off);
  off += SIG.length;
  out.set(ihdrChunk, off);
  off += ihdrChunk.length;
  out.set(idatChunk, off);
  off += idatChunk.length;
  out.set(iendChunk, off);
  return out;
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

const BG: Rgb = [0x0d, 0x11, 0x17]; // #0d1117
const ACCENT_START: Rgb = [0x8c, 0x6d, 0xff]; // #8c6dff (purple)
const ACCENT_END: Rgb = [0x36, 0xc5, 0xd6]; // #36c5d6 (teal)
const FG: Rgb = [0xe6, 0xed, 0xf3]; // soft white

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function makeBuf(w: number, h: number, fill: Rgb): Uint8Array {
  const buf = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    buf[i * 3] = fill[0];
    buf[i * 3 + 1] = fill[1];
    buf[i * 3 + 2] = fill[2];
  }
  return buf;
}

function setPixel(buf: Uint8Array, w: number, x: number, y: number, c: Rgb) {
  const i = (y * w + x) * 3;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
}

function fillRect(
  buf: Uint8Array,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  c: Rgb
) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      setPixel(buf, w, x, y, c);
    }
  }
}

function fillCircle(
  buf: Uint8Array,
  w: number,
  cx: number,
  cy: number,
  r: number,
  c: Rgb
) {
  const r2 = r * r;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        setPixel(buf, w, x, y, c);
      }
    }
  }
}

function ringMask(cx: number, cy: number, rOuter: number, rInner: number) {
  const rO2 = rOuter * rOuter;
  const rI2 = rInner * rInner;
  return (x: number, y: number) => {
    const dx = x - cx;
    const dy = y - cy;
    const d2 = dx * dx + dy * dy;
    return d2 <= rO2 && d2 >= rI2;
  };
}

// ---------------------------------------------------------------------------
// 1. icon.png — 256x256 "g" mark on dark bg, gradient ring
// ---------------------------------------------------------------------------

function drawIcon(): Uint8Array {
  const W = 256;
  const H = 256;
  const buf = makeBuf(W, H, BG);

  // Gradient ring: outer radius 110, inner radius 86.
  const cx = W / 2;
  const cy = H / 2;
  const inRing = ringMask(cx, cy, 110, 86);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (inRing(x, y)) {
        // gradient along x (left = start, right = end).
        const t = x / W;
        setPixel(buf, W, x, y, lerpRgb(ACCENT_START, ACCENT_END, t));
      }
    }
  }

  // Stylised "g" — a filled disc with a notch cut on the right side and a
  // descender bar. Placeholder, not the real wordmark.
  fillCircle(buf, W, cx, cy, 60, FG);
  // Cut the right notch (rectangle in BG colour).
  fillRect(buf, W, cx + 20, cy - 18, cx + 65, cy + 8, BG);
  // Descender bar.
  fillRect(buf, W, cx + 18, cy + 8, cx + 60, cy + 24, FG);

  return encodePng(W, H, buf);
}

// ---------------------------------------------------------------------------
// 2. screenshot-1.png — 1280x800 dark mockup with wordmark band
// ---------------------------------------------------------------------------

function drawScreenshot(): Uint8Array {
  const W = 1280;
  const H = 800;
  const buf = makeBuf(W, H, BG);

  // Top accent gradient bar (the wordmark band).
  for (let y = 60; y < 80; y++) {
    for (let x = 0; x < W; x++) {
      const t = x / W;
      setPixel(buf, W, x, y, lerpRgb(ACCENT_START, ACCENT_END, t));
    }
  }

  // Mock "browser chrome" — three traffic-light circles.
  fillCircle(buf, W, 30, 30, 8, [0xff, 0x5f, 0x57]);
  fillCircle(buf, W, 52, 30, 8, [0xfe, 0xbc, 0x2e]);
  fillCircle(buf, W, 74, 30, 8, [0x27, 0xc9, 0x3f]);

  // Mock "card" — a centered panel that hints at a PR view.
  const px = 200;
  const py = 200;
  const pw = W - 400;
  const ph = H - 400;
  fillRect(buf, W, px, py, px + pw, py + ph, [0x16, 0x1b, 0x22]); // panel bg

  // Header strip on the panel
  fillRect(buf, W, px, py, px + pw, py + 60, [0x21, 0x26, 0x2d]);

  // "PR opened" accent dot (green).
  fillCircle(buf, W, px + 30, py + 30, 10, [0x3f, 0xb9, 0x50]);

  // Two faux content rows.
  fillRect(buf, W, px + 30, py + 100, px + pw - 30, py + 110, [0x30, 0x36, 0x3d]);
  fillRect(buf, W, px + 30, py + 140, px + pw - 100, py + 150, [0x30, 0x36, 0x3d]);
  fillRect(buf, W, px + 30, py + 180, px + pw - 200, py + 190, [0x30, 0x36, 0x3d]);

  return encodePng(W, H, buf);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const iconPath = join(OUT_DIR, "icon.png");
  const screenshotPath = join(OUT_DIR, "screenshot-1.png");

  writeFileSync(iconPath, drawIcon());
  console.log(`wrote ${iconPath}`);

  writeFileSync(screenshotPath, drawScreenshot());
  console.log(`wrote ${screenshotPath}`);
}

main();
