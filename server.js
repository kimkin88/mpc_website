/**
 * MPC site server — zero dependencies, plain Node.js.
 *
 *   Run:        node server.js
 *   Site:       http://localhost:3000
 *   Admin:      http://localhost:3000/admin      (password below)
 *
 * Change the password with an env var:  ADMIN_KEY=mysecret node server.js
 * Content lives in Supabase (site_content). Admin saves write a backup
 * row to site_content_backups, then upsert the live payload.
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { URL } = require('url');

loadEnvFile(path.join(__dirname, '.env'));

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const IS_PROD = process.env.NODE_ENV === 'production';
const ADMIN_KEY = process.env.ADMIN_KEY;
const ROOT = __dirname;
const REQUIRED_SECTIONS = [
  'meta', 'hero', 'marquee', 'about', 'process', 'work', 'map', 'case',
  'stats', 'brands', 'quotes', 'team', 'contact', 'footer',
];
const SEED_CONTENT_FILE = path.join(ROOT, 'content.json');
const SITE = p => path.join(ROOT, 'site', p);
const WASABI_REGION = process.env.REGION || '';
const WASABI_BUCKET = process.env.BUCKET_NAME || '';
const WASABI_ACCESS_KEY = process.env.ACCESS_KEY || '';
const WASABI_SECRET_KEY = process.env.SECRET_ACCESS_KEY || '';
const WASABI_ENDPOINT = (
  process.env.WASABI_ENDPOINT ||
  (WASABI_REGION ? `https://s3.${WASABI_REGION}.wasabisys.com` : '')
).replace(/\/+$/, '');
const USE_WASABI_MEDIA = Boolean(
  WASABI_BUCKET && WASABI_ACCESS_KEY && WASABI_SECRET_KEY && WASABI_ENDPOINT
);
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

let contentCache = null;
let contentUpdatedAt = 0;
let mediaManifest = {};
let mediaManifestJson = '{}';
let indexCache = { html: null, etag: null, mtime: 0 };

function setMediaManifest(rawJson) {
  try {
    mediaManifest = JSON.parse(rawJson);
    mediaManifestJson = rawJson.replace(/<\//g, '<\\/');
  } catch {
    mediaManifest = {};
    mediaManifestJson = '{}';
  }
  indexCache = { html: null, etag: null, mtime: 0 };
}

/** Map original /media/... paths to optimized Wasabi keys when the original object is gone. */
function resolveMediaPath(reqPath) {
  const entry = mediaManifest[reqPath];
  if (!entry) return reqPath;
  if (entry.webp && entry.webp.full) return entry.webp.full;
  if (entry.src) return entry.src;
  if (entry.webp) {
    const widths = Object.keys(entry.webp).filter(k => k !== 'full' && !isNaN(+k)).sort((a, b) => +b - +a);
    if (widths.length) return entry.webp[widths[0]];
  }
  return reqPath;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function readSeedContent() {
  return JSON.parse(fs.readFileSync(SEED_CONTENT_FILE, 'utf8'));
}

function setContentCache(data, updatedAt) {
  contentCache = data;
  contentUpdatedAt = updatedAt ? new Date(updatedAt).getTime() : Date.now();
  indexCache = { html: null, etag: null, mtime: 0 };
}

function readContentJson() {
  if (!contentCache) throw new Error('Content not loaded');
  return JSON.stringify(contentCache);
}

function keyOK(req) {
  const given = req.headers['x-admin-key'] || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function wantsGzip(req) {
  return /\bgzip\b/.test(req.headers['accept-encoding'] || '');
}

function send(res, req, code, body, type = 'application/json', cache = 'no-store') {
  const headers = {
    'Content-Type': type + '; charset=utf-8',
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Accept-Encoding',
  };
  if (typeof body === 'string') body = Buffer.from(body);
  if (wantsGzip(req) && body.length > 512) {
    zlib.gzip(body, { level: 6 }, (err, gz) => {
      if (err) {
        headers['Content-Length'] = body.length;
        res.writeHead(code, headers);
        return res.end(body);
      }
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = gz.length;
      res.writeHead(code, headers);
      res.end(gz);
    });
    return;
  }
  headers['Content-Length'] = body.length;
  res.writeHead(code, headers);
  res.end(body);
}

async function supabaseRequest(pathname, { method = 'GET', body, prefer } = {}) {
  if (!USE_SUPABASE) throw new Error('Supabase is not configured');
  const url = new URL(pathname, SUPABASE_URL + '/');
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    Accept: 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); }
    catch { json = text; }
  }
  if (!res.ok) {
    const detail = typeof json === 'object' && json
      ? (json.message || json.error || JSON.stringify(json))
      : String(json || res.statusText);
    const err = new Error(`Supabase ${method} ${pathname} failed: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function loadContentFromSupabase() {
  const rows = await supabaseRequest(
    'rest/v1/site_content?id=eq.main&select=data,updated_at'
  );
  if (Array.isArray(rows) && rows.length && rows[0].data) {
    const data = normalizeContent(rows[0].data);
    setContentCache(data, rows[0].updated_at);
    return contentCache;
  }
  if (!fs.existsSync(SEED_CONTENT_FILE)) {
    throw new Error('No content in Supabase and no local content.json seed found');
  }
  const seed = normalizeContent(readSeedContent());
  const upserted = await supabaseRequest('rest/v1/site_content', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: [{ id: 'main', data: seed, updated_at: new Date().toISOString() }],
  });
  const row = Array.isArray(upserted) ? upserted[0] : null;
  setContentCache(seed, row && row.updated_at);
  console.log('  Seeded Supabase site_content from content.json');
  return contentCache;
}

function normalizeContent(data) {
  if (!data || typeof data !== 'object') return data;
  if (!data.case && data._case_backup) {
    const { _note, ...restored } = data._case_backup;
    data.case = restored;
    delete data._case_backup;
  }
  if (!data.case) {
    data.case = { kicker: '', heading: '', text: '', img: '' };
  }
  if (!data.team) data.team = { heading: 'The Team', intro: '', members: {} };
  if (Array.isArray(data.team.members)) {
    data.team.members = { Team: data.team.members };
  } else if (!data.team.members || typeof data.team.members !== 'object') {
    data.team.members = {};
  }
  return data;
}

async function saveContentToSupabase(parsed) {
  if (contentCache) {
    await supabaseRequest('rest/v1/site_content_backups', {
      method: 'POST',
      prefer: 'return=minimal',
      body: [{ data: contentCache }],
    });
  }
  const updatedAt = new Date().toISOString();
  const upserted = await supabaseRequest('rest/v1/site_content', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: [{ id: 'main', data: parsed, updated_at: updatedAt }],
  });
  const row = Array.isArray(upserted) ? upserted[0] : null;
  setContentCache(parsed, row && row.updated_at ? row.updated_at : updatedAt);
}

function hashHex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function encodeS3Path(pathname) {
  return pathname
    .split('/')
    .map(part => encodeURIComponent(part))
    .join('/')
    .replace(/%2F/g, '/');
}

function buildWasabiRequest(reqPath, method, rangeHeader) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const endpoint = new URL(WASABI_ENDPOINT);
  const canonicalUri = `/${encodeURIComponent(WASABI_BUCKET)}${encodeS3Path(reqPath)}`;
  const host = endpoint.host;
  const payloadHash = hashHex('');
  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (rangeHeader) headers.range = rangeHeader;
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map(name => `${name}:${String(headers[name]).trim().replace(/\s+/g, ' ')}`)
    .join('\n') + '\n';
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    method,
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${WASABI_REGION}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    hashHex(canonicalRequest),
  ].join('\n');
  const kDate = hmac(`AWS4${WASABI_SECRET_KEY}`, dateStamp);
  const kRegion = hmac(kDate, WASABI_REGION);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign, 'hex');
  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${WASABI_ACCESS_KEY}/${scope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ');

  return {
    hostname: endpoint.hostname,
    port: endpoint.port || 443,
    protocol: endpoint.protocol,
    method,
    path: canonicalUri,
    headers: {
      Host: host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: authorization,
      ...(rangeHeader ? { Range: rangeHeader } : {}),
    },
  };
}

function buildWasabiPresignedGetUrl(reqPath, expiresInSec = 3600) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const endpoint = new URL(WASABI_ENDPOINT);
  const canonicalUri = `/${encodeURIComponent(WASABI_BUCKET)}${encodeS3Path(reqPath)}`;
  const credential = `${WASABI_ACCESS_KEY}/${dateStamp}/${WASABI_REGION}/s3/aws4_request`;
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': credential,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresInSec),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(params)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  const canonicalHeaders = `host:${endpoint.host}\n`;
  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const scope = `${dateStamp}/${WASABI_REGION}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    hashHex(canonicalRequest),
  ].join('\n');
  const kDate = hmac(`AWS4${WASABI_SECRET_KEY}`, dateStamp);
  const kRegion = hmac(kDate, WASABI_REGION);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign, 'hex');
  return `${WASABI_ENDPOINT}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** On Vercel (and when MEDIA_MODE=redirect), send browsers straight to Wasabi — serverless can't stream large media. */
const MEDIA_REDIRECT = process.env.MEDIA_MODE === 'redirect' || Boolean(process.env.VERCEL);

function serveWasabiMedia(req, res, reqPath) {
  const resolved = resolveMediaPath(reqPath);
  if (MEDIA_REDIRECT && req.method === 'GET') {
    const url = buildWasabiPresignedGetUrl(resolved, 3600);
    res.writeHead(302, {
      Location: url,
      'Cache-Control': 'private, max-age=300',
    });
    return res.end();
  }
  return pipeWasabiMedia(req, res, resolved);
}

function fetchFromWasabi(objectPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const options = buildWasabiRequest(objectPath, method);
    const upstream = https.request(options, upstreamRes => {
      if (!upstreamRes.statusCode || upstreamRes.statusCode >= 400) {
        upstreamRes.resume();
        return reject(new Error(`Wasabi ${method} ${objectPath} returned ${upstreamRes.statusCode || 'error'}`));
      }
      if (method === 'HEAD') {
        upstreamRes.resume();
        return resolve(null);
      }
      const chunks = [];
      upstreamRes.on('data', chunk => chunks.push(chunk));
      upstreamRes.on('end', () => resolve(Buffer.concat(chunks)));
      upstreamRes.on('error', reject);
    });
    upstream.on('error', reject);
    upstream.end();
  });
}

async function refreshMediaManifest() {
  if (!USE_WASABI_MEDIA) {
    setMediaManifest('{}');
    return;
  }
  try {
    const body = await fetchFromWasabi('/media/_opt/manifest.json');
    const text = body.toString('utf8');
    JSON.parse(text);
    setMediaManifest(text);
  } catch (err) {
    console.warn('Could not load media manifest from Wasabi:', err.message);
    setMediaManifest('{}');
  }
}

let wasabiInflight = 0;
const WASABI_MAX_INFLIGHT = 8;
const wasabiWaiters = [];

function acquireWasabiSlot() {
  return new Promise(resolve => {
    if (wasabiInflight < WASABI_MAX_INFLIGHT) {
      wasabiInflight++;
      return resolve();
    }
    wasabiWaiters.push(resolve);
  });
}

function releaseWasabiSlot() {
  const next = wasabiWaiters.shift();
  if (next) next();
  else wasabiInflight = Math.max(0, wasabiInflight - 1);
}

function pipeWasabiMedia(req, res, reqPath) {
  acquireWasabiSlot().then(() => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseWasabiSlot();
    };
    res.on('close', release);
    res.on('finish', release);

    const options = buildWasabiRequest(reqPath, req.method, req.headers.range);
    const upstream = https.request(options, upstreamRes => {
      if (upstreamRes.statusCode === 404 || upstreamRes.statusCode === 403) {
        release();
        return send(res, req, 404, '{"error":"not found"}');
      }
      if (!upstreamRes.statusCode || upstreamRes.statusCode >= 400) {
        const status = upstreamRes.statusCode || 502;
        upstreamRes.resume();
        release();
        return send(res, req, status === 416 ? 416 : 502, '{"error":"media upstream error"}');
      }

      const passthroughHeaders = {};
      const allowedHeaders = [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'etag',
        'last-modified',
        'cache-control',
      ];
      for (const name of allowedHeaders) {
        const value = upstreamRes.headers[name];
        if (value) passthroughHeaders[name] = value;
      }
      if (!passthroughHeaders['cache-control']) {
        passthroughHeaders['cache-control'] = 'public, max-age=31536000, immutable';
      }
      passthroughHeaders['x-content-type-options'] = 'nosniff';
      res.writeHead(upstreamRes.statusCode, passthroughHeaders);
      if (req.method === 'HEAD') {
        upstreamRes.resume();
        release();
        return res.end();
      }
      upstreamRes.pipe(res);
    });

    upstream.on('error', err => {
      console.error('Wasabi media proxy error:', err);
      release();
      if (!res.headersSent) send(res, req, 502, '{"error":"media upstream error"}');
      else res.destroy(err);
    });

    upstream.end();
  });
}

function renderIndex() {
  const htmlPath = SITE('index.html');
  const htmlStat = fs.statSync(htmlPath);
  const stamp = Math.max(htmlStat.mtimeMs, contentUpdatedAt || 0);
  if (indexCache.html && indexCache.mtime === stamp) return indexCache;

  const html = fs.readFileSync(htmlPath, 'utf8');
  const json = JSON.stringify(contentCache).replace(/<\//g, '<\\/');
  let out = html.replace(
    /(<script id="__CONTENT__" type="application\/json">)[\s\S]*?(<\/script>)/,
    (_, a, b) => a + json + b
  );
  out = out.replace(
    /(<script id="__MEDIA_OPT__" type="application\/json">)[\s\S]*?(<\/script>)/,
    (_, a, b) => a + mediaManifestJson + b
  );
  const etag = '"' + crypto.createHash('sha1').update(out).digest('hex').slice(0, 16) + '"';
  indexCache = { html: out, etag, mtime: stamp };
  return indexCache;
}

let readyPromise = null;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      if (!USE_SUPABASE) {
        throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
      }
      await loadContentFromSupabase();
      await refreshMediaManifest();
    })().catch(err => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

async function handleRequest(req, res) {
  try {
    await ensureReady();
  } catch (err) {
    console.error(err);
    return send(res, req, 503, JSON.stringify({ error: err.message || 'content not available' }));
  }

  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  try {
    // ---------- pages ----------
    if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/' || p === '/index.html')) {
      const page = renderIndex();
      if (req.headers['if-none-match'] === page.etag) {
        res.writeHead(304, {
          'ETag': page.etag,
          'Cache-Control': 'public, max-age=60, must-revalidate',
        });
        return res.end();
      }
      res.setHeader('ETag', page.etag);
      if (req.method === 'HEAD') {
        const headers = {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=60, must-revalidate',
          'Content-Length': Buffer.byteLength(page.html),
          'ETag': page.etag,
        };
        res.writeHead(200, headers);
        return res.end();
      }
      return send(res, req, 200, page.html, 'text/html', 'public, max-age=60, must-revalidate');
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/admin' || p === '/admin/')) {
      const body = fs.readFileSync(SITE('admin.html'), 'utf8');
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(body),
        });
        return res.end();
      }
      return send(res, req, 200, body, 'text/html');
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/health') {
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength('{"ok":true}'),
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end();
      }
      return send(res, req, 200, '{"ok":true}');
    }

    // ---------- static fonts (self-hosted, long-cache) ----------
    if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/fonts/')) {
      const name = path.basename(p);
      if (!name || name !== path.normalize(name) || name.includes('..')) {
        return send(res, req, 404, '{"error":"not found"}');
      }
      const file = path.join(ROOT, 'site', 'fonts', name);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return send(res, req, 404, '{"error":"not found"}');
      }
      const ext = path.extname(name).toLowerCase();
      const mime = ext === '.woff2' ? 'font/woff2'
        : ext === '.css' ? 'text/css; charset=utf-8'
        : 'application/octet-stream';
      const body = fs.readFileSync(file);
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': body.length,
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }

    // ---------- static media ----------
    if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/media/')) {
      if (USE_WASABI_MEDIA) {
        return serveWasabiMedia(req, res, p);
      }
      return send(res, req, 503, '{"error":"media storage not configured"}');
    }

    // ---------- api ----------
    if (req.method === 'GET' && p === '/api/verify') {
      return keyOK(req) ? send(res, req, 200, '{"ok":true}') : send(res, req, 401, '{"error":"unauthorised"}');
    }
    if (req.method === 'GET' && p === '/api/content') {
      try {
        return send(res, req, 200, readContentJson(), 'application/json', 'private, no-store');
      } catch (err) {
        console.error(err);
        return send(res, req, 503, '{"error":"content not available"}');
      }
    }
    if (req.method === 'POST' && p === '/api/content') {
      if (!keyOK(req)) return send(res, req, 401, '{"error":"unauthorised"}');
      if (!USE_SUPABASE) return send(res, req, 503, '{"error":"supabase not configured"}');
      let body = '';
      let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { req.destroy(); return; } // 2 MB cap
        body += chunk;
      });
      req.on('end', async () => {
        let parsed;
        try { parsed = JSON.parse(body); }
        catch { return send(res, req, 400, '{"error":"invalid JSON"}'); }
        for (const k of REQUIRED_SECTIONS) {
          if (!(k in parsed)) return send(res, req, 400, JSON.stringify({ error: `missing section: ${k}` }));
        }
        try {
          await saveContentToSupabase(parsed);
          return send(res, req, 200, '{"ok":true}');
        } catch (err) {
          console.error(err);
          return send(res, req, 502, JSON.stringify({ error: err.message || 'supabase save failed' }));
        }
      });
      return;
    }

    send(res, req, 404, '{"error":"not found"}');
  } catch (err) {
    console.error(err);
    send(res, req, 500, '{"error":"server error"}');
  }
}

const server = http.createServer((req, res) => {
  Promise.resolve(handleRequest(req, res)).catch(err => {
    console.error(err);
    if (!res.headersSent) send(res, req, 500, '{"error":"server error"}');
  });
});

module.exports = (req, res) => {
  Promise.resolve(handleRequest(req, res)).catch(err => {
    console.error(err);
    if (!res.headersSent) send(res, req, 500, '{"error":"server error"}');
  });
};

if (require.main === module) {
  (async () => {
    try {
      await ensureReady();
    } catch (err) {
      console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
      console.error('Add them from Supabase → Project Settings → API, then restart.');
      console.error(err.message);
      process.exit(1);
    }
    server.listen(PORT, HOST, () => {
      console.log('');
      console.log('  MPC site running');
      console.log(`  Site:   http://localhost:${PORT}`);
      console.log(`  Admin:  http://localhost:${PORT}/admin`);
      console.log(`  Content: Supabase (${SUPABASE_URL})`);
      if (USE_WASABI_MEDIA) {
        console.log(`  Media:  Wasabi bucket ${WASABI_BUCKET} via ${WASABI_ENDPOINT}${MEDIA_REDIRECT ? ' (redirect)' : ' (proxy)'}`);
      } else {
        console.warn('  WARNING: Wasabi media storage is not configured — /media/* will return 503.');
      }
      if (!process.env.ADMIN_KEY && IS_PROD) {
        console.warn('  WARNING: Set ADMIN_KEY in production — still using the default password.');
      } else if (!IS_PROD && !process.env.ADMIN_KEY) {
        console.log(`  Admin password: ${ADMIN_KEY}  (override with ADMIN_KEY env var)`);
      }
      console.log('');
    });
  })();
}
