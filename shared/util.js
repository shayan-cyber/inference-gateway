import fs from 'node:fs';

/** Minimal `--key value` / `--key=value` / `--flag` parser. Keys are camelCased. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    let key; let val;
    if (eq >= 0) { key = a.slice(2, eq); val = a.slice(eq + 1); } else {
      key = a.slice(2);
      const nx = argv[i + 1];
      if (nx !== undefined && !nx.startsWith('--')) { val = nx; i++; } else val = 'true';
    }
    out[key.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())] = val;
  }
  return out;
}

export function num(v, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got "${v}"`);
  return n;
}

export function bool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  return v === true || v === 'true' || v === '1' || v === 'yes';
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readJsonFile(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

export function readBody(req, limit = 256 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, n)));
    req.on('error', reject);
  });
}

export function sendJson(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

export async function fetchJson(url, { method = 'GET', body, timeoutMs = 10_000, headers = {} } = {}) {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!r.ok) {
    const err = new Error(`${method} ${url} -> ${r.status}: ${text.slice(0, 300)}`);
    err.status = r.status; err.body = json;
    throw err;
  }
  return json;
}

export function isoTime(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

export function round(x, d = 2) {
  if (x === null || x === undefined || !Number.isFinite(x)) return x;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

export function fmtInt(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return String(n);
  return Math.round(n).toLocaleString('en-US');
}
