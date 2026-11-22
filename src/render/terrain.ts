import { CHUNK, CHUNKS_X, CHUNK_COUNT, GRID_H, GRID_W, SEA_LEVEL } from '../data/config';
import { MAT_COUNT, PALETTE } from '../data/materials';
import type { World } from '../sim/world';
import { program, uniforms } from './gl';

export const MAX_LIGHTS = 16;

const VS = `#version 300 es
precision highp float;
in vec2 aPos;
uniform vec2 uCam;      // world px at the top-left of the viewport
uniform vec2 uView;     // world px visible
out vec2 vWorld;
out vec2 vScreen;
void main() {
  vWorld = uCam + aPos * uView;
  vScreen = aPos;
  gl_Position = vec4(aPos.x * 2.0 - 1.0, 1.0 - aPos.y * 2.0, 0.0, 1.0);
}`;

/**
 * One shader draws the entire world: sky, parallax background, and every
 * material with its own texture and lighting.
 *
 * Three things do the heavy lifting for the look, and they are the three things
 * that separate a cell grid from Clonk's terrain:
 *
 *  1. **Detail finer than the grid.** Material *selection* happens per cell, but
 *     the texture is generated at three samples per cell, so earth reads as
 *     grain and grit rather than as flat squares of brown. Clonk's material
 *     bitmaps are likewise finer than its material map.
 *  2. **Chiselled edges.** A smoothed coverage field over the neighbouring cells
 *     gives a surface gradient, which is lit directionally. That turns
 *     stair-stepped cell boundaries into rounded, three-dimensional rock, and
 *     puts a contact shadow under every overhang.
 *  3. **Real light.** Point lights - a clonk's lamp, a furnace mouth, a burning
 *     fuse, an explosion - fall off through the dark. A cave lit only by what
 *     you carry into it is most of Clonk's atmosphere underground.
 */
const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2DArray;

in vec2 vWorld;
in vec2 vScreen;
out vec4 oColor;

uniform usampler2D uMat;
uniform usampler2D uBg;
uniform usampler2D uSurf;
uniform vec3 uPalette[${MAT_COUNT}];
uniform float uTime;
uniform vec2 uGrid;
uniform vec2 uCam;
uniform vec2 uView;
uniform float uSea;
/**
 * The landscape materials, one tiling bitmap per layer.
 *
 * Clonk draws its ground from tiled texture bitmaps, and no amount of noise
 * in a shader gets to the same place: the grain of real earth is not a
 * function anyone writes by hand. These are OpenClonk's own material
 * textures, CC-BY 3.0, listed with their authors in ASSETS.csv.
 */
uniform sampler2DArray uTex;
/** World pixels per texture repeat, as one over. */
uniform float uTexScale;
uniform vec4 uLights[${MAX_LIGHTS}];
uniform vec3 uLightCol[${MAX_LIGHTS}];
uniform int uLightCount;

// --- integer hash noise ----------------------------------------------------

float hash1(ivec2 c) {
  uint h = uint(c.x) * 0x27d4eb2du ^ uint(c.y) * 0x165667b1u;
  h ^= h >> 15; h *= 0x85ebca6bu; h ^= h >> 13; h *= 0xc2b2ae35u; h ^= h >> 16;
  return float(h & 0xffffu) / 65535.0;
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  ivec2 b = ivec2(i);
  float a00 = hash1(b);
  float a10 = hash1(b + ivec2(1, 0));
  float a01 = hash1(b + ivec2(0, 1));
  float a11 = hash1(b + ivec2(1, 1));
  return mix(mix(a00, a10, f.x), mix(a01, a11, f.x), f.y);
}

/** Two octaves. A third costs four more hashes per call for detail that the
 *  per-pixel grain already provides. */
float fbm(vec2 p) {
  return vnoise(p) * 0.66 + vnoise(p * 2.23) * 0.34;
}

uint matAt(ivec2 c) {
  if (c.x < 0 || c.y < 0 || c.x >= int(uGrid.x) || c.y >= int(uGrid.y)) return 8u;
  return texelFetch(uMat, c, 0).r;
}

/** Passable to a clonk. Used by the shading that asks "is there open space". */
bool isAir(uint m) { return m == 0u || m == 7u || m == 12u || (m >= 14u && m <= 16u) || m == 19u; }
bool isLiquidM(uint m) { return m == 7u || (m >= 14u && m <= 16u); }
/**
 * Empty space, as far as the eye is concerned. Only sky. Water and leaves are
 * passable but visible, so they are drawn as materials and get an antialiased
 * outline against the sky like anything else.
 */
bool isVoid(uint m) { return m == 0u || m == 19u; }
bool isSoil(uint m) { return m == 1u || m == 9u || m == 6u; }

/** Texture layer for a material, or -1 for the ones still drawn by hand. */
int texLayer(uint m) {
  if (m == 1u || m == 9u || m == 13u) return 0;  // earth, loose earth, loam
  if (m == 2u) return 1;                          // rock
  if (m == 3u) return 2;                          // coal
  if (m == 4u) return 3;                          // ore
  if (m == 5u) return 4;                          // gold
  if (m == 6u) return 5;                          // sand
  if (m == 8u) return 6;                          // granite
  return -1;
}
const float TUNNEL_LAYER = 7.0;

/**
 * The pattern at a world position: mid-grey on average, carrying only the
 * structure of the material.
 *
 * This is Clonk's own model, from the Clonk Rage engine source (ISC): the
 * landscape texture is not the colour of the ground but a pattern that
 * modulates the material's colour, sampled nearest-neighbour at one texel per
 * landscape pixel. The engine multiplies colour by pattern and then doubles
 * the result, which is why a pattern normalised to mid-grey leaves the
 * material at its own colour on average. That separation is what keeps coal,
 * earth and tunnel apart: each keeps its own colour, and the texture only adds
 * grain.
 */
vec3 texAt(vec2 w, float layer) {
  return texture(uTex, vec3(w * uTexScale, layer)).rgb;
}

vec3 modulate(vec3 base, vec3 pattern) {
  // The bitmaps carry strong cracks and blotches that read as cartoon at
  // close zoom. Pulling the pattern towards mid-grey keeps the grain and drops
  // the doodles; a fine per-subpixel hash adds the grit real soil has.
  vec3 pat = mix(vec3(0.5), pattern, 0.62);
  float grit = hash1(ivec2(floor(vWorld * 3.0))) - 0.5;
  return clamp(base * pat * 2.0 * (1.0 + grit * 0.07), 0.0, 1.0);
}

/** Clonk's Tunnel material has no cell of its own here, so its colour lives in the shader. */
const vec3 TUNNEL_COL = vec3(0.30, 0.23, 0.17);

// --- surface shape ---------------------------------------------------------

float solidF(ivec2 c) { return isVoid(matAt(c)) ? 0.0 : 1.0; }

/** Smoothly interpolated solidity, so cell corners round off. */
float coverage(vec2 w) {
  vec2 p = w - 0.5;
  ivec2 b = ivec2(floor(p));
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float s00 = solidF(b);
  float s10 = solidF(b + ivec2(1, 0));
  float s01 = solidF(b + ivec2(0, 1));
  float s11 = solidF(b + ivec2(1, 1));
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}


/**
 * Clonk's Tunnel material.
 *
 * A dug tunnel and a natural cavern are the same stuff in Clonk - both are
 * Tunnel - and both read as a mid brown, clearly darker than the earth around
 * them but nowhere near black. Caverns used to be drawn near black, and at
 * Clonk's viewing distance every one of them became an ink blot.
 */
vec3 tunnelColour(ivec2 c) {
  vec3 col = modulate(TUNNEL_COL, texAt(vWorld, TUNNEL_LAYER)) * 1.05;
  // Ambient occlusion: open space hemmed in by rock is darker than a wide
  // cavern, and the corners are darkest of all. Two rings of samples.
  float occ = 0.0;
  for (int k = 0; k < 8; k++) {
    vec2 d = vec2(cos(float(k) * 0.785), sin(float(k) * 0.785));
    occ += isVoid(matAt(c + ivec2(d * 3.0))) ? 0.0 : 1.0;
    occ += isVoid(matAt(c + ivec2(d * 7.0))) ? 0.0 : 0.6;
  }
  occ /= 12.8;
  col *= 1.0 - 0.45 * occ;
  // The ceiling casts a soft shadow on the back wall below it.
  float over = 0.0;
  for (int k = 1; k <= 4; k++) {
    if (!isAir(matAt(c + ivec2(0, -k)))) { over = 1.0 - float(k - 1) / 4.0; break; }
  }
  return col * (1.0 - 0.25 * over);

}


/**
 * Hard shadow cast by the sun, marched towards the light.
 *
 * Only near the surface: deeper than this the ambient darkening has taken over
 * and the march would cost eight texture fetches for nothing.
 */
float sunShadow(ivec2 c, float surf) {
  if (float(c.y) > surf + 34.0) return 0.0;
  const int STEPS[8] = int[8](2, 4, 7, 11, 16, 22, 30, 40);
  for (int i = 0; i < 8; i++) {
    float d = float(STEPS[i]);
    ivec2 q = c + ivec2(int(-0.48 * d), int(-0.88 * d));
    if (!isVoid(matAt(q))) return 1.0 - float(i) / 9.0;
  }
  return 0.0;
}

/** Material of the nearest solid neighbour, for antialiasing the silhouette. */
uint nearestSolid(ivec2 c) {
  uint m;
  m = matAt(c + ivec2(0, 1)); if (!isVoid(m)) return m;
  m = matAt(c + ivec2(0, -1)); if (!isVoid(m)) return m;
  m = matAt(c + ivec2(-1, 0)); if (!isVoid(m)) return m;
  m = matAt(c + ivec2(1, 0)); if (!isVoid(m)) return m;
  m = matAt(c + ivec2(-1, 1)); if (!isVoid(m)) return m;
  m = matAt(c + ivec2(1, 1)); if (!isVoid(m)) return m;
  m = matAt(c + ivec2(-1, -1)); if (!isVoid(m)) return m;
  m = matAt(c + ivec2(1, -1)); if (!isVoid(m)) return m;
  return 0u;
}

// --- lighting --------------------------------------------------------------

vec3 lightAt(vec2 p) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    vec4 L = uLights[i];
    float d = length(p - L.xy);
    float f = clamp(1.0 - d / max(L.z, 1.0), 0.0, 1.0);
    sum += uLightCol[i] * (f * f * L.w);
  }
  return sum;
}

// --- sky -------------------------------------------------------------------

/**
 * Cumulus field.
 *
 * Four octaves rather than the two the ground textures use, because a cloud
 * needs a billowed edge and two octaves give a smooth blob. This is the one
 * place in the shader where the extra samples earn their cost.
 */
float cloudField(vec2 p) {
  return vnoise(p) * 0.41 + vnoise(p * 2.07) * 0.28
       + vnoise(p * 4.13) * 0.19 + vnoise(p * 8.31) * 0.12;
}

/**
 * A ridge line for a distant mountain range, in layer pixels. Two octaves of
 * smooth noise plus a sharper third, so peaks are pointed and slopes are long.
 */
float ridge(float x, float seed) {
  float a = vnoise(vec2(x * 0.0045, seed)) * 0.62;
  float b = vnoise(vec2(x * 0.011, seed + 7.0)) * 0.26;
  float c = vnoise(vec2(x * 0.027, seed + 13.0)) * 0.12;
  return a + b + c;
}

vec3 sky(vec2 world, vec2 screen) {
  // A real daytime sky: deep blue overhead, pale and hazy at the horizon.
  float h = clamp(screen.y, 0.0, 1.0);
  vec3 zenith = vec3(0.30, 0.52, 0.84);
  vec3 horizon = vec3(0.76, 0.85, 0.93);
  vec3 col = mix(zenith, horizon, pow(h, 1.6));

  vec2 sunScreen = vec2(0.78, 0.12);
  float aspect = uView.x / max(uView.y, 1.0);
  float sd = length((screen - sunScreen) * vec2(aspect, 1.0));
  col += vec3(1.0, 0.93, 0.78) * (0.22 * smoothstep(0.55, 0.0, sd) + 0.5 * smoothstep(0.035, 0.0, sd));

  // Fair-weather cumulus: sparse, soft-edged, sunlit on top and grey-blue
  // underneath. Screen space, drifting slowly with a little parallax.
  vec2 sp = vec2(screen.x * aspect, screen.y);
  vec2 q = sp * vec2(2.6, 4.2) + vec2(uCam.x * 0.0006 + uTime * 0.003, uCam.y * 0.0003);
  float c = cloudField(q);
  float below = cloudField(q + vec2(0.0, 0.06));
  float body = smoothstep(0.58, 0.70, c) * (1.0 - smoothstep(0.35, 0.75, h));
  float shade = clamp((below - c) * 3.0 + 0.35, 0.0, 1.0);
  vec3 cloud = mix(vec3(1.0, 0.99, 0.96), vec3(0.66, 0.72, 0.82), shade);
  col = mix(col, cloud, body * 0.92);

  // Distant ranges, two layers. Each is drawn in its own parallax space so it
  // slides behind the island more slowly the further away it is, and fades
  // towards the horizon colour with distance: aerial perspective.
  for (int L = 0; L < 2; L++) {
    float k = L == 0 ? 0.12 : 0.28;
    vec2 lp = world - uCam * (1.0 - k);
    float base = uSea - (L == 0 ? 150.0 : 95.0);
    float amp = L == 0 ? 160.0 : 90.0;
    float r = ridge(lp.x, float(L) * 31.0);
    float top = base - r * amp;
    if (lp.y > top) {
      float under = lp.y - top;
      vec3 col0;
      if (L == 0) {
        // Far range: blue-grey rock, snow on the high peaks.
        col0 = vec3(0.50, 0.58, 0.68);
        float snowLine = smoothstep(0.66, 0.74, r) * (1.0 - smoothstep(4.0, 6.0 + 40.0 * (r - 0.66), under));
        col0 = mix(col0, vec3(0.93, 0.95, 0.98), snowLine);
      } else {
        // Near hills: forested, green going blue with distance.
        col0 = vec3(0.30, 0.44, 0.34) * (0.92 + 0.16 * vnoise(lp * vec2(0.08, 0.12)));
      }
      // Light from the sun's side, from the ridge's slope, softly.
      float slope = ridge(lp.x + 12.0, float(L) * 31.0) - ridge(lp.x - 12.0, float(L) * 31.0);
      col0 *= 1.0 + clamp(slope * 2.5, -0.12, 0.12);
      float haze = (L == 0 ? 0.42 : 0.22) + 0.3 * smoothstep(0.0, 200.0, under);
      col = mix(col0, horizon, clamp(haze, 0.0, 0.85));
    }
  }
  return col;
}

// --- material textures -----------------------------------------------------

/**
 * Colour for a material at a point. The w coordinate is continuous, not a cell
 * index, so the grain is finer than the grid the material lives on.
 */
vec3 material(uint m, ivec2 c, vec2 w) {
  int layer = texLayer(m);
  if (layer >= 0) {
    // Loam and loose earth share earth's pattern and differ only in colour,
    // which is how Clonk distinguishes them too.
    return modulate(uPalette[m], texAt(w, float(layer)));
  }
  vec3 base = uPalette[m];
  vec2 p = w;
  ivec2 fine = ivec2(floor(w * 3.0));
  float grain = hash1(fine);
  float n = fbm(p * 0.09);

  if (m == 11u) {
    // Bark: a round trunk, lit from the sun's side, with vertical furrows and
    // the odd knot. The position across the trunk comes from how far the wood
    // runs to either side.
    int dl = 0;
    int dr = 0;
    for (int k = 1; k <= 4; k++) { if (matAt(c - ivec2(k, 0)) != 11u) break; dl = k; }
    for (int k = 1; k <= 4; k++) { if (matAt(c + ivec2(k, 0)) != 11u) break; dr = k; }
    float across = (float(dl) + fract(w.x) + 0.0) / float(dl + dr + 1);
    float round_ = sin(across * 3.14159);
    float furrow = vnoise(vec2(w.x * 2.2, w.y * 0.22));
    vec3 col = mix(vec3(0.24, 0.17, 0.11), vec3(0.50, 0.38, 0.26), furrow);
    col *= 0.55 + 0.45 * round_ + 0.25 * across;
    if (vnoise(p * 0.4) > 0.82) col *= 0.7;
    return col;
  }
  if (m == 12u) {
    // Foliage: overlapping leaf clusters, sunlit on their upper right, darker
    // the deeper into the crown a point lies, with gaps of shadow between.
    int fromTop = 8;
    for (int k = 1; k <= 8; k++) { if (matAt(c - ivec2(0, k)) != 12u) { fromTop = k - 1; break; } }
    int fromRight = 6;
    for (int k = 1; k <= 6; k++) { if (matAt(c + ivec2(k, 0)) != 12u) { fromRight = k - 1; break; } }
    float clusters = vnoise(p * 0.42) * 0.6 + vnoise(p * 1.05) * 0.4;
    float leaf = vnoise(p * 2.4);
    vec3 deep = vec3(0.10, 0.20, 0.08);
    vec3 mid = vec3(0.22, 0.38, 0.13);
    vec3 lit = vec3(0.50, 0.64, 0.24);
    float sun = clamp(1.0 - float(fromTop) / 6.0, 0.0, 1.0) * 0.7 + clamp(1.0 - float(fromRight) / 5.0, 0.0, 1.0) * 0.3;
    vec3 col = mix(deep, mid, smoothstep(0.25, 0.6, clusters));
    col = mix(col, lit, smoothstep(0.45, 0.85, clusters * 0.6 + sun * 0.5 + leaf * 0.15) * (0.4 + 0.6 * sun));
    col *= 0.9 + 0.2 * leaf;
    if (clusters < 0.26) col *= 0.6;
    return col;
  }
  if (m == 18u) {
    // Snow: near-white, blue in its hollows, with the odd crystal catching the
    // light. Wind-packed layers show as faint horizontal bands.
    float drift = vnoise(vec2(p.x * 0.05, p.y * 0.22));
    vec3 col = mix(vec3(0.80, 0.86, 0.95), base, smoothstep(0.25, 0.75, n));
    col *= 0.94 + 0.08 * drift;
    if (hash1(fine) > 0.985) col += vec3(0.25);
    return col;
  }
  if (m == 17u) {
    // Ice: clear blue with depth, long fracture lines and bright streaks where
    // the surface catches the sky.
    vec3 col = mix(base * 0.72, base * 1.05, n);
    float crack = abs(vnoise(p * vec2(0.08, 0.3)) - 0.5);
    col *= 1.0 - 0.28 * smoothstep(0.03, 0.0, crack);
    float streak = smoothstep(0.92, 1.0, sin((p.x + p.y * 0.6) * 0.35) * 0.5 + 0.5);
    col += vec3(0.18, 0.22, 0.26) * streak;
    return col;
  }
  if (m == 10u) {
    // Structure: riveted plate.
    vec3 col = base * (0.86 + 0.16 * grain);
    ivec2 r = c & ivec2(7, 7);
    if (r.x == 0 || r.y == 0) col *= 0.82;
    if (r.x == 4 && r.y == 4) col *= 1.22;
    return col;
  }
  return base * (0.85 + 0.3 * n);
}

/**
 * How much daylight reaches open space underground. Bright near the surface,
 * fading over the first hundred cells or so and never to black: the style is
 * a bright, readable world, and the worker's lamp does the rest.
 */
float caveLight(ivec2 c, float surf) {
  return mix(1.0, 0.42, smoothstep(4.0, 130.0, float(c.y) - surf));
}

/** Soil that grows grass: earth, loose earth and loam, open to the sky. */
bool grassy(uint m) { return m == 1u || m == 9u || m == 13u; }

/**
 * Grass blades standing in the air above sunlit soil. Drawn at three
 * sub-pixels per cell so each blade is thinner than a cell, with heights and
 * lean from a hash of the blade's column, swaying a little in the wind.
 * Returns alpha in w.
 */
vec4 grassBlade(ivec2 c, float surf) {
  if (float(c.y) > surf + 3.0) return vec4(0.0);
  int g = -1;
  for (int k = 1; k <= 3; k++) {
    uint m = matAt(c + ivec2(0, k));
    if (!isVoid(m)) { if (grassy(m) && isVoid(matAt(c + ivec2(0, k - 1)))) g = k; break; }
  }
  if (g < 0) return vec4(0.0);
  float sway = sin(uTime * 1.3 + vWorld.x * 0.05) * 0.25;
  float above = float(c.y + g) - vWorld.y;            // height above the ground, cells
  float fx = floor((vWorld.x + sway * above * 0.4) * 3.0);
  float r = hash1(ivec2(int(fx), 77));
  float hgt = 0.6 + r * 2.2;
  if (r < 0.25 || above > hgt) return vec4(0.0);
  vec3 base = vec3(0.24, 0.42, 0.14);
  vec3 tip = vec3(0.56, 0.72, 0.28);
  return vec4(mix(base, tip, clamp(above / hgt, 0.0, 1.0)) * (0.9 + 0.2 * r), 1.0);
}

/** Colour of the open air at a point: sky above the ground, tunnel below it. */
vec3 airColour(ivec2 c, float surf, float depth) {
  // Anything that was solid when the island was made is a dug tunnel.
  if (!isVoid(texelFetch(uBg, c, 0).r)) return tunnelColour(c) * caveLight(c, surf);
  float t = clamp((float(c.y) - surf) / 3.5, 0.0, 1.0);
  if (t < 1.0) return mix(sky(vWorld, vScreen), tunnelColour(c) * caveLight(c, surf), t);
  return tunnelColour(c) * caveLight(c, surf);

}


/**
 * Lava: a slow churn of bright molten veins under a darker skin that cracks
 * and re-forms. Brighter than white in places on purpose: the bloom pass
 * picks that up and the pool glows.
 */
vec3 lavaColour(ivec2 c) {
  vec2 p = vWorld;
  float t = uTime;
  float flow = fbm(p * 0.07 + vec2(t * 0.05, -t * 0.03));
  float veins = fbm(p * 0.16 + vec2(-t * 0.09, t * 0.04) + flow * 2.0);
  float crust = smoothstep(0.42, 0.62, veins);
  vec3 hot = vec3(1.55, 0.95, 0.30);
  vec3 warm = vec3(1.15, 0.36, 0.06);
  vec3 skin = vec3(0.30, 0.07, 0.03);
  vec3 col = mix(hot, warm, smoothstep(0.30, 0.55, flow));
  col = mix(col, skin, crust * 0.85);
  // The surface boils: bright blisters that pop and fade.
  if (matAt(c + ivec2(0, -1)) != 14u) {
    col = mix(col, hot * 1.2, 0.35 + 0.25 * sin(p.x * 0.5 + t * 3.0));
  }
  return col;
}

/** Acid: a sickly green that glows faintly, with bubbles rising through it. */
vec3 acidColour(ivec2 c, float dnorm) {
  vec2 p = vWorld;
  vec3 col = mix(uPalette[15] * 1.1, uPalette[15] * 0.38, dnorm);
  // Murky swirls, so a pool has depth rather than being a flat green.
  float swirl = fbm(p * 0.06 + vec2(uTime * 0.04, -uTime * 0.02));
  col *= 0.75 + 0.5 * swirl;
  float bubble = hash1(ivec2(floor(p.x * 0.5), floor(p.y * 0.5 + uTime * 4.0)));
  if (bubble > 0.97) col += vec3(0.25, 0.35, 0.12);
  col *= 0.9 + 0.15 * fbm(p * 0.12 + vec2(0.0, uTime * 0.3));
  if (matAt(c + ivec2(0, -1)) != 15u) col += vec3(0.10, 0.14, 0.04);
  return col;
}

/** Oil: nearly black, with a rainbow sheen sliding across its surface. */
vec3 oilColour(ivec2 c) {
  vec2 p = vWorld;
  vec3 col = uPalette[16] * (0.85 + 0.3 * fbm(p * 0.1 + vec2(uTime * 0.05, 0.0)));
  if (matAt(c + ivec2(0, -1)) != 16u) {
    float h = fract(p.x * 0.02 + fbm(p * 0.05) * 1.5 + uTime * 0.04);
    vec3 sheen = 0.5 + 0.5 * cos(6.2831 * (h + vec3(0.0, 0.33, 0.67)));
    col += sheen * 0.22;
  }
  return col;
}

/** Water, shaded by how deep below its own surface the pixel sits, and
 *  translucent over whatever is behind it. */
vec3 waterColour(ivec2 c, float depth) {
  uint lm = matAt(c);
  if (lm == 14u) return lavaColour(c);
  if (lm == 16u) return oilColour(c);
  if (lm == 15u) {
    int ad = 1;
    for (int k = 1; k <= 8; k++) {
      if (matAt(c + ivec2(0, -k)) != 15u) break;
      ad = k + 1;
    }
    vec3 a = acidColour(c, clamp(float(ad) / 8.0, 0.0, 1.0));
    if (!isVoid(texelFetch(uBg, c, 0).r)) a = mix(tunnelColour(c) * 0.75, a, 0.7);
    return a;
  }
  int wd = 1;
  for (int k = 1; k <= 8; k++) {
    if (matAt(c + ivec2(0, -k)) != 7u) break;
    wd = k + 1;
  }
  float dnorm = clamp(float(wd) / 8.0, 0.0, 1.0);
  float wave = sin(vWorld.x * 0.14 + uTime * 1.6) * 0.5 + 0.5;
  float wave2 = sin(vWorld.x * 0.41 - uTime * 2.3) * 0.5 + 0.5;
  vec3 shallow = uPalette[7] * 1.18 + vec3(0.03, 0.06, 0.08);
  vec3 deepCol = uPalette[7] * 0.86;
  vec3 col = mix(shallow, deepCol, dnorm);
  col *= 0.90 + 0.12 * wave + 0.06 * wave2;
  float caustic = fbm(vec2(vWorld.x * 0.30 + uTime * 0.8, vWorld.y * 0.16));
  col += vec3(0.05, 0.09, 0.10) * smoothstep(0.55, 0.9, caustic) * (1.0 - dnorm);
  if (matAt(c + ivec2(0, -1)) != 7u) {
    col += vec3(0.22, 0.26, 0.28) * (0.6 + 0.4 * wave);
    if (hash1(ivec2(floor(vWorld * 3.0)) + ivec2(int(uTime * 6.0), 0)) > 0.82) {
      col += vec3(0.20, 0.24, 0.26);
    }
  }
  // See through it into a flooded tunnel. A cell can only hold one material,
  // so what is behind the water is whatever the background layer says was
  // there before it was dug.
  if (!isVoid(texelFetch(uBg, c, 0).r)) col = mix(tunnelColour(c) * 0.75, col, 0.62);
  return col;
}

/** Fully shaded material colour, including relief and edge lighting. */
vec3 solidColour(uint m, ivec2 c, float surf, float depth, float cov, vec2 grad) {
  if (isLiquidM(m)) return waterColour(c, depth);
  vec3 col = material(m, c, vWorld);
  float below = float(c.y) - surf;

  // Soil profile: a dark humus band under the surface, then the subsoil
  // gradually greying and cooling with depth, as a real cut bank does.
  if (grassy(m)) {
    float humus = 1.0 - smoothstep(2.0, 9.0 + 3.0 * vnoise(vWorld * 0.08), below);
    col = mix(col, col * vec3(0.62, 0.55, 0.48), humus * 0.8);
    // A green cap where the soil meets daylight.
    if (isVoid(matAt(c + ivec2(0, -1))) && below < 3.0) col = mix(col, vec3(0.30, 0.50, 0.17), 0.85);
    else if (isVoid(matAt(c + ivec2(0, -2))) && below < 4.0) col = mix(col, vec3(0.26, 0.38, 0.15), 0.45);
  }
  col = mix(col, col * vec3(0.86, 0.88, 0.94), smoothstep(10.0, 260.0, below));

  // Seams: a slight darkening where two different solids meet, so veins sit
  // in the rock instead of looking pasted on.
  uint n1 = matAt(c + ivec2(1, 0));
  uint n2 = matAt(c + ivec2(0, 1));
  uint n3 = matAt(c + ivec2(-1, 0));
  uint n4 = matAt(c + ivec2(0, -1));
  bool seam = (!isVoid(n1) && !isLiquidM(n1) && n1 != m) || (!isVoid(n2) && !isLiquidM(n2) && n2 != m)
           || (!isVoid(n3) && !isLiquidM(n3) && n3 != m) || (!isVoid(n4) && !isLiquidM(n4) && n4 != m);
  if (seam) col *= 0.86;

  // Relief from the coverage gradient, lit from the sun's side.
  float slope = length(grad);
  if (slope > 0.002) {
    vec3 nrm = normalize(vec3(-grad * 3.4, 1.0));
    vec3 L = normalize(vec3(0.44, -0.82, 0.48));
    float diff = clamp(dot(nrm, L), 0.0, 1.0);
    col *= mix(1.0, 0.78 + 0.38 * diff, clamp(slope * 2.2, 0.0, 1.0));
  }
  col *= 0.96 + 0.05 * cov;
  col *= 1.0 - 0.18 * sunShadow(c, surf);

  // Edges facing open space: lit from above, shadowed underneath.
  int up = 9;
  if (isAir(matAt(c + ivec2(0, -1)))) up = 1;
  else if (isAir(matAt(c + ivec2(0, -2)))) up = 2;
  int dn = 9;
  if (isAir(matAt(c + ivec2(0, 1)))) dn = 1;
  else if (isAir(matAt(c + ivec2(0, 2)))) dn = 2;
  if (up == 1) col *= 1.16;
  else if (up == 2) col *= 1.07;
  if (dn == 1) col *= 0.78;
  else if (dn == 2) col *= 0.9;

  // Daylight falls off with depth, gently: underground stays readable.
  col *= mix(1.0, 0.7, smoothstep(8.0, 200.0, below));
  return col;
}

void main() {
  ivec2 c = ivec2(floor(vWorld));
  uint m = matAt(c);
  float surf = float(texelFetch(uSurf, ivec2(clamp(c.x, 0, int(uGrid.x) - 1), 0), 0).r);
  float depth = clamp((float(c.y) - surf) / 260.0, 0.0, 1.0);

  // Antialiased silhouette. The smoothed coverage field decides how much of
  // this pixel is solid, so boundaries become smooth curves instead of the
  // stair-steps of the underlying cell grid - the difference between a tile map
  // and a landscape.
  float cov = coverage(vWorld);
  vec2 grad = vec2(coverage(vWorld + vec2(1.2, 0.0)) - cov, coverage(vWorld + vec2(0.0, 1.2)) - cov);
  float fill = smoothstep(0.44, 0.56, cov);

  vec3 col;
  bool lit = true;

  if (!isVoid(m) && fill >= 0.999) {
    col = solidColour(m, c, surf, depth, cov, grad);
  } else if (isVoid(m) && fill <= 0.001) {
    col = airColour(c, surf, depth);
    if (float(c.y) <= surf) lit = false;
  } else {
    // In the transition band: blend sky against the nearest material, which is
    // what antialiases the outline.
    uint sm = isVoid(m) ? nearestSolid(c) : m;
    vec3 air = airColour(c, surf, depth);
    vec3 solid = sm == 0u ? air : solidColour(sm, c, surf, depth, cov, grad);
    col = mix(air, solid, fill);
  }

  // Ragged crowns: open air right beside foliage sometimes holds a stray
  // cluster of leaves, so a crown's outline is leafy rather than cell-shaped.
  if (isVoid(m) && fill < 0.5) {
    bool nearLeaf = matAt(c + ivec2(1, 0)) == 12u || matAt(c - ivec2(1, 0)) == 12u
                 || matAt(c + ivec2(0, 1)) == 12u || matAt(c - ivec2(0, 1)) == 12u;
    if (nearLeaf && vnoise(vWorld * 1.3) > 0.56) {
      col = material(12u, c, vWorld) * (1.0 - 0.18 * sunShadow(c, surf));
    }
  }
  if (isVoid(m) && fill < 0.5) {
    vec4 gb = grassBlade(c, surf);
    if (gb.w > 0.0) col = gb.rgb * (1.0 - 0.18 * sunShadow(c, surf));
  }

  // Lava glows by itself: no shading pass dims it.
  if (m == 14u) lit = false;
  if (lit) col *= 1.0 + lightAt(vWorld);

  // Fire is drawn over whatever is behind it: a flickering tongue, white-hot
  // at its root and red at its tips, bright enough to bloom.
  if (m == 19u) {
    float rootness = matAt(c + ivec2(0, 1)) == 19u ? 0.55 : 1.0;
    float flick = vnoise(vec2(vWorld.x * 0.6, vWorld.y * 0.35 + uTime * 9.0));
    vec3 flame = mix(vec3(1.4, 0.32, 0.06), vec3(1.7, 1.15, 0.45), flick * rootness);
    col = mix(col, flame, 0.55 + 0.45 * flick);
  }

  oColor = vec4(col, 1.0);
}
`;

const MAX_CHUNK_UPLOADS = 768;

/**
 * The material texture strip: eight square tiles stacked vertically, uploaded
 * as the layers of a 2D array texture.
 *
 * An array rather than an atlas because the materials tile, and tiling in an
 * atlas means bleeding between neighbours at every repeat. A layer wraps on
 * its own.
 */
const TEX_SIZE = 192;
const TEX_LAYERS = 8;
/**
 * World pixels one tile covers: the tile size, so one texel lands on one
 * landscape pixel. Clonk samples its patterns exactly like this, and any other
 * ratio either blurs the grain or makes it chunky.
 */
const TEX_REPEAT = TEX_SIZE;
const PALETTE_FLOATS = MAT_COUNT * 3;

export interface Light {
  x: number;
  y: number;
  radius: number;
  intensity: number;
  r: number;
  g: number;
  b: number;
}

export class TerrainRenderer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null>;
  private vao: WebGLVertexArrayObject;
  private matTex: WebGLTexture;
  private bgTex: WebGLTexture;
  private surfTex: WebGLTexture;
  private texArr: WebGLTexture;
  private bgCaptured = false;
  private scratch = new Uint8Array(CHUNK * CHUNK);
  private stamp = new Int32Array(CHUNK_COUNT).fill(-2);
  private lightData = new Float32Array(MAX_LIGHTS * 4);
  private lightCols = new Float32Array(MAX_LIGHTS * 3);

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.prog = program(gl, VS, FS);
    this.u = uniforms(gl, this.prog, [
      'uCam',
      'uView',
      'uMat',
      'uSurf',
      'uPalette',
      'uTime',
      'uGrid',
      'uSea',
      'uLights',
      'uLightCol',
      'uLightCount',
      'uBg',
      'uTex',
      'uTexScale',
    ]);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.matTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.matTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, GRID_W, GRID_H);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.bgTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, GRID_W, GRID_H);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.surfTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.surfTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16UI, GRID_W, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // The material patterns. Seeded flat mid-grey, which modulates every
    // material to exactly its own colour, so the first frames are right before
    // the image has decoded.
    this.texArr = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texArr);
    // RGBA rather than RGB: the image arrives through a 2D canvas, which only
    // ever hands over RGBA, and WebGL refuses RGBA data for an RGB texture.
    // With RGB8 here every layer upload failed and the ground silently stayed
    // the flat mid-grey seed below - no texture at all.
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, TEX_SIZE, TEX_SIZE, TEX_LAYERS);
    const flat = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
    flat.fill(128);
    for (let l = 0; l < TEX_LAYERS; l++) {
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY, 0, 0, 0, l, TEX_SIZE, TEX_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, flat,
      );
    }
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    this.loadMaterials();

    const pal = new Float32Array(PALETTE_FLOATS);
    for (let i = 0; i < MAT_COUNT; i++) {
      pal[i * 3] = PALETTE[i][0] / 255;
      pal[i * 3 + 1] = PALETTE[i][1] / 255;
      pal[i * 3 + 2] = PALETTE[i][2] / 255;
    }
    gl.useProgram(this.prog);
    gl.uniform3fv(this.u.uPalette, pal);
    gl.uniform1i(this.u.uMat, 0);
    gl.uniform1i(this.u.uSurf, 1);
    gl.uniform1i(this.u.uBg, 2);
    gl.uniform1i(this.u.uTex, 3);
    gl.uniform1f(this.u.uTexScale, 1 / TEX_REPEAT);
    gl.uniform2f(this.u.uGrid, GRID_W, GRID_H);
    gl.uniform1f(this.u.uSea, SEA_LEVEL);
  }

  /**
   * Pulls the material strip in and slices it into the array's layers.
   *
   * Asynchronous on purpose: the round starts on the mean colours and sharpens
   * a frame or two later, which is far better than holding the first frame
   * hostage to a texture decode on a phone.
   */
  private loadMaterials(): void {
    const gl = this.gl;
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = TEX_SIZE;
      cv.height = TEX_SIZE;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texArr);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      for (let l = 0; l < TEX_LAYERS; l++) {
        ctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
        ctx.drawImage(img, 0, l * TEX_SIZE, TEX_SIZE, TEX_SIZE, 0, 0, TEX_SIZE, TEX_SIZE);
        gl.texSubImage3D(
          gl.TEXTURE_2D_ARRAY, 0, 0, 0, l, TEX_SIZE, TEX_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, cv,
        );
      }
    };
    img.src = `${import.meta.env.BASE_URL}materials.jpg`;
  }

  /**
   * Full re-upload. Used on round start and after a desync resync.
   *
   * The background layer is captured only the first time, because it has to be
   * the landscape as generated, before anyone dug. A resync arrives with the
   * dug state, and the background from round start is still the right one -
   * every client generated it from the same seed.
   */
  reset(w: World, surface: Int32Array): void {
    const gl = this.gl;
    if (!this.bgCaptured) {
      this.bgCaptured = true;
      gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        GRID_W,
        GRID_H,
        gl.RED_INTEGER,
        gl.UNSIGNED_BYTE,
        w.mat,
      );
    }
    gl.bindTexture(gl.TEXTURE_2D, this.matTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GRID_W, GRID_H, gl.RED_INTEGER, gl.UNSIGNED_BYTE, w.mat);
    const surf = new Uint16Array(GRID_W);
    for (let x = 0; x < GRID_W; x++) surf[x] = surface[x];
    gl.bindTexture(gl.TEXTURE_2D, this.surfTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GRID_W, 1, gl.RED_INTEGER, gl.UNSIGNED_SHORT, surf);
    for (let i = 0; i < CHUNK_COUNT; i++) this.stamp[i] = w.chunkStamp[i];
  }

  /** Uploads only the chunks the simulation touched since the last frame. */
  sync(w: World): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.matTex);
    let uploads = 0;
    for (let ci = 0; ci < CHUNK_COUNT && uploads < MAX_CHUNK_UPLOADS; ci++) {
      if (w.chunkStamp[ci] <= this.stamp[ci]) continue;
      this.stamp[ci] = w.chunkStamp[ci];
      const cx = (ci % CHUNKS_X) * CHUNK;
      const cy = Math.floor(ci / CHUNKS_X) * CHUNK;
      const s = this.scratch;
      for (let y = 0; y < CHUNK; y++) {
        const row = (cy + y) * GRID_W + cx;
        s.set(w.mat.subarray(row, row + CHUNK), y * CHUNK);
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, cx, cy, CHUNK, CHUNK, gl.RED_INTEGER, gl.UNSIGNED_BYTE, s);
      uploads++;
    }
  }

  draw(
    camX: number,
    camY: number,
    viewW: number,
    viewH: number,
    time: number,
    lights: Light[],
  ): void {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.matTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.surfTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texArr);
    gl.uniform2f(this.u.uCam, camX, camY);
    gl.uniform2f(this.u.uView, viewW, viewH);
    gl.uniform1f(this.u.uTime, time);

    const n = Math.min(lights.length, MAX_LIGHTS);
    for (let i = 0; i < n; i++) {
      const L = lights[i];
      this.lightData[i * 4] = L.x;
      this.lightData[i * 4 + 1] = L.y;
      this.lightData[i * 4 + 2] = L.radius;
      this.lightData[i * 4 + 3] = L.intensity;
      this.lightCols[i * 3] = L.r;
      this.lightCols[i * 3 + 1] = L.g;
      this.lightCols[i * 3 + 2] = L.b;
    }
    gl.uniform4fv(this.u.uLights, this.lightData);
    gl.uniform3fv(this.u.uLightCol, this.lightCols);
    gl.uniform1i(this.u.uLightCount, n);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}
