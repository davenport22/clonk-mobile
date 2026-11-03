/** Tunables shared by simulation, renderer and net layer. Integers only. */

export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;

/** PRD Q3: grid size is a spike question, so it lives in exactly one place. */
export const GRID_W = 1024;
export const GRID_H = 512;

export const CHUNK = 16;
export const CHUNKS_X = GRID_W / CHUNK;
export const CHUNKS_Y = GRID_H / CHUNK;
export const CHUNK_COUNT = CHUNKS_X * CHUNKS_Y;

/** Max chunks of material simulation processed per tick (PRD 6.5 budget). */
export const CHUNK_BUDGET = 256;

export const MAX_PLAYERS = 8;
export const MAX_TEAMS = 4;
export const MAX_ENTITIES = 512;

/** 15 minutes at 30 Hz (PRD principle 3). */
export const ROUND_TICKS = 27000;
export const GOLD_TO_WIN = 10;
export const GOLD_TO_WIN_SOLO = 5;

/**
 * Height of the island's ground, and of the sea, in cells from the top.
 *
 * The gap between them is the dry interior you can tunnel through. It has to be
 * generous: the cave network is well connected, so anything below the waterline
 * that touches the sea floods, and with the two levels close together the whole
 * underground turns into one lake. Below the sea line a connected tunnel does
 * flood - which is the point, and the reason digging down carelessly is a
 * mistake you can make (PRD 5.3).
 */
export const LAND_LEVEL = 158;
export const SEA_LEVEL = 334;

export const BEDROCK_ROWS = 6;

/** Flagpole ownership + deposit radius, in cells. */
export const FLAG_RADIUS = 44;

/** Clonk health. Falling, drowning and explosions all take from this. */
export const CLONK_HP = 100;
/** Ticks a clonk can stay under water before it starts losing health. */
export const MAX_BREATH = 300;
/** Ticks before a dead player gets a new clonk at their flag. */
export const RESPAWN_TICKS = 90;
/** Fall speed (Fx px/tick) above which landing hurts. */
export const FALL_HURT_SPEED = 262144; // 4 px/tick

/** Dynamite: fuse length in ticks, blast radius in cells. */
export const FUSE_TICKS = 100;
export const BLAST_RADIUS = 22;
export const BLAST_HURT_RADIUS = 34;

export const FOUNDRY_W = 26;
export const FOUNDRY_H = 18;
export const FOUNDRY_PERIOD = 60;

export const ELEVATOR_W = 10;
export const ELEVATOR_LEN = 96;
export const ELEVATOR_SPEED = 26214; // 0.4 px/tick in Q16.16

/** The clonk must fit inside a dug tunnel with room to spare, so these are set
 *  against DIG_RADIUS in sim/clonk.ts, not independently. */
export const CLONK_W = 7;
export const CLONK_H = 11;

/** Hash exchange cadence for desync detection (PRD 6.4). */
export const HASH_PERIOD = 30;

// --- round setup -----------------------------------------------------------

/**
 * What ends the round. Gold Rush is PRD M8; Melee is S1, promoted because a
 * settlement race and a fight are different games and the lobby should offer
 * both rather than assume.
 */
export const MODE = {
  GOLD: 0,
  MELEE: 1,
} as const;

export const MODE_NAMES = ['Gold Rush', 'Melee'];

/** Kills a team needs in Melee, or the lead at the final whistle. */
export const KILLS_TO_WIN = 12;

// --- loam ------------------------------------------------------------------

/** Cells of bridge laid per loam chunk, and how thick it is. */
export const LOAM_SPAN = 26;
export const LOAM_THICK = 5;

// --- the lorry -------------------------------------------------------------

export const LORRY_W = 16;
export const LORRY_H = 11;
/** Chunks a lorry can hold. The point of it is not having to walk each one. */
export const LORRY_CAPACITY = 12;
/** How hard a clonk shoves it, in Fx px/tick added per tick of contact. */
export const LORRY_PUSH = 9830;

// --- fighting --------------------------------------------------------------

/** A shovel to the head. Reach is in cells, measured from the body edge. */
export const SHOVEL_DAMAGE = 14;
export const SHOVEL_REACH = 9;
export const SHOVEL_COOLDOWN = 18;
/** Damage from a thrown chunk, scaled by how fast it was going. */
export const THROWN_DAMAGE = 26;

// --- bots ------------------------------------------------------------------

/** Ticks between a bot reconsidering what it is doing. Low enough to react,
 *  high enough that four of them cost nothing. */
export const BOT_THINK = 15;
