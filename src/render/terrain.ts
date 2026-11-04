import { CHUNK, CHUNKS_X, CHUNK_COUNT, GRID_H, GRID_W, SEA_LEVEL } from '../data/config';
import { MAT_COUNT, PALETTE } from '../data/materials';
import type { World } from '../sim/world';
import { program, uniforms } from './gl';

export const MAX_LIGHTS = 10;

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
bool isAir(uint m) { return m == 0u || m == 7u || m == 12u; }
/**
 * Empty space, as far as the eye is concerned. Only sky. Water and leaves are
 * passable but visible, so they are drawn as materials and get an antialiased
 * outline against the sky like anything else.
 */
bool isVoid(uint m) { return m == 0u; }
bool isSoil(uint m) { return m == 1u || m == 9u || m == 6u; }

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
 * The landscape as it was before anyone dug: sampled for open space, so a
 * tunnel shows the earth it was cut through rather than a void.
 *
 * This is the single detail that most separates a dug tunnel from a hole in a
 * tile map, and it is how Clonk has always drawn its background material. A
 * natural cavern was already empty when the island was generated, so it has no
 * background and stays a dark opening - which means caves and tunnels read
 * differently without the simulation having to track the difference.
 */
vec3 backgroundColour(ivec2 c, float depth) {
  uint bm = texelFetch(uBg, c, 0).r;
  if (isVoid(bm)) return vec3(-1.0);
  // Deliberately cheap and low contrast: it sits behind everything, and the
  // detail of the full material shader would only fight the foreground.
  vec3 base = uPalette[bm];
  float n = fbm(vec2(c) * 0.10);
  // Well below the foreground: a tunnel has to read as a hole at a glance, and
  // it only does that if the wall behind it is clearly darker than the rock
  // around it.
  vec3 col = base * (0.36 + 0.16 * n);
  col = mix(vec3(dot(col, vec3(0.33, 0.5, 0.17))), col, 0.66);
  // Darker towards the middle of an opening, so tunnels have some depth.
  float away = 0.0;
  for (int k = 1; k <= 3; k++) {
    if (!isVoid(matAt(c + ivec2(0, -k)))) { away = 1.0 - float(k - 1) / 3.0; break; }
  }
  col *= 1.0 - 0.20 * away;
  return col;
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

float ridge(float x, float seed, float scale, float amp, float base) {
  float n = vnoise(vec2(x * scale, seed)) * 0.6 + vnoise(vec2(x * scale * 2.7, seed)) * 0.4;
  return base - n * amp;
}

vec3 sky(vec2 world, vec2 screen) {
  float horizon = clamp(world.y / uSea, 0.0, 1.0);
  vec3 col = mix(vec3(0.29, 0.56, 0.86), vec3(0.70, 0.84, 0.93), pow(horizon, 0.95));

  vec2 sunScreen = vec2(0.19, 0.13);
  float aspect = uView.x / max(uView.y, 1.0);
  vec2 d = (screen - sunScreen) * vec2(aspect, 1.0);
  float sd = length(d);
  col += vec3(1.0, 0.95, 0.78) * smoothstep(0.042, 0.026, sd);
  col += vec3(1.0, 0.88, 0.62) * 0.22 * smoothstep(0.20, 0.02, sd);

  float px1 = (uCam.x * 0.06 + screen.x * uView.x * 0.06) * 0.02;
  float r1 = ridge(px1, 3.7, 1.0, 0.16, 0.72);
  if (screen.y > r1) {
    float t = clamp((screen.y - r1) * 3.0, 0.0, 1.0);
    col = mix(col, mix(vec3(0.46, 0.54, 0.68), vec3(0.37, 0.45, 0.59), t), 0.85);
  }
  float px2 = (uCam.x * 0.14 + screen.x * uView.x * 0.14) * 0.02;
  float r2 = ridge(px2, 11.3, 1.4, 0.12, 0.84);
  if (screen.y > r2) {
    float t = clamp((screen.y - r2) * 3.0, 0.0, 1.0);
    col = mix(col, mix(vec3(0.33, 0.41, 0.51), vec3(0.26, 0.33, 0.42), t), 0.9);
  }

  // Two cloud layers with different drift, so the sky has depth.
  float far = fbm(vec2(screen.x * 3.4 + uCam.x * 0.0006 + uTime * 0.008, screen.y * 4.2));
  float near = fbm(vec2(screen.x * 1.9 + uCam.x * 0.0013 + uTime * 0.019, screen.y * 2.6 + 9.0));
  float fade = 1.0 - smoothstep(0.34, 0.68, screen.y);
  col = mix(col, vec3(0.93, 0.95, 0.98), smoothstep(0.60, 0.80, far) * 0.45 * fade);
  float body = smoothstep(0.56, 0.74, near);
  col = mix(col, vec3(1.0, 0.99, 0.97), body * 0.8 * fade);
  // A hint of shading on the underside, from the same sample shifted a little.
  float under = smoothstep(0.58, 0.76, near);
  col = mix(col, vec3(0.78, 0.82, 0.90), clamp(body - under, 0.0, 1.0) * 0.6 * fade);

  return col;
}

// --- material textures -----------------------------------------------------

/**
 * Colour for a material at a point. The w coordinate is continuous, not a cell
 * index, so the grain is finer than the grid the material lives on.
 */
vec3 material(uint m, ivec2 c, vec2 w) {
  vec3 base = uPalette[m];
  vec2 p = w;
  ivec2 fine = ivec2(floor(w * 3.0));
  float grain = hash1(fine);
  float n = fbm(p * 0.09);

  if (m == 1u || m == 9u) {
    // Earth: coarse loam. The granules are correlated blobs about a cell across
    // rather than independent per pixel - that is the difference between gravel
    // and television static, and it is what earth in Clonk actually looks like.
    vec3 col = base * (0.88 + 0.24 * n);
    col = mix(col, base * 0.66, smoothstep(0.58, 0.88, n));
    // Clods about four pixels across. The first version hashed at better than
    // one cell, which is not texture but static: at any real zoom it averages
    // back to flat brown and the earth stops reading as loose material.
    // Clods from interpolated noise rather than a hashed lattice. A hash on a
    // square grid is a checkerboard however you warp it, and earth made of
    // visible tiles is worse than earth made of static. Two octaves give a
    // lump about three cells across with finer crumb inside it.
    float clod = vnoise(w * 0.21);
    col *= 0.87 + 0.26 * clod;
    float grit = vnoise(w * 0.68 + 13.1);
    col *= 0.93 + 0.14 * grit;
    // Strata: shallow horizontal banding, warped so it is not ruler-straight.
    col *= 0.94 + 0.11 * sin(w.y * 0.30 + n * 7.0);
    // Stones, sparse and with a shaded underside so they sit in the soil.
    vec2 sc = w * 0.38;
    float pebble = hash1(ivec2(floor(sc)));
    if (pebble > 0.92) {
      vec2 f = fract(sc) - 0.5;
      float r = 0.18 + 0.14 * hash1(ivec2(floor(sc)) + ivec2(3, 7));
      float d = length(f);
      if (d < r) {
        vec3 stone = vec3(0.46, 0.42, 0.37) * (0.80 + 0.42 * hash1(ivec2(floor(sc)) + ivec2(9, 1)));
        // Lit from the upper left, dark at the lower right rim.
        stone *= 1.0 + 0.5 * clamp(-(f.x + f.y) / max(r, 0.001), -1.0, 1.0) * 0.5;
        col = mix(col, stone, 0.78);
      }
    }
    return col;
  }
  if (m == 2u || m == 8u || m == 5u || m == 4u) {
    // Rock family: quantised facets, cracks, and mineral specks.
    // Blocky facets with a clear step between them, so rock reads as broken
    // stone rather than as grey fog.
    float facetScale = (m == 8u) ? 0.115 : 0.165;
    vec2 q = p * facetScale;
    float f = floor(vnoise(q) * 5.0) / 5.0;
    float fx = floor(vnoise(q + vec2(0.5, 0.0)) * 5.0) / 5.0;
    vec3 col = base * (0.58 + 0.78 * f);
    // The step between neighbouring facets, which is what makes an edge read
    // as an edge rather than as a change of shade.
    col *= 1.0 + 0.30 * (f - fx);
    // A second, coarser break so the rock has structure at two scales and
    // does not tile visibly at the first one.
    float big = floor(vnoise(p * 0.052) * 3.0) / 3.0;
    col *= 0.88 + 0.26 * big;
    float chip = hash1(ivec2(floor(p * 1.4)));
    col *= 0.86 + 0.28 * chip;
    col *= 0.92 + 0.16 * grain;
    // Hairline cracks: high frequency and very thin, so they read as fracture
    // rather than as a pattern of outlines drawn over the rock.
    float crack = abs(vnoise(p * 0.21) - 0.5);
    if (crack < 0.010) col *= 0.62;
    if (m == 4u) {
      float veinMask = smoothstep(0.52, 0.72, fbm(p * 0.14));
      float speck = hash1(fine + ivec2(31, 17));
      if (speck > 0.84 - 0.16 * veinMask) {
        col = mix(col, vec3(0.74, 0.36, 0.16), 0.55 + 0.3 * veinMask);
      }
    } else if (m == 5u) {
      float veinMask = smoothstep(0.45, 0.70, fbm(p * 0.16));
      float nug = hash1(fine + ivec2(7, 91));
      if (nug > 0.83 - 0.20 * veinMask) {
        col = mix(col, vec3(1.0, 0.80, 0.24), 0.66 + 0.3 * veinMask);
        if (nug > 0.975) col = mix(col, vec3(1.0, 0.98, 0.80), 0.7);
      }
    }
    return col;
  }
  if (m == 3u) {
    // Coal: near black with glassy facets that catch the light.
    vec3 col = base * (0.70 + 0.75 * n);
    float shine = hash1(fine + ivec2(5, 3));
    if (shine > 0.972) col += vec3(0.34, 0.34, 0.40);
    else if (shine > 0.94) col += vec3(0.10, 0.10, 0.13);
    return col;
  }
  if (m == 6u) {
    // Sand: fine grain, gently banded.
    vec3 col = base * (0.90 + 0.16 * grain);
    col *= 0.94 + 0.10 * sin(w.y * 0.7 + n * 3.0);
    return col;
  }
  if (m == 11u) {
    // Wood: vertical grain, knots, bark edges.
    float g = sin(w.x * 3.1 + vnoise(p * 0.1) * 5.0) * 0.5 + 0.5;
    vec3 col = base * (0.76 + 0.42 * g);
    col *= 0.94 + 0.12 * grain;
    if (vnoise(p * 0.35) > 0.80) col *= 0.72;
    return col;
  }
  if (m == 12u) {
    // Leaves: distinct clusters rather than a green fog. Big clumps carry the
    // shape, a finer layer breaks up their edges, and the tops catch the sun.
    float clump = vnoise(p * 0.19);
    float fine = vnoise(p * 0.62);
    vec3 deep = base * 0.46;
    vec3 mid = base * 1.02;
    vec3 lit = mix(base * 1.45, vec3(0.66, 0.82, 0.34), 0.35);
    vec3 col = mix(deep, mid, smoothstep(0.30, 0.62, clump));
    col = mix(col, lit, smoothstep(0.60, 0.86, clump * 0.7 + fine * 0.3));
    col *= 0.92 + 0.16 * grain;
    // Gaps where the sky shows through the canopy.
    if (clump < 0.22) col *= 0.72;
    return col;
  }
  if (m == 13u) {
    // Loam: smooth packed clay, obviously placed rather than grown. It should
    // read as a thing a player built, not as another kind of dirt.
    float sw = vnoise(p * 0.14);
    vec3 col = base * (0.86 + 0.26 * sw);
    col *= 0.96 + 0.07 * grain;
    col *= 0.95 + 0.08 * sin(w.y * 0.8 + sw * 4.0);
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

/** Colour of the open air at a point: sky above the ground, cave below it. */
vec3 airColour(ivec2 c, float surf, float depth) {
  // Anything that was solid when the island was made shows through as
  // background material: this is the wall of a dug tunnel.
  vec3 bg = backgroundColour(c, depth);
  if (bg.r >= 0.0) return bg;

  // Goes dark within a few cells of the surface. Any slower and a freshly dug
  // pocket just below ground level glows with sky colour instead of reading as
  // the inside of a hole.
  float t = clamp((float(c.y) - surf) / 3.5, 0.0, 1.0);
  if (t < 1.0) return mix(sky(vWorld, vScreen), vec3(0.150, 0.122, 0.098), t);
  float n = fbm(vec2(c) * 0.07);
  vec3 col = mix(vec3(0.112, 0.090, 0.072), vec3(0.178, 0.146, 0.118), n);
  float over = 0.0;
  for (int k = 1; k <= 3; k++) {
    if (!isAir(matAt(c + ivec2(0, -k)))) { over = 1.0 - float(k - 1) / 3.0; break; }
  }
  return col * (1.0 - 0.28 * over);
}

/** Water, shaded by how deep below its own surface the pixel sits, and
 *  translucent over whatever is behind it. */
vec3 waterColour(ivec2 c, float depth) {
  int wd = 1;
  for (int k = 1; k <= 8; k++) {
    if (matAt(c + ivec2(0, -k)) != 7u) break;
    wd = k + 1;
  }
  float dnorm = clamp(float(wd) / 8.0, 0.0, 1.0);
  float wave = sin(vWorld.x * 0.14 + uTime * 1.6) * 0.5 + 0.5;
  float wave2 = sin(vWorld.x * 0.41 - uTime * 2.3) * 0.5 + 0.5;
  vec3 shallow = uPalette[7] * 1.26 + vec3(0.04, 0.09, 0.11);
  vec3 deepCol = uPalette[7] * 0.50;
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
  col *= 1.0 - 0.30 * depth;

  // See through it. A cell can only hold one material, so what is "behind" the
  // water is the landscape as it was before it was dug - which is exactly the
  // background layer.
  vec3 behind = backgroundColour(c, depth);
  if (behind.r >= 0.0) col = mix(behind * 0.75, col, 0.62);
  return col;
}

/** Fully shaded material colour, including relief and edge lighting. */
vec3 solidColour(uint m, ivec2 c, float surf, float depth, float cov, vec2 grad) {
  if (m == 7u) return waterColour(c, depth);
  vec3 col = material(m, c, vWorld);

  // Relief: treat the coverage gradient as a surface normal and light it. This
  // is what turns a cell grid into rock with shape, and it is why the
  // silhouette and the shading agree.
  float slope = length(grad);
  if (slope > 0.002) {
    vec3 nrm = normalize(vec3(-grad * 3.4, 1.0));
    vec3 L = normalize(vec3(-0.44, -0.82, 0.48));
    float diff = clamp(dot(nrm, L), 0.0, 1.0);
    col *= mix(1.0, 0.80 + 0.34 * diff, clamp(slope * 2.2, 0.0, 1.0));
  }
  col *= 0.96 + 0.05 * cov;

  // Cast shadow from the sun: trees shade the ground, hills shade their valleys.
  col *= 1.0 - 0.20 * sunShadow(c, surf);

  int up = 9;
  if (isAir(matAt(c + ivec2(0, -1)))) up = 1;
  else if (isAir(matAt(c + ivec2(0, -2)))) up = 2;
  int dn = 9;
  if (isAir(matAt(c + ivec2(0, 1)))) dn = 1;
  else if (isAir(matAt(c + ivec2(0, 2)))) dn = 2;
  if (up == 1) col *= 1.22;
  else if (up == 2) col *= 1.10;
  if (dn == 1) col *= 0.82;
  else if (dn == 2) col *= 0.92;

  // Grass on soil that meets the open air.
  if (isSoil(m) && up < 9 && float(c.y) < uSea - 2.0 && float(c.y) - surf < 3.0) {
    float sub = floor(vWorld.x * 2.0);
    float reach = 1.6 + 1.8 * hash1(ivec2(int(sub), 23));
    if (float(up) <= reach) {
      vec3 grass = mix(vec3(0.24, 0.44, 0.16), vec3(0.46, 0.70, 0.27), hash1(ivec2(floor(vWorld * 2.0))));
      col = mix(col, grass, clamp(1.3 - (float(up) - 1.0) * 0.42, 0.0, 1.0));
    }
  }

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
    // Grass blades standing up into the air above soil.
    int gd = 0;
    if (float(c.y) > surf - 8.0 && float(c.y) < surf + 6.0 && float(c.y) < uSea - 2.0) {
      for (int k = 1; k <= 4; k++) {
        uint b = matAt(c + ivec2(0, k));
        if (isSoil(b)) { gd = k; break; }
        if (!isAir(b)) break;
      }
    }
    if (gd > 0) {
      float sub = floor(vWorld.x * 2.0);
      float pick = hash1(ivec2(int(sub), 11));
      float h = 1.0 + 3.6 * hash1(ivec2(int(sub), 23));
      float sway = sin(uTime * 1.3 + sub * 0.7) * 0.35;
      if (pick > 0.30 && float(gd) <= h + sway) {
        float tip = clamp(1.0 - (h - float(gd)) / max(h, 1.0), 0.0, 1.0);
        col = mix(vec3(0.22, 0.42, 0.15), vec3(0.52, 0.76, 0.30), tip * 0.9 + 0.1 * hash1(ivec2(int(sub), 5)));
      }
    }
    if (float(c.y) <= surf) lit = false;
  } else {
    // In the transition band: blend sky against the nearest material, which is
    // what antialiases the outline.
    uint sm = isVoid(m) ? nearestSolid(c) : m;
    vec3 air = airColour(c, surf, depth);
    vec3 solid = sm == 0u ? air : solidColour(sm, c, surf, depth, cov, grad);
    col = mix(air, solid, fill);
  }

  if (lit) col *= 1.0 + lightAt(vWorld);

  oColor = vec4(col, 1.0);
}
`;

const MAX_CHUNK_UPLOADS = 768;
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
    gl.uniform2f(this.u.uGrid, GRID_W, GRID_H);
    gl.uniform1f(this.u.uSea, SEA_LEVEL);
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
