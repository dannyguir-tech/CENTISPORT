import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const DATA = path.join(ROOT, 'data');

export const toTs = (iso) => (iso ? Math.floor(Date.parse(String(iso).replace(' ', 'T').replace(/\+00(:00)*$/, 'Z')) / 1000) : null);
export const isoOf = (ts) => new Date(ts * 1000).toISOString();
export const dayKey = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

export function parseArr(x) {
  if (Array.isArray(x)) return x;
  if (typeof x === 'string' && x.length) { try { return JSON.parse(x); } catch { return null; } }
  return null;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function writeJSONL(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  for (const r of rows) fs.writeSync(fd, JSON.stringify(r) + '\n');
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

export function readJSONL(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) if (line.trim()) out.push(JSON.parse(line));
  return out;
}

export function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(obj));
  fs.renameSync(file + '.tmp', file);
}

export const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

export function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
