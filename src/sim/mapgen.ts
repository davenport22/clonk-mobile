import * as Fx from '../fx/fx';
import { BEDROCK_ROWS, GRID_H, GRID_W, LAND_LEVEL, SEA_LEVEL } from '../data/config';
import { MAT, SOLID } from '../data/materials';
import type { Rng } from './rng';
import type { World } from './world';

/**
 * Clonk's classic landscape generator.
 *
 * Reimplemented from the Clonk Rage engine source (C4Map.cpp and the zoom in
 * C4Landscape.cpp; Copyright (c) 2001-2014 RedWolf Design GmbH, ISC licence),
 * in integer arithmetic so it can run inside the lockstep simulation.
 *
 * Clonk never generates its landscape directly. It builds a small map first -
 * here 128 by 64 cells - and then zooms every cell up into an irregular
 * polygon whose corners are jittered by a hash of the cell's position. The
 * polygons overlap their neighbours, so material boundaries come out lumpy,
 * hanging and organic instead of square, and that zoom is most of what makes a
 * Clonk landscape look like one. The map stage is deliberately simple: a
 * surface line, earth beneath it, water up to a level, and every other
 * material - rock, ore, gold, tunnels - drawn in as short horizontal random
 * walks called layers.
 *
 * Three deviations, each for the game rather than the look: the map's ends
 * drop below the waterline so the world is an island; layers have a minimum
 * depth so gold is something you dig for; and tunnels zoom last so a clonk
 * still fits through them after the earth around them has bulged in.
 */

export const MAP_ZOOM = 8;
export const MAP_W = GRID_W >> 3;
export const MAP_H = GRID_H >> 3;

/** A pre-dug tunnel. Not a landscape material: it zooms to open air. */
const MAP_TUNNEL = 254;
/** Water enclosed in the ground, zoomed after the earth so it survives. */
const MAP_POCKET = 253;

/** How a material's cells are drawn when zoomed (C4M_Flat ... C4M_Rough). */
const FLAT = 0;
const TOP_FLAT = 1;
const SMOOTH = 2;
const ROUGH = 3;

interface Layer {
  m: number;
  /** Scenario count; the number of walks is count * map area / 15000, as in Clonk. */
  count: number;
  /** Minimum depth below the surface, in map cells. Clonk's own value is five. */
  depth: number;
}

const LAYERS: Layer[] = [
  { m: MAT.ROCK, count: 44, depth: 5 },
  { m: MAT.GRANITE, count: 14, depth: 9 },
  { m: MAT.COAL, count: 18, depth: 5 },
  { m: MAT.ORE, count: 16, depth: 7 },
  { m: MAT.GOLD, count: 9, depth: 10 },
  { m: MAT.LOAM, count: 16, depth: 3 },
  { m: MAT.SAND, count: 8, depth: 3 },
  { m: MAP_POCKET, count: 8, depth: 8 },
  // Last, so they wind through the earth that is left rather than through ore.
  { m: MAP_TUNNEL, count: 40, depth: 4 },
];

/** Zoom order: later materials are drawn over earlier ones. */
const ZOOM: Array<[number, number]> = [
  [MAT.WATER, FLAT],
  [MAT.EARTH, SMOOTH],
  [MAT.SAND, SMOOTH],
  [MAT.LOAM, SMOOTH],
  [MAT.ROCK, ROUGH],
  [MAT.GRANITE, ROUGH],
  [MAT.COAL, ROUGH],
  [MAT.ORE, ROUGH],
  [MAT.GOLD, ROUGH],
  [MAP_POCKET, SMOOTH],
  [MAP_TUNNEL, SMOOTH],
];

// --- integer sine ------------------------------------------------------------

/**
 * Sine of an angle given in turns (Q16), result in Q16.
 *
 * Bhaskara's approximation, which needs nothing but integer arithmetic and is
 * within two thousandths of the real thing - far below anything a surface
 * line drawn on a 64-row map can show.
 */
function sinTurn(turns: number): number {
  let u = turns & 0xffff;
  let neg = false;
  if (u >= Fx.HALF) {
    u -= Fx.HALF;
    neg = true;
  }
  // p = u (1 - 2u), in Q16 with u in turns.
  const p = (u * (Fx.ONE - 2 * u)) >> 16;
  const s = Fx.idiv(32 * p * Fx.ONE, 5 * Fx.ONE - 8 * p);
  return neg ? -s : s;
}

// --- the map -----------------------------------------------------------------

function at(map: Uint8Array, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return MAT.SKY;
  return map[y * MAP_W + x];
}

/**
 * How far into the island's sloping end a column is: 0 inland, ONE at the
 * frame. The surface is pulled towards the sea floor by this much, rather than
 * pushed down by a fixed amount, because Clonk's random drift can lift an end
 * high enough that any fixed drop leaves it standing above the water - and
 * then the land runs into the edge of the world instead of into the sea.
 */
function edgeT(cx: number): number {
  const half = MAP_W >> 1;
  const d = Math.abs(cx - half);
  const start = Fx.idiv(half * 11, 20);
  if (d <= start) return 0;
  return Fx.smooth(Fx.ratio(d - start, half - start));
}

/**
 * The surface: a sine curve plus a random walk with momentum, exactly the
 * shape Clonk's classic creator draws. The walk is kept in units of 1e-5 so
 * the integer version tracks the floating-point original step for step.
 */
function surface(map: Uint8Array, rng: Rng): void {
  const amplitude = 16 + rng.int(10);
  const period = 10 + rng.int(9);
  const phase = rng.int(100);
  const natural = 34 + rng.int(16);
  const level0 = LAND_LEVEL >> 3;
  const maxrange = Fx.idiv(level0 * 3, 4);
  const seaRow = SEA_LEVEL >> 3;
  const seaFloor = seaRow + 4;

  let rndCy = (rng.int(2001) - 1000) * 100;
  let rndTend = (rng.int(201) - 100) * 5;

  for (let cx = 0; cx < MAP_W; cx++) {
    rndCy += rndTend;
    rndTend += (rng.int(101) - 50) * 10;
    if (rndTend > 5000) rndTend = 5000;
    if (rndTend < -5000) rndTend = -5000;
    if (rndCy < -50000) rndTend += 1000;
    if (rndCy > 50000) rndTend -= 1000;

    const cyNatural = Fx.idiv(rndCy * natural, 100);
    const turns = Fx.idiv(period * cx * Fx.ONE, 10 * MAP_W) + Fx.idiv(phase * Fx.ONE, 100);
    const cyCurve = Fx.idiv(sinTurn(turns) * amplitude * 1000, Fx.ONE);
    const off = Fx.clamp(Fx.idiv(maxrange * (cyCurve + cyNatural), 100000), -maxrange, maxrange);
    let cy = level0 + off;
    if (cy < seaFloor) cy += Fx.floor(Fx.mul(edgeT(cx), Fx.of(seaFloor - cy)));
    cy = Fx.clamp(cy, 1, MAP_H - 2);

    for (let y = cy; y < MAP_H; y++) map[y * MAP_W + cx] = MAT.EARTH;
  }

  // Water up to the sea's level, wherever there is sky below it.
  for (let y = seaRow; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (map[y * MAP_W + x] === MAT.SKY) map[y * MAP_W + x] = MAT.WATER;
    }
  }

  // Bedrock, so nothing ever falls out of the bottom of the world.
  for (let x = 0; x < MAP_W; x++) map[(MAP_H - 1) * MAP_W + x] = MAT.GRANITE;
}

/** A layer only ever replaces the base material, never another layer. */
function layerPix(map: Uint8Array, x: number, y: number, m: number): void {
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H - 1) return;
  if (map[y * MAP_W + x] !== MAT.EARTH) return;
  if (m === MAP_TUNNEL) {
    // A tunnel that grazes water floods the moment the round starts.
    for (let d = -1; d <= 1; d++) {
      for (let e = -1; e <= 1; e++) {
        const n = at(map, x + e, y + d);
        if (n === MAT.WATER || n === MAP_POCKET) return;
      }
    }
  }
  map[y * MAP_W + x] = m;
}

/** One layer: Clonk's short random walk, two rows thick and a few cells wide. */
function drawLayer(map: Uint8Array, rng: Rng, x: number, y: number, size: number, m: number): void {
  for (let i = 0; i < size; i++) {
    x += rng.int(9) - 4;
    y += rng.int(3) - 1;
    for (let c = rng.int(3); c < 5; c++) {
      layerPix(map, x + c, y, m);
      layerPix(map, x + c + 1, y + 1, m);
    }
  }
}

function layers(map: Uint8Array, rng: Rng): void {
  for (const L of LAYERS) {
    const n = Fx.idiv(L.count * MAP_W * MAP_H, 15000);
    for (let i = 0; i < n; i++) {
      const x = rng.int(MAP_W);
      let y = 0;
      while (y < MAP_H && map[y * MAP_W + x] !== MAT.EARTH) y++;
      const room = MAP_H - y - L.depth - 5;
      if (room <= 0) continue;
      drawLayer(map, rng, x, y + L.depth + rng.int(room), rng.int(15), L.m);
    }
  }
}

export function createMap(rng: Rng): Uint8Array {
  const map = new Uint8Array(MAP_W * MAP_H);
  surface(map, rng);
  layers(map, rng);
  return map;
}

// --- the zoom ----------------------------------------------------------------

/** What a polygon does to the pixels it covers. */
const PAINT = 0;
const CARVE = 1;
const VEIN = 2;
/** Only into open air: filling a hole without touching what borders it. */
const FILL = 3;

/** Materials a vein must not overwrite. */
const VALUABLE = new Uint8Array(16);
VALUABLE[MAT.COAL] = 1;
VALUABLE[MAT.ORE] = 1;
VALUABLE[MAT.GOLD] = 1;
VALUABLE[MAT.LOAM] = 1;

const vx = new Int32Array(8);
const vy = new Int32Array(8);
const cross = new Int32Array(8);

/**
 * Scanline fill of a polygon, sampled at pixel centres. Returns how many
 * pixels actually changed, which the starter veins use to know whether they
 * landed in solid ground.
 */
function fillPolygon(mat: Uint8Array, n: number, m: number, mode: number): number {
  let y0 = vy[0];
  let y1 = vy[0];
  for (let i = 1; i < n; i++) {
    if (vy[i] < y0) y0 = vy[i];
    if (vy[i] > y1) y1 = vy[i];
  }
  if (y0 < 0) y0 = 0;
  if (y1 > GRID_H - 1) y1 = GRID_H - 1;
  let changed = 0;

  for (let y = y0; y <= y1; y++) {
    const sy = 2 * y + 1;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const j = i === n - 1 ? 0 : i + 1;
      const ay = 2 * vy[i];
      const by = 2 * vy[j];
      if ((ay <= sy && sy < by) || (by <= sy && sy < ay)) {
        cross[k++] = vx[i] + Fx.idiv((sy - ay) * (vx[j] - vx[i]), by - ay);
      }
    }
    // Insertion sort: never more than eight crossings.
    for (let a = 1; a < k; a++) {
      const v = cross[a];
      let b = a - 1;
      while (b >= 0 && cross[b] > v) {
        cross[b + 1] = cross[b];
        b--;
      }
      cross[b + 1] = v;
    }
    const row = y * GRID_W;
    for (let a = 0; a + 1 < k; a += 2) {
      let xa = cross[a];
      let xb = cross[a + 1];
      if (xa < 0) xa = 0;
      if (xb > GRID_W) xb = GRID_W;
      for (let x = xa; x < xb; x++) {
        const cur = mat[row + x];
        if (mode === CARVE) {
          if (cur === MAT.WATER || cur === MAT.GRANITE || cur === MAT.SKY) continue;
          mat[row + x] = MAT.SKY;
        } else if (mode === FILL) {
          if (cur !== MAT.SKY) continue;
          mat[row + x] = m;
        } else if (mode === VEIN) {
          if (SOLID[cur] !== 1 || cur === MAT.GRANITE || cur === MAT.STRUCT) continue;
          if (cur === m || VALUABLE[cur] === 1) continue;
          mat[row + x] = m;
        } else {
          if (cur === m) continue;
          mat[row + x] = m;
        }
        changed++;
      }
    }
  }
  return changed;
}

/**
 * Clonk's chunk jitter: a counter stepped by three per draw, XORed with the
 * map seed. The counter starts from the cell's position, so the same cell
 * always gets the same shape and neighbouring shapes are related, which is
 * why the edges read as one ragged line rather than as noise.
 */
let cro = 0;
let mapSeed = 0;
function chunky(range: number): number {
  if (range === 0) return 0;
  cro += 3;
  return (cro ^ mapSeed) % range;
}

/** One cell zoomed into an eight-cornered chunk. */
function drawChunk(mat: Uint8Array, tx: number, ty: number, size: number, m: number, type: number, seed: number, mode: number): number {
  if (type === FLAT) {
    vx[0] = tx; vy[0] = ty;
    vx[1] = tx; vy[1] = ty + size;
    vx[2] = tx + size; vy[2] = ty + size;
    vx[3] = tx + size; vy[3] = ty;
    return fillPolygon(mat, 4, m, mode);
  }
  const top = type === TOP_FLAT ? 0 : 1;
  const side = type === ROUGH ? 2 : 1;
  const rx = size >> 1 < 1 ? 1 : size >> 1;
  const half = size >> 1;
  cro = seed;

  // Corner by corner, clockwise from the top left. The order of the calls is
  // part of the shape: each one advances the jitter counter.
  vx[0] = tx - chunky(rx >> 1);
  vy[0] = ty - chunky((rx >> 1) * top);
  vx[1] = tx - chunky(rx * side);
  vy[1] = ty + half;
  vx[2] = tx - chunky(rx);
  vy[2] = ty + size + chunky(rx);
  vx[3] = tx + half;
  vy[3] = ty + size + chunky(2 * rx);
  vx[4] = tx + size + chunky(rx);
  vy[4] = ty + size + chunky(rx);
  vx[5] = tx + size + chunky(rx * side);
  vy[5] = ty + half;
  vx[6] = tx + size + chunky(rx >> 1);
  vy[6] = ty - chunky((rx >> 1) * top);
  vx[7] = tx + half;
  vy[7] = ty - chunky(rx * top);
  return fillPolygon(mat, 8, m, mode);
}

/**
 * The slope smoother: a wedge in a cell that sits on a step of the material,
 * so a staircase of square cells zooms to a slope.
 */
function drawSmoother(mat: Uint8Array, tx: number, ty: number, size: number, m: number, flip: boolean, seed: number, mode: number): void {
  const rx = size >> 1 < 1 ? 1 : size >> 1;
  cro = seed;
  vx[0] = tx; vy[0] = ty - chunky(rx >> 1);
  vx[1] = tx; vy[1] = ty + size;
  vx[2] = tx + size; vy[2] = ty + size;
  vx[3] = tx + size; vy[3] = ty - chunky(rx >> 1);
  if (flip) {
    vx[0] = tx + (size >> 1);
    vy[0] = ty + Fx.idiv(size, 3);
  } else {
    vx[3] = tx + (size >> 1);
    vy[3] = ty + Fx.idiv(size, 3);
  }
  fillPolygon(mat, 4, m, mode);
}

/** Zooms the map into the world's landscape. */
export function zoomMap(w: World, map: Uint8Array, seed: number): void {
  const mat = w.mat;
  mat.fill(MAT.SKY);
  mapSeed = seed & 0x3fffffff;

  for (const [key, type] of ZOOM) {
    const target = key === MAP_POCKET ? MAT.WATER : key === MAP_TUNNEL ? MAT.SKY : key;
    const mode = key === MAP_TUNNEL ? CARVE : PAINT;
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const here = map[y * MAP_W + x];
        const seedXY = (x << 2) + y;
        if (here === key) {
          drawChunk(mat, x * MAP_ZOOM, y * MAP_ZOOM, MAP_ZOOM, target, type, seedXY, mode);
        } else if (type === SMOOTH && at(map, x, y + 1) === key) {
          if (at(map, x - 1, y) === key) drawSmoother(mat, x * MAP_ZOOM, y * MAP_ZOOM, MAP_ZOOM, target, false, seedXY, mode);
          if (at(map, x + 1, y) === key) drawSmoother(mat, x * MAP_ZOOM, y * MAP_ZOOM, MAP_ZOOM, target, true, seedXY, mode);
        }
      }
    }
  }

  // The floor, whatever the chunks did near it.
  for (let y = GRID_H - BEDROCK_ROWS; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) mat[y * GRID_W + x] = MAT.GRANITE;
  }
}

/**
 * Plugs open space around a point with earth, in zoom chunks, so a hole that
 * has to be filled ends up looking like ground rather than like a patch.
 */
export function plugChunks(w: World, cx: number, cy: number, seed: number): void {
  let k = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const tx = cx + dx * MAP_ZOOM - (MAP_ZOOM >> 1);
      const ty = cy + dy * MAP_ZOOM - (MAP_ZOOM >> 1);
      drawChunk(w.mat, tx, ty, MAP_ZOOM, MAT.EARTH, SMOOTH, seed + k * 5, FILL);
      k++;
    }
  }
}

/**
 * A few cells of a material drawn as chunks straight into the landscape, for
 * the veins every spawn is promised. Returns the pixels that landed in solid
 * ground.
 */
export function veinChunks(w: World, cx: number, cy: number, m: number, seed: number): number {
  let placed = 0;
  placed += drawChunk(w.mat, cx - MAP_ZOOM, cy - (MAP_ZOOM >> 1), MAP_ZOOM, m, ROUGH, seed, VEIN);
  placed += drawChunk(w.mat, cx, cy - (MAP_ZOOM >> 1), MAP_ZOOM, m, ROUGH, seed + 7, VEIN);
  return placed;
}
