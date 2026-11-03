#!/usr/bin/env node
/**
 * Enforces the determinism rules from PRD 6.3 as a build gate.
 *
 * Simulation code (src/sim) may not contain:
 *   - Math.random, wall-clock reads, or any float-producing Math function
 *   - floating point literals
 *   - the `/` operator (use Fx.idiv / Fx.div / bit shifts, which are exact)
 *   - imports from anywhere except src/sim, src/fx and src/data
 *
 * src/fx is the one place allowed to touch floats, because every operation in
 * it is an exact integer computation dressed as arithmetic, and it is small
 * enough to audit by eye.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIM_DIR = join(root, 'src', 'sim');
const FX_DIR = join(root, 'src', 'fx');

const ALLOWED_MATH = new Set(['floor', 'ceil', 'abs', 'min', 'max', 'imul']);

const BANNED_PATTERNS = [
  [/\bMath\.random\b/, 'Math.random: use the seeded Rng from src/sim/rng.ts'],
  [/\bDate\.now\b/, 'Date.now: no wall-clock reads inside the tick'],
  [/\bperformance\.now\b/, 'performance.now: no wall-clock reads inside the tick'],
  [/\bnew Date\b/, 'new Date: no wall-clock reads inside the tick'],
  [/\bcrypto\./, 'crypto: nondeterministic'],
  [/\bMath\.fround\b/, 'Math.fround: float'],
  [/(^|[^\w.])\d+\.\d+/, 'floating point literal: use Fx.ratio(num, den)'],
  [/(^|[^\w.])\d+e[+-]?\d+/i, 'exponent literal: use an integer'],
  [/\bparseFloat\b/, 'parseFloat: float'],
  [/\bNumber\s*\(/, 'Number(): may produce a float'],
];

/** Strips comments and string/template contents so the scan sees only code. */
function strip(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += quote;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') i++;
        if (src[i] === '\n') out += '\n';
        i++;
      }
      out += quote;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

async function tsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFiles(p)));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const problems = [];

function report(file, lineNo, line, msg) {
  problems.push(`${relative(root, file)}:${lineNo}  ${msg}\n    ${line.trim()}`);
}

for (const file of await tsFiles(SIM_DIR)) {
  const raw = await readFile(file, 'utf8');
  const code = strip(raw);
  const lines = code.split('\n');
  const rawLines = raw.split('\n');

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const shown = rawLines[idx] ?? line;

    for (const [re, msg] of BANNED_PATTERNS) {
      if (re.test(line)) report(file, lineNo, shown, msg);
    }

    // Any Math member outside the exact-integer allow-list.
    for (const m of line.matchAll(/\bMath\.(\w+)/g)) {
      if (!ALLOWED_MATH.has(m[1])) {
        report(file, lineNo, shown, `Math.${m[1]} is not exact: only ${[...ALLOWED_MATH].join(', ')} are allowed`);
      }
    }

    // Division, ignoring import specifiers (already stripped to quotes).
    const noRegexLiteral = line.replace(/\/[^/\n]+\/[gimsuy]*/g, '');
    if (/[^\s/=][ ]*\/[ ]*[^/=]/.test(noRegexLiteral) && !/\bfrom\b/.test(line)) {
      report(file, lineNo, shown, 'division: use Fx.idiv (exact) or a bit shift');
    }

    // Import boundary.
    const imp = line.match(/from\s+'([^']+)'/);
    if (imp) {
      const spec = imp[1];
      const ok = spec.startsWith('./') || spec.startsWith('../fx/') || spec.startsWith('../data/');
      if (!ok) {
        report(file, lineNo, shown, `src/sim may only import from src/sim, src/fx and src/data (found ${spec})`);
      }
    }
  });
}

// src/fx must stay self-contained: it is the audited exception to the rules.
for (const file of await tsFiles(FX_DIR)) {
  const raw = await readFile(file, 'utf8');
  strip(raw)
    .split('\n')
    .forEach((line, idx) => {
      const imp = line.match(/from\s+'([^']+)'/);
      if (imp && !imp[1].startsWith('./')) {
        report(file, idx + 1, raw.split('\n')[idx], 'src/fx must not import anything outside itself');
      }
    });
}

if (problems.length > 0) {
  console.error(`Determinism boundary violated in ${problems.length} place(s):\n`);
  for (const p of problems) console.error(`  ${p}\n`);
  console.error('See PRD 6.3. These rules are not style preferences: a single float or');
  console.error('wall-clock read in src/sim produces rare desyncs that are miserable to debug.');
  process.exit(1);
}

console.log('sim purity: ok (no floats, no clocks, no unbounded imports in src/sim)');
