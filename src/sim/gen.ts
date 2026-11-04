import * as Fx from '../fx/fx';
import { GRID_H, GRID_W, SEA_LEVEL } from '../data/config';
import { MAT } from '../data/materials';
import { createMap, plugChunks, veinChunks, zoomMap } from './mapgen';
import { Rng } from './rng';
import type { World } from './world';

/**
 * Island generation.
 *
 * The landscape itself is Clonk's: a small map zoomed into chunky polygons,
 * in mapgen.ts. Everything here is what the game puts on top of it - the
 * surface line, trees, team spawns, and the veins each spawn is promised.
 */

export interface Spawn {
  x: number;
  y: number;
}

export interface GenResult {
  spawns: Spawn[];
  surface: Int32Array;
}

function surfaceOf(w: World): Int32Array {
  const out = new Int32Array(GRID_W);
  for (let x = 0; x < GRID_W; x++) {
    let y = 0;
    for (; y < GRID_H; y++) {
      if (w.mat[y * GRID_W + x] !== MAT.SKY) break;
    }
    out[x] = y;
  }
  return out;
}

/**
 * Places a starter vein below a spawn and keeps trying nearby spots until
 * enough of it actually landed.
 *
 * PRD 5.4 promises the first dig pays off within ten seconds. A single blind
 * attempt does not deliver that: drop it into a tunnel or a water pocket and
 * the player digs down to nothing on their first go, which is the worst
 * possible first impression. Drawn as zoom chunks like every other vein, so
 * the promised one does not stand out as the only round blob on the map.
 */
function starterVein(
  w: World,
  rng: Rng,
  sp: Spawn,
  minDepth: number,
  maxDepth: number,
  material: number,
  wanted: number,
): void {
  for (let attempt = 0; attempt < 10; attempt++) {
    const x = sp.x + rng.range(-6, 6);
    const y = sp.y + rng.range(minDepth, maxDepth);
    if (veinChunks(w, x, y, material, rng.int(1 << 20)) >= wanted) return;
  }
  // Nowhere solid within reach - the ground under this spawn is mostly tunnel.
  // The promise is a design guarantee, not a hope, so plug the hole with earth
  // and put the vein in that. Plugged in chunks: a square of fill is the one
  // shape that never occurs in a Clonk landscape, and it shows.
  const x = sp.x;
  const y = sp.y + Fx.idiv(minDepth + maxDepth, 2);
  plugChunks(w, x, y, rng.int(1 << 20));
  veinChunks(w, x, y, material, rng.int(1 << 20));
}

function tree(w: World, rng: Rng, bx: number, by: number, size: number): void {
  const mat = w.mat;
  const trunkH = 15 + size * 6;
  const trunkW = size >= 2 ? 4 : 3;
  const crownR = 7 + size * 2;
  const lean = rng.range(-1, 1);

  for (let i = 0; i < trunkH; i++) {
    const y = by - i;
    if (y < 2) break;
    const x0 = bx + Fx.idiv(lean * i, 6);
    for (let dx = 0; dx < trunkW; dx++) {
      const x = x0 + dx;
      if (x < 1 || x >= GRID_W - 1) continue;
      const cur = mat[y * GRID_W + x];
      if (cur === MAT.SKY || cur === MAT.LEAVES) mat[y * GRID_W + x] = MAT.WOOD;
    }
  }

  const cy = by - trunkH + 2;
  const cx = bx + Fx.idiv(lean * trunkH, 6) + (trunkW >> 1);
  for (let dy = -crownR; dy <= crownR; dy++) {
    for (let dx = -crownR; dx <= crownR; dx++) {
      const d = dx * dx + Fx.idiv(dy * dy * 14, 10);
      if (d > crownR * crownR) continue;
      if (d > crownR * crownR - crownR * 4 && rng.chance(1, 3)) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 1 || x >= GRID_W - 1 || y < 2 || y >= GRID_H - 1) continue;
      if (mat[y * GRID_W + x] === MAT.SKY) mat[y * GRID_W + x] = MAT.LEAVES;
    }
  }
}

/** Scatters a forest across the level, dry parts of the island. */
function forest(w: World, rng: Rng, surface: Int32Array): void {
  const MIN_GAP = 26;
  const planted: number[] = [];
  for (let attempt = 0; attempt < 110; attempt++) {
    const x = rng.range(30, GRID_W - 30);
    const sy = surface[x];
    if (sy >= SEA_LEVEL - 10) continue;
    if (Math.abs(surface[x - 4] - sy) > 4 || Math.abs(surface[x + 4] - sy) > 4) continue;
    const m = w.mat[sy * GRID_W + x];
    if (m !== MAT.EARTH && m !== MAT.SAND) continue;
    // Not on the thin roof of an overhang.
    let solidBelow = 0;
    for (let d = 0; d < 10; d++) if (w.mat[(sy + d) * GRID_W + x] !== MAT.SKY) solidBelow++;
    if (solidBelow < 9) continue;
    let tooClose = false;
    for (let i = 0; i < planted.length; i++) {
      if (Math.abs(planted[i] - x) < MIN_GAP) tooClose = true;
    }
    if (tooClose) continue;
    planted.push(x);
    tree(w, rng, x, sy - 1, rng.range(0, 2));
  }
}

// --- spawns ----------------------------------------------------------------

/**
 * Finds dry, level ground on real rock near a target x.
 *
 * With overhangs in the world, the first solid cell in a column can be the roof
 * of an arch. A base built on one would be standing on a shell, so the ground
 * has to be solid for a good depth below as well.
 */
function findSpawn(w: World, surface: Int32Array, targetX: number): Spawn {
  for (let off = 0; off < 400; off++) {
    for (let s = 0; s < 2; s++) {
      const x = targetX + (s === 0 ? off : -off);
      if (x < 60 || x >= GRID_W - 60) continue;
      const sy = surface[x];
      if (sy >= SEA_LEVEL - 12 || sy < 20) continue;

      let flat = true;
      for (let d = -12; d <= 12; d++) {
        if (Math.abs(surface[x + d] - sy) > 7) flat = false;
      }
      if (!flat) continue;

      let solid = 0;
      for (let d = 0; d < 24; d++) if (w.mat[(sy + d) * GRID_W + x] !== MAT.SKY) solid++;
      if (solid < 22) continue;

      return { x, y: sy };
    }
  }
  return { x: targetX, y: surface[Fx.clamp(targetX, 0, GRID_W - 1)] };
}

/** Levels the ground and clears the air above a spawn so nobody starts buried. */
function prepareSpawn(w: World, surface: Int32Array, sp: Spawn): void {
  const mat = w.mat;
  for (let x = sp.x - 26; x <= sp.x + 26; x++) {
    if (x < 1 || x >= GRID_W - 1) continue;
    for (let y = sp.y - 30; y < sp.y; y++) {
      if (y < 0) continue;
      mat[y * GRID_W + x] = MAT.SKY;
    }
    for (let y = sp.y; y < sp.y + 8; y++) {
      if (mat[y * GRID_W + x] === MAT.SKY || mat[y * GRID_W + x] === MAT.WATER) {
        mat[y * GRID_W + x] = MAT.EARTH;
      }
    }
    surface[x] = sp.y;
  }
}

export function generate(w: World, teamCount: number): GenResult {
  const rng = new Rng(w.seed ^ 0x5bf03635);
  zoomMap(w, createMap(rng), rng.int(1 << 30));
  const surface = surfaceOf(w);
  forest(w, rng, surface);

  const spawns: Spawn[] = [];
  const half = GRID_W >> 1;
  const spread = teamCount > 1 ? Fx.idiv(GRID_W - 400, teamCount - 1) : 0;
  for (let t = 0; t < teamCount; t++) {
    const target = teamCount > 1 ? 200 + spread * t : half;
    const sp = findSpawn(w, surface, target);
    prepareSpawn(w, surface, sp);
    spawns.push(sp);
    // A pair of trees within sight of the base: the first foundry costs wood,
    // so the first thing to do must be visible from the spawn. Planted clear of
    // the levelled platform, which has to stay free for building on.
    tree(w, rng, sp.x - rng.range(30, 36), sp.y - 1, 2);
    tree(w, rng, sp.x + rng.range(30, 36), sp.y - 1, 1);
    // Deepest first: a vein never overwrites another, so the shallowest - the
    // one the player is meant to find first - goes last only to keep it clear
    // of the others' fallback rock.
    starterVein(w, rng, sp, 54, 74, MAT.ORE, 45);
    starterVein(w, rng, sp, 30, 46, MAT.COAL, 60);
    starterVein(w, rng, sp, 14, 22, MAT.GOLD, 45);
    starterVein(w, rng, sp, 8, 16, MAT.LOAM, 40);
  }

  return { spawns, surface };
}
