#!/usr/bin/env node
// Render the app-icon tile (design 6c) to a big square PNG that `tauri icon`
// can consume to regenerate every platform icon under src-tauri/icons/.
// Geometry lives in geometry.mjs, rasterisation in raster.mjs, PNG encoding
// in png.mjs — all pure; this file is only the I/O half (CLI args + the
// filesystem write), same split as scripts/release/bump.mjs vs version.mjs.
//
//   node scripts/icons/render-icon.mjs                      # writes ./app-icon-1024.png, 1024px
//   node scripts/icons/render-icon.mjs out.png --size 512    # custom path/size
//
// Then: npx tauri icon <path> — it writes into src-tauri/icons/ (or -o DIR).

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { encodePng } from './png.mjs';
import { renderIconRGBA } from './raster.mjs';

function parseArgs(argv) {
  let output = 'app-icon-1024.png';
  let size = 1024;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--size') {
      size = Number(argv[++i]);
    } else {
      rest.push(argv[i]);
    }
  }
  if (rest[0]) output = rest[0];
  return { output, size };
}

const { output, size } = parseArgs(process.argv.slice(2));
if (!Number.isFinite(size) || size <= 0) {
  throw new Error(`--size must be a positive number, got ${size}`);
}

const rgba = renderIconRGBA(size);
const png = encodePng(size, size, rgba);
const outPath = resolve(process.cwd(), output);
writeFileSync(outPath, png);
console.log(`wrote ${outPath} (${size}x${size})`);
