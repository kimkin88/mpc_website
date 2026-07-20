#!/usr/bin/env node
/**
 * Remove original JPG/PNG/GIF sources (and _opt JPEG/PNG intermediates) once WebP
 * derivatives exist in media/_opt/manifest.json.
 *
 *   node scripts/remove-converted-sources.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MEDIA = path.join(ROOT, 'media');
const OPT = path.join(MEDIA, '_opt');
const MANIFEST_PATH = path.join(OPT, 'manifest.json');

function diskPath(url) {
  return path.join(ROOT, url.replace(/^\/media\//, 'media/'));
}

function isRaster(url) {
  return /\.(jpe?g|png|gif)$/i.test(url);
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function rm(url, removed) {
  const p = diskPath(url);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    removed.push(url);
  }
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  for (const entry of Object.values(manifest)) {
    if (entry.webp && entry.webp.full && entry.src !== entry.webp.full) {
      entry.src = entry.webp.full;
    }
    if (entry.animated) delete entry.fallback;
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log('Updated manifest → WebP src paths\n');

  const removed = [];

  for (const [key, entry] of Object.entries(manifest)) {
    if (key.endsWith('.mp4') && entry.src?.startsWith('/media/_opt/')) {
      rm(key, removed);
      continue;
    }
    if (isRaster(key)) rm(key, removed);
    if (entry.src && entry.src.startsWith('/media/_opt/') && isRaster(entry.src)) {
      // handled by _opt sweep below
    }
  }

  for (const file of walk(OPT)) {
    const rel = '/media/' + path.relative(MEDIA, file).split(path.sep).join('/');
    if (rel === '/media/_opt/manifest.json') continue;
    if (!/\.(jpe?g|png)$/i.test(rel)) continue;
    const webp = rel.replace(/\.(jpe?g|png)$/i, '.webp');
    if (fs.existsSync(diskPath(webp))) rm(rel, removed);
  }

  const unique = [...new Set(removed)].sort();
  console.log(`Removed ${unique.length} files:`);
  unique.forEach(f => console.log('  -', f));

  const total = walk(MEDIA).reduce((n, f) => n + fs.statSync(f).size, 0);
  console.log(`\nmedia/ total: ${(total / 1048576).toFixed(1)} MB`);
}

main();
