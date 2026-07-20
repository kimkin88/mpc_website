#!/usr/bin/env node
/**
 * Compress images/video and build media/_opt/manifest.json for responsive WebP delivery.
 * Requires: ImageMagick (`magick`), `cwebp`, `gif2webp` (libwebp). Optional: `ffmpeg` for video.
 *
 * Source originals live in media/ (Campaigns, Webp portfolio, Team GIFs, Logos, etc.).
 * Portfolio stills in media/Webp/*.webp get 480/960/1440 variants under media/_opt/Webp/.
 * After first run, use `npm run prune-sources` to drop originals once WebP exists.
 * Re-running without originals will only refresh the video entry.
 *
 *   node scripts/optimize-media.js
 */
'use strict';

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MEDIA = path.join(ROOT, 'media');
const OPT = path.join(MEDIA, '_opt');
const MANIFEST_PATH = path.join(OPT, 'manifest.json');

const CAMPAIGN_WIDTHS = [480, 960, 1440];
const TEAM_WIDTH = 264;
const TEAM_SIZE = 264;
const MAX_WIDTH = 1920;
const JPG_QUALITY = 82;
const WEBP_QUALITY = 80;

function has(cmd) {
  try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function run(cmd) {
  execSync(cmd, { stdio: 'inherit', shell: true });
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function relMedia(abs) {
  return '/media/' + path.relative(MEDIA, abs).split(path.sep).join('/');
}

function optPath(relUrl) {
  const rel = relUrl.replace(/^\/media\//, '');
  return path.join(OPT, rel);
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name === '_opt' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function optimizeRaster(src, widths, manifestKey) {
  const ext = path.extname(src).toLowerCase();
  if (!['.jpg', '.jpeg', '.png'].includes(ext)) return;

  const rel = relMedia(src);
  const baseOpt = optPath(rel);
  ensureDir(path.dirname(baseOpt));

  const outJpg = ext === '.png' ? baseOpt.replace(/\.png$/i, '.jpg') : baseOpt;
  run(`magick "${src}" -strip -interlace Plane -quality ${JPG_QUALITY} -resize ${MAX_WIDTH}x${MAX_WIDTH}\\> "${outJpg}"`);

  const webp = {};
  for (const w of widths) {
    const wp = outJpg.replace(/\.(jpe?g|png)$/i, `-${w}w.webp`);
    run(`magick "${outJpg}" -resize ${w}x -quality ${WEBP_QUALITY} "${wp}"`);
    webp[String(w)] = relMedia(wp);
  }

  const masterWebp = outJpg.replace(/\.jpe?g$/i, '.webp');
  run(`magick "${outJpg}" -quality ${WEBP_QUALITY} "${masterWebp}"`);

  return {
    key: manifestKey || rel,
    entry: {
      src: relMedia(outJpg),
      webp: { ...webp, full: relMedia(masterWebp) },
    },
  };
}

function optimizeGif(src) {
  const rel = relMedia(src);
  const outWebp = optPath(rel).replace(/\.gif$/i, '.webp');
  const tmpGif = path.join(OPT, '.tmp', path.basename(src));
  ensureDir(path.dirname(outWebp));
  ensureDir(path.dirname(tmpGif));

  run(`magick "${src}" -coalesce -resize ${TEAM_SIZE}x${TEAM_SIZE}^ -gravity center -extent ${TEAM_SIZE}x${TEAM_SIZE} -layers Optimize -colors 128 "${tmpGif}"`);

  if (has('gif2webp')) {
    run(`gif2webp -m 4 -q ${WEBP_QUALITY} -lossy "${tmpGif}" -o "${outWebp}"`);
    try { fs.unlinkSync(tmpGif); } catch {}
    return {
      key: rel,
      entry: {
        src: relMedia(outWebp),
        animated: true,
        fallback: rel,
        webp: { [String(TEAM_WIDTH)]: relMedia(outWebp) },
      },
    };
  }

  const outGif = optPath(rel);
  fs.renameSync(tmpGif, outGif);
  return {
    key: rel,
    entry: { src: relMedia(outGif), animated: true, fallback: rel },
  };
}

function optimizeLogo(src) {
  const rel = relMedia(src);
  const out = optPath(rel);
  ensureDir(path.dirname(out));
  const ext = path.extname(src).toLowerCase();
  if (ext === '.png') {
    run(`magick "${src}" -strip -define png:compression-filter=5 -define png:compression-level=9 "${out}"`);
    const webp = out.replace(/\.png$/i, '.webp');
    run(`magick "${out}" -quality 90 "${webp}"`);
    return {
      key: rel,
      entry: { src: relMedia(out), webp: { full: relMedia(webp), 480: relMedia(webp) } },
    };
  }
  return optimizeRaster(src, [480, 960], rel);
}

/** Already-WebP portfolio stills → responsive width variants under media/_opt/ */
function optimizeExistingWebp(src, widths, manifestKey) {
  const ext = path.extname(src).toLowerCase();
  if (ext !== '.webp') return null;

  const rel = relMedia(src);
  const baseOpt = optPath(rel);
  ensureDir(path.dirname(baseOpt));

  const full = baseOpt;
  run(`magick "${src}" -strip -resize ${MAX_WIDTH}x${MAX_WIDTH}\\> -quality ${WEBP_QUALITY} "${full}"`);

  const webp = { full: relMedia(full) };
  for (const w of widths) {
    const wp = baseOpt.replace(/\.webp$/i, `-${w}w.webp`);
    run(`magick "${full}" -resize ${w}x -quality ${WEBP_QUALITY} "${wp}"`);
    webp[String(w)] = relMedia(wp);
  }

  return {
    key: manifestKey || rel,
    entry: { src: relMedia(full), webp },
  };
}

function optimizeVideo() {
  if (!has('ffmpeg')) {
    console.log('\n⚠ ffmpeg not found — skip video re-encode. Install: brew install ffmpeg\n');
    return null;
  }
  const src = path.join(MEDIA, 'Videos', 'website_showreel.mp4');
  if (!fs.existsSync(src)) return null;
  const out = path.join(OPT, 'Videos', 'website_showreel.mp4');
  ensureDir(path.dirname(out));
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) {
    return { key: '/media/Videos/website_showreel.mp4', entry: { src: relMedia(out) } };
  }
  run(`ffmpeg -y -i "${src}" -c:v libx264 -crf 26 -preset medium -movflags +faststart -vf "scale='min(1920,iw)':-2" -an "${out}"`);
  return { key: '/media/Videos/website_showreel.mp4', entry: { src: relMedia(out) } };
}

function main() {
  if (!has('magick')) {
    console.error('ImageMagick (`magick`) is required.');
    process.exit(1);
  }

  ensureDir(OPT);
  const manifest = {};
  const files = walk(MEDIA);

  console.log(`Optimizing ${files.length} files…\n`);

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const rel = relMedia(file);

    try {
      if (rel.startsWith('/media/Campaigns/')) {
        const r = optimizeRaster(file, CAMPAIGN_WIDTHS);
        if (r) manifest[r.key] = r.entry;
        console.log('✓', rel);
      } else if (rel.startsWith('/media/How We Work/')) {
        const r = ext === '.webp'
          ? optimizeExistingWebp(file, CAMPAIGN_WIDTHS)
          : optimizeRaster(file, CAMPAIGN_WIDTHS);
        if (r) manifest[r.key] = r.entry;
        console.log('✓', rel);
      } else if (rel.startsWith('/media/Webp/') && ext === '.webp') {
        const r = optimizeExistingWebp(file, CAMPAIGN_WIDTHS);
        if (r) manifest[r.key] = r.entry;
        console.log('✓', rel);
      } else if (rel.startsWith('/media/Team/') && ext === '.gif') {
        const r = optimizeGif(file);
        if (r) manifest[r.key] = r.entry;
        console.log('✓', rel);
      } else if (rel.startsWith('/media/Logos/')) {
        const r = optimizeLogo(file);
        if (r) manifest[r.key] = r.entry;
        console.log('✓', rel);
      } else if (rel === '/media/Videos/showreel_preview.jpg') {
        const r = optimizeRaster(file, [960, 1440]);
        if (r) manifest[r.key] = r.entry;
        console.log('✓', rel);
      }
    } catch (err) {
      console.error('✗', rel, err.message);
    }
  }

  const vid = optimizeVideo();
  if (vid) manifest[vid.key] = vid.entry;

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  try { fs.rmSync(path.join(OPT, '.tmp'), { recursive: true, force: true }); } catch {}
  const before = files.reduce((n, f) => n + fs.statSync(f).size, 0);
  const after = walk(OPT).reduce((n, f) => n + fs.statSync(f).size, 0);
  console.log(`\nDone. manifest: ${Object.keys(manifest).length} entries`);
  console.log(`Source: ${(before / 1048576).toFixed(1)} MB → _opt: ${(after / 1048576).toFixed(1)} MB`);
}

main();
