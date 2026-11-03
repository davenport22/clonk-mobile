/** Material ids stored in the grid. Kept as plain consts so esbuild does not
 *  need enum support and the values are stable across the wire. */
export const MAT = {
  SKY: 0,
  EARTH: 1,
  ROCK: 2,
  COAL: 3,
  ORE: 4,
  GOLD: 5,
  SAND: 6,
  WATER: 7,
  GRANITE: 8,
  EARTH_LOOSE: 9,
  STRUCT: 10,
  WOOD: 11,
  LEAVES: 12,
  LOAM: 13,
} as const;

export const MAT_COUNT = 14;

/** Carryable chunk kinds. Index into team stock arrays. */
export const CHUNK_KIND = {
  COAL: 0,
  ORE: 1,
  GOLD: 2,
  METAL: 3,
  WOOD: 4,
  LOAM: 5,
} as const;

export const CHUNK_KIND_COUNT = 6;

export const CHUNK_NAMES = ['Coal', 'Ore', 'Gold', 'Metal', 'Wood', 'Loam'];
export const CHUNK_SHORT = ['Co', 'Or', 'Au', 'Me', 'Wd', 'Lo'];

/**
 * Valuable cells that must be removed before one carryable chunk drops, per
 * kind. Tuned against the dig brush area (about 113 cells) so that tunnelling
 * through a vein yields one or two chunks, not a stream of them. Rock yields
 * nothing: it is an obstacle, not a resource. Metal is never dug, only smelted.
 */
export const CELLS_PER_ITEM = [60, 60, 40, 0, 45, 50];

function table(values: readonly number[]): Uint8Array {
  const a = new Uint8Array(MAT_COUNT);
  for (let i = 0; i < MAT_COUNT; i++) a[i] = values[i] | 0;
  return a;
}

//                        sky ea rk co or go sa wa gr el st wd lv lm
export const SOLID = table([0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1]);
export const DIGGABLE = table([0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0, 1, 1, 1]);
export const FALLS = table([0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]);
export const LIQUID = table([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
/** Dig work units per cell. Higher is slower. */
export const DIG_COST = table([0, 2, 6, 3, 4, 4, 1, 0, 0, 1, 0, 3, 1, 2]);
/** Survives an explosion. Bedrock only, so the world always has a floor. */
export const BLAST_PROOF = table([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);

/** Chunk kind yielded when a cell is dug out, or 255 for nothing. */
//                         sky  ea   rk   co ore gld  sa   wa   gr   el   st  wd   lv  lm
export const YIELD = table([255, 255, 255, 0, 1, 2, 255, 255, 255, 255, 255, 4, 255, 5]);

/**
 * Base colours. The renderer builds a real texture on top of these per material
 * (speckled earth, faceted rock, gold nuggets in rock, wood grain), so these are
 * the average tone rather than the whole story. Chosen to stay distinguishable
 * for colourblind players: the earth/rock/coal ladder separates by lightness,
 * not only by hue (PRD 7).
 */
export const PALETTE: readonly number[][] = [
  [0x00, 0x00, 0x00], // sky is drawn by the sky branch, never sampled
  [0x8c, 0x5c, 0x2e], // earth
  [0x60, 0x5c, 0x60], // rock
  [0x22, 0x21, 0x26], // coal
  [0x6d, 0x5c, 0x50], // ore
  [0x66, 0x60, 0x54], // gold-bearing rock
  [0xd2, 0xba, 0x7e], // sand
  [0x2a, 0x69, 0xa8], // water
  [0x3d, 0x3b, 0x44], // granite
  [0x9a, 0x67, 0x33], // loose earth
  [0x8f, 0x93, 0x9c], // structure
  [0x6b, 0x47, 0x24], // wood
  [0x35, 0x6b, 0x2c], // leaves
  [0xa8, 0x76, 0x3e], // loam
];
