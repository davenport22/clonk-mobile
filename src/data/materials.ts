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
  LAVA: 14,
  ACID: 15,
  OIL: 16,
  ICE: 17,
  SNOW: 18,
  FIRE: 19,
} as const;

export const MAT_COUNT = 20;

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

//                         sky ea rk co or go sa wa gr el st wd lv lm la ac oi ic sn fi
export const SOLID = table([0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0]);
export const DIGGABLE = table([0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0, 1, 1, 0]);
/** Snow is packed, not powder: it holds a slope and melts rather than sliding. */
export const FALLS = table([0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
export const LIQUID = table([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0]);
/**
 * Liquid density. A denser liquid sinks through a lighter one, so oil floats
 * on a lake and acid pools under it. Lava never meets water as a density
 * question: the two react first.
 */
export const DENSITY = table([0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 4, 3, 1, 0, 0, 0]);
/**
 * Liquid sluggishness: a liquid moves on one tick in this many. Water runs,
 * oil is slower, lava crawls.
 */
export const VISCOSITY = table([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 4, 1, 2, 0, 0, 0]);
/**
 * Flammability: the chance, out of 256 per tick, that fire next to the cell
 * catches it. Zero means it never burns.
 */
export const FLAMMABLE = table([0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 14, 70, 0, 0, 0, 160, 0, 0, 0]);
/** Eaten by acid, as a chance out of 256 per tick of contact. */
export const DISSOLVES = table([0, 26, 4, 10, 6, 0, 40, 0, 0, 40, 8, 22, 60, 30, 0, 0, 0, 30, 60, 0]);
/** Melts to water next to lava or fire. */
export const MELTS = table([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0]);
/** Dig work units per cell. Higher is slower. */
export const DIG_COST = table([0, 2, 6, 3, 4, 4, 1, 0, 0, 1, 0, 3, 1, 2, 0, 0, 0, 4, 1, 0]);
/** Survives an explosion. Bedrock only, so the world always has a floor. */
export const BLAST_PROOF = table([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
/** Glows on its own. The renderer skips the darkness and blooms it. */
export const EMISSIVE = table([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Chunk kind yielded when a cell is dug out, or 255 for nothing. */
//                         sky  ea   rk   co ore gld  sa   wa   gr   el   st  wd   lv  lm  la   ac   oi   ic   sn   fi
export const YIELD = table([255, 255, 255, 0, 1, 2, 255, 255, 255, 255, 255, 4, 255, 5, 255, 255, 255, 255, 255, 255]);

/**
 * Material colours.
 *
 * For the bitmap materials this is the colour the shader modulates by the
 * texture pattern, exactly as Clonk's engine does, so it is the colour the
 * ground actually has on screen; the minimap and the dig particles read it
 * too. Tones are taken from a Clonk Rage screenshot. The earth/rock/coal
 * ladder separates by lightness, not only by hue, so it survives colourblind
 * vision (PRD 7).
 */
export const PALETTE: readonly number[][] = [
  [0x00, 0x00, 0x00], // sky is drawn by the sky branch, never sampled
  [0x8c, 0x62, 0x3a], // earth
  [0x9c, 0x96, 0x92], // rock
  [0x30, 0x2e, 0x2a], // coal
  [0x8e, 0x5c, 0x40], // ore
  [0xd8, 0xa8, 0x3a], // gold
  [0xd6, 0xc2, 0x8a], // sand
  [0x2f, 0x74, 0xbc], // water
  [0x6a, 0x66, 0x66], // granite
  [0x98, 0x6c, 0x42], // loose earth
  [0x96, 0x9a, 0xa4], // structure
  [0x74, 0x4e, 0x28], // wood
  [0x3a, 0x74, 0x2e], // leaves
  [0xa6, 0x70, 0x3c], // loam
  [0xff, 0x6a, 0x10], // lava
  [0x7c, 0xd8, 0x2c], // acid
  [0x1e, 0x18, 0x14], // oil
  [0xb8, 0xdc, 0xf0], // ice
  [0xf2, 0xf5, 0xfa], // snow
  [0xff, 0xa8, 0x30], // fire
];