#!/usr/bin/env node
/**
 * PRD 7: the shell plus the first island must stay under 4 MB gzipped, and it
 * is a hard budget that fails the build, not a dashboard nobody reads.
 *
 * Also reports time-to-interactive-relevant numbers: the entry chunk size is
 * what stands between tapping a shared link and being in a lobby.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const BUDGET_TOTAL = 4 * 1024 * 1024;
const BUDGET_ENTRY = 400 * 1024;

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

try {
  await stat(dist);
} catch {
  console.error('no dist/ — run `npm run build` first');
  process.exit(1);
}

const files = await walk(dist);
const rows = [];
let total = 0;
let entryGz = 0;

for (const f of files) {
  const buf = await readFile(f);
  const gz = gzipSync(buf).length;
  total += gz;
  const rel = relative(dist, f);
  rows.push({ rel, raw: buf.length, gz });
  if (extname(f) === '.js' && /index|main/.test(rel)) entryGz = Math.max(entryGz, gz);
}

rows.sort((a, b) => b.gz - a.gz);
const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

console.log('gzipped  raw      file');
for (const r of rows.slice(0, 12)) {
  console.log(`${kb(r.gz).padStart(8)} ${kb(r.raw).padStart(8)}  ${r.rel}`);
}
console.log(`\ntotal gzipped: ${kb(total)} / ${kb(BUDGET_TOTAL)} budget`);
console.log(`entry chunk:   ${kb(entryGz)} / ${kb(BUDGET_ENTRY)} budget`);

let failed = false;
if (total > BUDGET_TOTAL) {
  console.error(`\nFAIL: bundle over the 4 MB gzipped budget (PRD 7)`);
  failed = true;
}
if (entryGz > BUDGET_ENTRY) {
  console.error(`\nFAIL: entry chunk over budget; time-to-first-round suffers`);
  failed = true;
}
process.exit(failed ? 1 : 0);
