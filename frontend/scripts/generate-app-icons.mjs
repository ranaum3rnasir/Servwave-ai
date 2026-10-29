#!/usr/bin/env node
/**
 * Regenerates the installed-app icons in public/icons/ and the
 * apple-touch-icon in public/ from the ServWave mark in public/favicon.svg.
 *
 *   node scripts/generate-app-icons.mjs        (run from frontend/)
 *
 * The mark's paths are read from favicon.svg, so the icons can never drift
 * into a different (or third-party) mark. Each icon is drawn on a canvas in
 * headless Chromium and encoded here, so the opaque icons are written as
 * plain RGB PNGs: iOS paints a transparent apple-touch-icon pixel black, and
 * a launcher crops a maskable icon to its own shape.
 *
 * Output (sizes and purposes asserted by
 * src/__tests__/installed-app-head-and-manifest.test.ts):
 *   public/apple-touch-icon.png       180, full bleed, opaque (iOS rounds it)
 *   public/icons/icon-192.png         192, rounded tile, transparent corners
 *   public/icons/icon-512.png         512, rounded tile, transparent corners
 *   public/icons/icon-maskable-512.png 512, full bleed, mark inside the 80%
 *                                      safe-zone circle, opaque
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { chromium } from 'playwright';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(FRONTEND, 'public');

const favicon = readFileSync(path.join(PUBLIC, 'favicon.svg'), 'utf8');
const tile = favicon.match(/<rect[^>]*fill="(#[0-9a-fA-F]{6})"/)?.[1];
const markFill = favicon.match(/<g[^>]*fill="(#[0-9a-fA-F]{6})"/)?.[1];
const paths = [...favicon.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
if (!tile || !markFill || paths.length === 0) {
  throw new Error('favicon.svg no longer has the expected tile + mark shape');
}

const ICONS = [
  // markWidth: the mark's width as a fraction of the icon. The favicon's own
  // mark is about 0.64 wide; the maskable one is smaller so its whole bounding
  // box sits inside the 40%-radius safe circle every launcher mask keeps.
  { file: 'apple-touch-icon.png', size: 180, rounded: false, markWidth: 0.64 },
  { file: 'icons/icon-192.png', size: 192, rounded: true, markWidth: 0.64 },
  { file: 'icons/icon-512.png', size: 512, rounded: true, markWidth: 0.64 },
  { file: 'icons/icon-maskable-512.png', size: 512, rounded: false, markWidth: 0.52 },
];

/** Minimal PNG encoder: 8-bit RGB (opaque) or RGBA, filter 0 on every row. */
function encodePng(width, height, rgba, withAlpha) {
  const channels = withAlpha ? 4 : 3;
  const raw = Buffer.alloc((width * channels + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * channels + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = rowStart + 1 + x * channels;
      raw[dst] = rgba[src];
      raw[dst + 1] = rgba[src + 1];
      raw[dst + 2] = rgba[src + 2];
      if (withAlpha) raw[dst + 3] = rgba[src + 3];
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = withAlpha ? 6 : 2; // colour type: RGBA or RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  for (const icon of ICONS) {
    const pixels = await page.evaluate(
      async ({ size, rounded, markWidth, tile, markFill, paths }) => {
        const NS = 'http://www.w3.org/2000/svg';
        // Measure the mark's own bounding box once, then centre and scale it.
        const probe = document.createElementNS(NS, 'svg');
        probe.setAttribute('width', '1000');
        probe.setAttribute('height', '1000');
        const g = document.createElementNS(NS, 'g');
        for (const d of paths) {
          const p = document.createElementNS(NS, 'path');
          p.setAttribute('d', d);
          g.appendChild(p);
        }
        probe.appendChild(g);
        document.body.appendChild(probe);
        const box = g.getBBox();
        probe.remove();

        const scale = (size * markWidth) / box.width;
        const tx = size / 2 - (box.x + box.width / 2) * scale;
        const ty = size / 2 - (box.y + box.height / 2) * scale;
        const radius = rounded ? size * 0.22 : 0;
        const svg =
          `<svg xmlns="${NS}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
          `<rect width="${size}" height="${size}" rx="${radius}" fill="${tile}"/>` +
          `<g transform="translate(${tx} ${ty}) scale(${scale})" fill="${markFill}">` +
          paths.map((d) => `<path d="${d}"/>`).join('') +
          `</g></svg>`;
        const img = new Image();
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, size, size);
        return Array.from(ctx.getImageData(0, 0, size, size).data);
      },
      { ...icon, tile, markFill, paths },
    );
    const png = encodePng(icon.size, icon.size, Uint8Array.from(pixels), icon.rounded);
    const out = path.join(PUBLIC, icon.file);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, png);
    console.log(`wrote ${path.relative(FRONTEND, out)} (${icon.size}px, ${png.length} bytes)`);
  }
} finally {
  await browser.close();
}
