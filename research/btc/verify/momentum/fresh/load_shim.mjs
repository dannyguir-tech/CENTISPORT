// Loader shim for the fresh-data test: loadUpDown(tf) = analyst records UNION the older windows fetched by fetch_ext.mjs
// (verify/momentum/data/updown_<tf>_ext.jsonl), de-duplicated on conditionId, sorted by windowStart. Records get ext:true
// when they come from the extension. Everything else is re-exported from the shared loader.
import fs from 'node:fs';
import path from 'node:path';
import * as base from '../../../lib/load.mjs';
import { readJSONL } from '../../../lib/util.mjs';
export * from '../../../lib/load.mjs';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const cache = new Map();
export function loadUpDown(tf) {
  if (cache.has(tf)) return cache.get(tf);
  const orig = base.loadUpDown(tf);
  const f = path.join(HERE, '..', 'data', `updown_${tf}_ext.jsonl`);
  const ext = fs.existsSync(f) ? readJSONL(f).filter((r) => Array.isArray(r.path)).map((r) => ({ ...r, ext: true })) : [];
  const seen = new Set(orig.map((r) => r.conditionId));
  const firstOrig = orig.length ? orig[0].windowStart : Infinity;
  const add = ext.filter((r) => !seen.has(r.conditionId) && r.windowStart < firstOrig);
  const out = [...add, ...orig].sort((a, b) => a.windowStart - b.windowStart);
  cache.set(tf, out);
  return out;
}
