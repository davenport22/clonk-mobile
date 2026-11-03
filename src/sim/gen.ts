import * as Fx from '../fx/fx';
import { BEDROCK_ROWS, GRID_H, GRID_W, LAND_LEVEL, SEA_LEVEL } from '../data/config';
import { MAT, SOLID } from '../data/materials';

/** Materials a vein must not overwrite. */
const VALUABLE = new Uint8Array(16);
VALUABLE[MAT.COAL] = 1;
VALUABLE[MAT.ORE] = 1;
VALUABLE[MAT.GOLD] = 1;
VALUABLE[MAT.LOAM] = 1;
import { Rng, hash2 } from './rng';
import type { World } from './world';

export interface Spawn {
  x: number;
  y: number;
}

export interface GenResult {
  spawns: Spawn[];
  surface: Int32Array;
}

// --- noise -----------------------------------------------------------------

function grad1(i: number, seed: number, amp: number): number {
  return (hash2(i, 0, seed) % (amp * 2 + 1)) - amp;
}

/** One octave of integer value noise along x, in cells. */
function octave(x: number, wl: number, amp: number, seed: number): number {
  const i = Fx.idiv(x, wl);
  const t = Fx.ratio(x - i * wl, wl);
  const a = grad1(i, seed, amp);
  const b = grad1(i + 1, seed, amp);
  return Fx.floor(Fx.lerp(Fx.of(a), Fx.of(b), Fx.smooth(t)));
}

function grad2(x: number, y: number, seed: number): number {
  return (hash2(x, y, seed) % 2049) - 1024;
}

/** 2D integer value noise, returning roughly -1024..1024. */
function noise2(x: number, y: number, wl: number, seed: number): number {
  const xi = Fx.idiv(x, wl);
  const yi = Fx.idiv(y, wl);
  const tx = Fx.smooth(Fx.ratio(x - xi * wl, wl));
  const ty = Fx.smooth(Fx.ratio(y - yi * wl, wl));
  const top = Fx.lerp(Fx.of(grad2(xi, yi, seed)), Fx.of(grad2(xi + 1, yi, seed)), tx);
  const bot = Fx.lerp(Fx.of(grad2(xi, yi + 1, seed)), Fx.of(grad2(xi + 1, yi + 1, seed)), tx);
  return Fx.floor(Fx.lerp(top, bot, ty));
}

// --- landscape -------------------------------------------------------------

/**
 * Average ground height per column. This is not the terrain itself - it only
 * says where to look for it.
 */
function baseHeights(seed: number): Int32Array {
  const h = new Int32Array(GRID_W);
  const base = LAND_LEVEL;
  for (let x = 0; x < GRID_W; x++) {
    let y = base;
    y += octave(x, 300, 30, seed ^ 0x11);
    y += octave(x, 150, 16, seed ^ 0x22);
    y += octave(x, 70, 8, seed ^ 0x33);
    y += envelope(x);
    h[x] = Fx.clamp(y, 40, GRID_H - BEDROCK_ROWS - 40);
  }
  return h;
}

/** Pushes the ground below sea level towards the map edges, making an island. */
function envelope(x: number): number {
  const half = GRID_W >> 1;
  const d = Math.abs(x - half);
  const start = Fx.idiv(half * 11, 20);
  if (d <= start) return 0;
  const t = Fx.ratio(d - start, half - start);
  // Far enough to carry the island's edge below the waterline, so it ends in
  // sea rather than at the frame.
  return Fx.floor(Fx.mul(Fx.smooth(t), Fx.of(215)));
}

/** Vertical extent of the band in which terrain is decided by 2D noise. */
const RELIEF = 92;
/** How strongly depth pulls towards solid. Lower means steeper, more vertical
 *  faces and more overhangs; too low and the island dissolves into arches. */
const DEPTH_BIAS = 27;

/**
 * Resolution at which the noise fields are evaluated, in cells.
 *
 * Every landscape feature is many cells across, so evaluating the noise at
 * every cell is nine times the work for detail nobody can see. The fields are
 * built on this lattice and interpolated, which is what brings generation back
 * inside the 500 ms budget of PRD M7.
 */
const STEP = 3;
const FW = Fx.idiv(GRID_W, STEP) + 2;
const FH = Fx.idiv(GRID_H, STEP) + 2;

interface Fields {
  solid: Int32Array;
  /** Positive means carved away. All the cave systems folded into one field, so
   *  the carving loop needs one sample per cell instead of four. */
  hollow: Int32Array;
  /** Drives the wandering earth-to-rock boundary and the granite intrusions. */
  grain: Int32Array;
}

/**
 * Builds the noise fields the landscape is carved from.
 *
 * `solid` is a two-dimensional field rather than a height per column, and that
 * is the whole point: a heightmap cannot produce an overhang, an arch or a
 * vertical cliff face, because by construction every column has exactly one
 * surface. Clonk's landscapes are full of all three.
 *
 * `hollow` is the cave system. The zero set of a noise field is a curve, so
 * thresholding on the absolute value carves connected tunnels rather than
 * disconnected bubbles; scaling x harder than y turns the same trick vertical,
 * which is where the chasms that drop out of a Clonk hillside come from.
 */
function buildFields(seed: number): Fields {
  const n = FW * FH;
  const solid = new Int32Array(n);
  const hollow = new Int32Array(n);
  const grain = new Int32Array(n);

  // Sideways shear that varies with depth: this turns slopes into cliffs.
  const shear = new Int32Array(FH);
  for (let gy = 0; gy < FH; gy++) shear[gy] = noise2(0, gy * STEP, 90, seed ^ 0x9a) >> 3;

  for (let gy = 0; gy < FH; gy++) {
    const y = gy * STEP;
    const sh = shear[gy];
    const row = gy * FW;
    for (let gx = 0; gx < FW; gx++) {
      const x = gx * STEP;
      const sx = x + sh;
      let d = noise2(sx, y, 104, seed ^ 0x41);
      d += noise2(sx, y, 44, seed ^ 0x52) >> 1;
      d += noise2(sx, y, 18, seed ^ 0x63) >> 2;
      solid[row + gx] = d;

      const t1 = noise2(x, y * 2, 58, seed ^ 0xc1);
      const t2 = noise2(x, y * 2, 27, seed ^ 0xc2);
      const cav = noise2(x, y, 82, seed ^ 0xc3);
      const ch = noise2(x * 5, y, 150, seed ^ 0xc4);
      // Kept sparse on purpose. Thresholds much wider than this and the rock
      // turns into a honeycomb: Clonk's underground is mostly solid, with
      // caverns and shafts as events rather than as the default state.
      let h = 62 - Math.abs(t1);
      const h2 = 26 - Math.abs(t2);
      if (h2 > h) h = h2;
      const h3 = cav - 730;
      if (h3 > h) h = h3;
      const h4 = 34 - Math.abs(ch);
      if (h4 > h) h = h4;
      hollow[row + gx] = h;

      grain[row + gx] = cav;
    }
  }
  return { solid, hollow, grain };
}

/**
 * Carves the landscape, column by column.
 *
 * The fields are sampled without a single division in the inner loop: the x
 * weight is constant for a column, and stepping down y advances the lattice
 * index by hand. That is the difference between generation taking two seconds
 * and taking a fifth of one.
 */
function carveLandscape(w: World, base: Int32Array, f: Fields): void {
  const mat = w.mat;
  const bedrock = GRID_H - BEDROCK_ROWS;
  const TY: number[] = [];
  for (let k = 0; k < STEP; k++) TY.push(Fx.ratio(k, STEP));

  for (let x = 0; x < GRID_W; x++) {
    const b = base[x];
    const top = Math.max(1, b - RELIEF);
    const bottom = Math.min(bedrock, b + RELIEF);
    const gx = Fx.idiv(x, STEP);
    const tx = Fx.ratio(x - gx * STEP, STEP);

    for (let y = 0; y < top; y++) mat[y * GRID_W + x] = MAT.SKY;

    let gy = Fx.idiv(top, STEP);
    let sub = top - gy * STEP;
    for (let y = top; y < bedrock; y++) {
      const i = gy * FW + gx;
      const ty = TY[sub];

      let solid = true;
      if (y < bottom) {
        const a = Fx.lerp(Fx.of(f.solid[i]), Fx.of(f.solid[i + 1]), tx);
        const c = Fx.lerp(Fx.of(f.solid[i + FW]), Fx.of(f.solid[i + FW + 1]), tx);
        solid = Fx.floor(Fx.lerp(a, c, ty)) + (y - b) * DEPTH_BIAS > 0;
      }
      // Only ask about caves where there is something to carve, and leave the
      // top of the crust alone so the island keeps a surface.
      if (solid && y - b >= 12) {
        const a = Fx.lerp(Fx.of(f.hollow[i]), Fx.of(f.hollow[i + 1]), tx);
        const c = Fx.lerp(Fx.of(f.hollow[i + FW]), Fx.of(f.hollow[i + FW + 1]), tx);
        if (Fx.floor(Fx.lerp(a, c, ty)) > 0) solid = false;
      }
      mat[y * GRID_W + x] = solid ? MAT.EARTH : MAT.SKY;

      sub++;
      if (sub === STEP) {
        sub = 0;
        gy++;
      }
    }
    for (let y = bedrock; y < GRID_H; y++) mat[y * GRID_W + x] = MAT.GRANITE;
  }
}

/** First solid cell per column, which is what the renderer shades against. */
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
 * Turns the single solid material into layers.
 *
 * The earth-to-rock boundary is driven by 2D noise rather than by a depth per
 * column, so it wanders, interlocks and occasionally leaves a lens of earth
 * deep in the rock - which is what stops the island from looking like a layer
 * cake.
 */
function layerMaterials(w: World, surface: Int32Array, f: Fields): void {
  const mat = w.mat;
  const bedrock = GRID_H - BEDROCK_ROWS;
  const TY: number[] = [];
  for (let k = 0; k < STEP; k++) TY.push(Fx.ratio(k, STEP));

  for (let x = 0; x < GRID_W; x++) {
    const sy = surface[x];
    if (sy >= bedrock) continue;
    const beach = Math.abs(sy - SEA_LEVEL) < 12;
    const gx = Fx.idiv(x, STEP);
    const tx = Fx.ratio(x - gx * STEP, STEP);
    let gy = Fx.idiv(sy, STEP);
    let sub = sy - gy * STEP;

    // The boundary wobbles on a wavelength of many cells, so re-sampling it
    // every fourth row is indistinguishable from every row and a quarter of the
    // work.
    let g = 0;
    for (let y = sy; y < bedrock; y++) {
      const idx = y * GRID_W + x;
      if ((y & 3) === 0) {
        const i = gy * FW + gx;
        const ty = TY[sub];
        const a = Fx.lerp(Fx.of(f.grain[i]), Fx.of(f.grain[i + 1]), tx);
        const c = Fx.lerp(Fx.of(f.grain[i + FW]), Fx.of(f.grain[i + FW + 1]), tx);
        g = Fx.floor(Fx.lerp(a, c, ty));
      }
      if (mat[idx] !== MAT.SKY) {
        const depth = y - sy;
        if (depth < 4 && beach) {
          mat[idx] = MAT.SAND;
        } else if (depth < 24 + (g >> 5)) {
          mat[idx] = MAT.EARTH;
        } else {
          mat[idx] = depth > 110 && g > 620 ? MAT.GRANITE : MAT.ROCK;
        }
      }
      sub++;
      if (sub === STEP) {
        sub = 0;
        gy++;
      }
    }
  }
}

// --- decoration ------------------------------------------------------------

/**
 * Random-walking blob of a single material, only replacing solid ground.
 * Returns how many cells it actually placed, which matters for the starter
 * veins: a blob that lands in a cave places almost nothing.
 */
function blob(w: World, rng: Rng, cx: number, cy: number, radius: number, steps: number, m: number): number {
  const mat = w.mat;
  let placed = 0;
  let x = cx;
  let y = cy;
  for (let s = 0; s < steps; s++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radius * radius) continue;
        const px = x + dx;
        const py = y + dy;
        if (px < 1 || px >= GRID_W - 1 || py < 1 || py >= GRID_H - BEDROCK_ROWS) continue;
        const cur = mat[py * GRID_W + px];
        if (SOLID[cur] !== 1 || cur === MAT.GRANITE || cur === MAT.STRUCT) continue;
        // Never eat another vein. Without this the order veins are placed in
        // silently decides which ones survive, and a starter vein can be
        // swallowed whole by the one placed after it.
        if (cur !== m && VALUABLE[cur] === 1) continue;
        mat[py * GRID_W + px] = m;
        placed++;
      }
    }
    x += rng.range(-2, 2);
    y += rng.range(-1, 1);
  }
  return placed;
}

/**
 * Places a starter vein below a spawn and keeps trying nearby spots until
 * enough of it actually landed.
 *
 * PRD 5.4 promises the first dig pays off within ten seconds. A single blind
 * attempt does not deliver that: drop it into a cave or a water pocket and the
 * player digs down to nothing on their first go, which is the worst possible
 * first impression.
 */
function starterVein(
  w: World,
  rng: Rng,
  sp: Spawn,
  minDepth: number,
  maxDepth: number,
  radius: number,
  material: number,
  wanted: number,
): void {
  for (let attempt = 0; attempt < 10; attempt++) {
    const x = sp.x + rng.range(-6, 6);
    const y = sp.y + rng.range(minDepth, maxDepth);
    if (blob(w, rng, x, y, radius, 1, material) >= wanted) return;
  }
  // Nowhere solid within reach - the ground under this spawn is mostly cave.
  // The promise is a design guarantee, not a hope, so fill a pocket of rock and
  // put the vein in that.
  const x = sp.x;
  const y = sp.y + Fx.idiv(minDepth + maxDepth, 2);
  const fill = radius + 3;
  for (let dy = -fill; dy <= fill; dy++) {
    for (let dx = -fill; dx <= fill; dx++) {
      if (dx * dx + dy * dy > fill * fill) continue;
      const px = x + dx;
      const py = y + dy;
      if (px < 1 || px >= GRID_W - 1 || py < 1 || py >= GRID_H - BEDROCK_ROWS) continue;
      if (w.mat[py * GRID_W + px] === MAT.SKY) w.mat[py * GRID_W + px] = MAT.ROCK;
    }
  }
  blob(w, rng, x, y, radius, 1, material);
}

function veins(w: World, rng: Rng, surface: Int32Array): void {
  const place = (count: number, minDepth: number, maxDepth: number, rMin: number, rMax: number, m: number) => {
    for (let i = 0; i < count; i++) {
      const x = rng.range(40, GRID_W - 40);
      const sy = surface[x];
      const y = sy + rng.range(minDepth, maxDepth);
      if (y >= GRID_H - BEDROCK_ROWS - 4) continue;
      blob(w, rng, x, y, rng.range(rMin, rMax), rng.range(2, 5), m);
    }
  };
  // Loam sits shallow and is common: it is a consumable you are meant to spend
  // freely on bridges rather than hoard.
  place(46, 6, 70, 5, 8, MAT.LOAM);
  place(52, 8, 90, 4, 7, MAT.COAL);
  place(40, 30, 150, 4, 6, MAT.ORE);
  place(24, 70, 220, 3, 5, MAT.GOLD);
  // Underground water, so a tunnel can be flooded (PRD 5.3).
  place(18, 40, 190, 5, 9, MAT.WATER);
}

/**
 * Fills open-air space below sea level with water. Flood fill from the top row
 * so enclosed caverns stay dry, which is what makes digging into the sea a
 * mistake you can make.
 */
function flood(w: World): void {
  const mat = w.mat;
  const open = new Uint8Array(GRID_W * GRID_H);
  const stack = new Int32Array(GRID_W * GRID_H);
  let top = 0;
  for (let x = 0; x < GRID_W; x++) {
    if (mat[x] === MAT.SKY) {
      open[x] = 1;
      stack[top++] = x;
    }
  }
  // Neighbour tests are written out rather than going through a helper: this
  // loop runs a couple of million times and a closure allocated per iteration
  // was costing more than the fill itself.
  const last = GRID_W * GRID_H;
  while (top > 0) {
    const i = stack[--top];
    const x = i % GRID_W;
    if (x > 0) {
      const ni = i - 1;
      if (open[ni] === 0 && mat[ni] === MAT.SKY) {
        open[ni] = 1;
        stack[top++] = ni;
      }
    }
    if (x < GRID_W - 1) {
      const ni = i + 1;
      if (open[ni] === 0 && mat[ni] === MAT.SKY) {
        open[ni] = 1;
        stack[top++] = ni;
      }
    }
    if (i >= GRID_W) {
      const ni = i - GRID_W;
      if (open[ni] === 0 && mat[ni] === MAT.SKY) {
        open[ni] = 1;
        stack[top++] = ni;
      }
    }
    if (i + GRID_W < last) {
      const ni = i + GRID_W;
      if (open[ni] === 0 && mat[ni] === MAT.SKY) {
        open[ni] = 1;
        stack[top++] = ni;
      }
    }
  }
  for (let y = SEA_LEVEL; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const i = y * GRID_W + x;
      if (open[i] === 1 && mat[i] === MAT.SKY) mat[i] = MAT.WATER;
    }
  }
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
  const base = baseHeights(w.seed);
  const fields = buildFields(w.seed);
  carveLandscape(w, base, fields);
  let surface = surfaceOf(w);
  layerMaterials(w, surface, fields);
  veins(w, rng, surface);
  flood(w);
  surface = surfaceOf(w);
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
    // Deepest first: each blob overwrites whatever it lands on, and the
    // shallowest vein is the one the player is meant to find first, so gold has
    // to be placed last or the coal above it swallows it whole.
    starterVein(w, rng, sp, 54, 74, 5, MAT.ORE, 45);
    starterVein(w, rng, sp, 30, 46, 6, MAT.COAL, 60);
    starterVein(w, rng, sp, 14, 22, 5, MAT.GOLD, 45);
    starterVein(w, rng, sp, 8, 16, 5, MAT.LOAM, 40);
  }

  return { spawns, surface };
}
