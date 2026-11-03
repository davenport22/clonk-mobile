#!/usr/bin/env node
/**
 * PRD 6.3 verification job.
 *
 * Bundles the simulation to a standalone ESM module, then runs the same seed and
 * the same scripted input log on two independent worker threads for 10 000 ticks,
 * comparing an FNV-1a hash of the full simulation state every 100 ticks.
 * Any divergence fails the build.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'dist-sim');

const TICKS = Number(process.env.DET_TICKS ?? 10000);
const HASH_EVERY = Number(process.env.DET_HASH_EVERY ?? 100);
const SEEDS = (process.env.DET_SEEDS ?? '1337,20260909,-77').split(',').map(Number);
const PLAYERS = 4;
const TEAMS = 2;

mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [join(root, 'src/sim/headless.ts')],
  outfile: join(outDir, 'sim.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'error',
});

const runnerPath = join(outDir, 'runner.mjs');
writeFileSync(
  runnerPath,
  `import { parentPort, workerData } from 'node:worker_threads';
import { runHeadless } from './sim.mjs';
const t0 = Date.now();
const r = runHeadless(workerData.seed, workerData.players, workerData.teams, workerData.ticks, workerData.hashEvery);
parentPort.postMessage({ ...r, ms: Date.now() - t0 });
`,
);

function runWorker(seed) {
  return new Promise((resolve, reject) => {
    const wk = new Worker(runnerPath, {
      workerData: { seed, players: PLAYERS, teams: TEAMS, ticks: TICKS, hashEvery: HASH_EVERY },
    });
    wk.on('message', resolve);
    wk.on('error', reject);
  });
}

let failed = false;
for (const seed of SEEDS) {
  const [a, b] = await Promise.all([runWorker(seed), runWorker(seed)]);
  let diverged = -1;
  if (a.hashes.length !== b.hashes.length) {
    diverged = Math.min(a.hashes.length, b.hashes.length);
  } else {
    for (let i = 0; i < a.hashes.length; i++) {
      if (a.hashes[i] !== b.hashes[i]) {
        diverged = i;
        break;
      }
    }
  }

  const perTick = (a.ms / TICKS).toFixed(3);
  if (diverged >= 0) {
    failed = true;
    console.error(
      `FAIL seed ${seed}: diverged at hash #${diverged} (tick ~${diverged * HASH_EVERY})`,
    );
  } else {
    console.log(
      `ok   seed ${String(seed).padStart(10)}  ${a.hashes.length} hashes match  ` +
        `${TICKS} ticks in ${a.ms} ms (${perTick} ms/tick)  ` +
        `gold=${a.goldTotal} ents=${a.entCount}  final=0x${(a.hashes.at(-1) >>> 0).toString(16)}`,
    );
  }
}

if (failed) {
  console.error('\nDeterminism harness FAILED. Do not ship. See PRD 6.3.');
  process.exit(1);
}
console.log('\nDeterminism harness passed.');
