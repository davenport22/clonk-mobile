/**
 * The worker: a small miner drawn from a jointed rig.
 *
 * Every frame is posed by joint angles - hips, knees, shoulders, elbows, a
 * torso lean and a head tilt - and drawn as rounded, shaded limbs at WS atlas
 * pixels per world pixel, then filtered down smoothly by the GPU. That is what
 * lets a figure fourteen world pixels tall have believable proportions, a
 * helmet with a lamp, a jacket with a reflective band, gloves and boots, and
 * still read cleanly at the zoom the game plays at.
 *
 * All original work: proportions are a person's, about six heads tall, not a
 * mascot's.
 */
import type { Rect } from './atlas';

/** Atlas pixels per world pixel for the worker. */
export const WS = 6;
/** Atlas cell for one worker frame, square. */
export const WCELL = 128;

/** Worker animation frames, in the order the renderer indexes them. */
export const WF = {
  IDLE: 0,
  IDLE2: 1,
  WALK1: 2,
  WALK2: 3,
  WALK3: 4,
  WALK4: 5,
  WALK5: 6,
  WALK6: 7,
  JUMP: 8,
  FALL: 9,
  DIG1: 10,
  DIG2: 11,
  DIG3: 12,
  CLIMB1: 13,
  CLIMB2: 14,
  SWIM1: 15,
  SWIM2: 16,
};
export const WORKER_FRAMES = 17;

/** Half the collision box height, world px: the feet sit this far below centre. */
const HALF_H = 5.5;

// Body measurements, world px.
const THIGH = 3.1;
const SHIN = 3.0;
const FOOT_H = 0.55;
const TORSO = 4.0;
const NECK = 0.55;
const HEAD_R = 1.3;
const UPPER_ARM = 2.4;
const FOREARM = 2.3;

interface Pose {
  /** Hip height offset from standing, world px (negative is up). */
  bob: number;
  /** Torso lean, radians, positive leans forward. */
  lean: number;
  /** Thigh and shin angles from straight down, radians; positive swings forward. */
  hipF: number;
  kneeF: number;
  hipB: number;
  kneeB: number;
  /** Upper arm and forearm angles from straight down, positive swings forward. */
  shF: number;
  elF: number;
  shB: number;
  elB: number;
  /** Head tilt, radians. */
  head: number;
  tool?: 'shovel';
  /** Shovel angle below horizontal, radians, gripped at the front hand. */
  ta?: number;
  /** Body rotated towards horizontal for swimming, radians. */
  roll?: number;
}

const D = Math.PI / 180;

const POSES: Pose[] = [];
POSES[WF.IDLE] = { bob: 0, lean: 2 * D, hipF: 4 * D, kneeF: 0, hipB: -4 * D, kneeB: 0, shF: 6 * D, elF: 14 * D, shB: -4 * D, elB: 10 * D, head: 0 };
POSES[WF.IDLE2] = { bob: 0.12, lean: 3 * D, hipF: 4 * D, kneeF: 2 * D, hipB: -4 * D, kneeB: 2 * D, shF: 8 * D, elF: 16 * D, shB: -2 * D, elB: 12 * D, head: 2 * D };

// A six-phase walk: contact, down, pass, up, contact, pass - mirrored halves.
const walk = (t: number): Pose => {
  const a = Math.sin(t * Math.PI * 2);
  const b = Math.sin(t * Math.PI * 2 + Math.PI);
  const kneeOf = (phase: number): number => -Math.max(0, Math.sin(phase * Math.PI * 2 + 0.9)) * 48 * D;
  return {
    bob: -Math.abs(Math.cos(t * Math.PI * 2)) * 0.35 + 0.18,
    lean: 6 * D,
    hipF: a * 28 * D,
    kneeF: a * 28 * D + kneeOf(t),
    hipB: b * 28 * D,
    kneeB: b * 28 * D + kneeOf(t + 0.5),
    shF: b * 30 * D,
    elF: b * 30 * D + 22 * D,
    shB: a * 30 * D,
    elB: a * 30 * D + 22 * D,
    head: 0,
  };
};
for (let i = 0; i < 6; i++) POSES[WF.WALK1 + i] = walk(i / 6);

POSES[WF.JUMP] = { bob: -0.3, lean: 8 * D, hipF: 40 * D, kneeF: -10 * D, hipB: -20 * D, kneeB: -70 * D, shF: 150 * D, elF: 170 * D, shB: -40 * D, elB: -10 * D, head: -4 * D };
POSES[WF.FALL] = { bob: 0, lean: -4 * D, hipF: 20 * D, kneeF: 0, hipB: -10 * D, kneeB: -30 * D, shF: 120 * D, elF: 140 * D, shB: 100 * D, elB: 130 * D, head: 4 * D };
// Digging: the shovel driven forward and down, levered, pulled back.
POSES[WF.DIG1] = { bob: 0.2, lean: 16 * D, hipF: 30 * D, kneeF: 4 * D, hipB: -14 * D, kneeB: -6 * D, shF: 55 * D, elF: 80 * D, shB: 10 * D, elB: 95 * D, head: 12 * D, tool: 'shovel', ta: 38 * D };
POSES[WF.DIG2] = { bob: 0.7, lean: 30 * D, hipF: 40 * D, kneeF: -14 * D, hipB: -8 * D, kneeB: -28 * D, shF: 30 * D, elF: 45 * D, shB: -10 * D, elB: 60 * D, head: 18 * D, tool: 'shovel', ta: 62 * D };
POSES[WF.DIG3] = { bob: 0.2, lean: 8 * D, hipF: 24 * D, kneeF: 0, hipB: -16 * D, kneeB: -8 * D, shF: 70 * D, elF: 100 * D, shB: 30 * D, elB: 120 * D, head: 4 * D, tool: 'shovel', ta: 18 * D };
// Climbing: facing the wall, hands reaching up alternately.
POSES[WF.CLIMB1] = { bob: 0, lean: 4 * D, hipF: 50 * D, kneeF: -20 * D, hipB: 10 * D, kneeB: -40 * D, shF: 170 * D, elF: 175 * D, shB: 110 * D, elB: 150 * D, head: -10 * D };
POSES[WF.CLIMB2] = { bob: 0, lean: 4 * D, hipF: 10 * D, kneeF: -40 * D, hipB: 50 * D, kneeB: -20 * D, shF: 110 * D, elF: 150 * D, shB: 170 * D, elB: 175 * D, head: -10 * D };
// Swimming: tipped forward, arms stroking, legs kicking.
POSES[WF.SWIM1] = { bob: 0, lean: 0, hipF: 20 * D, kneeF: 0, hipB: -20 * D, kneeB: -30 * D, shF: 160 * D, elF: 170 * D, shB: 20 * D, elB: 30 * D, head: -30 * D, roll: 55 * D };
POSES[WF.SWIM2] = { bob: 0, lean: 0, hipF: -20 * D, kneeF: -30 * D, hipB: 20 * D, kneeB: 0, shF: 40 * D, elF: 60 * D, shB: 140 * D, elB: 160 * D, head: -30 * D, roll: 55 * D };

// --- palette ----------------------------------------------------------------

const SKIN = '#e6b994';
const SKIN_DARK = '#b98a68';
const TROUSER = '#3c4350';
const TROUSER_DARK = '#272c35';
const BOOT = '#6b4a2e';
const BOOT_DARK = '#3d2a1a';
const GLOVE = '#c89a52';
const GLOVE_DARK = '#8e6a36';
const OUTLINE = 'rgba(18,14,12,0.92)';
const REFLECT = '#e8ecef';
const LAMP = '#fff4c8';

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number): number => Math.max(0, Math.min(255, Math.round(v * f)));
  const r = c((n >> 16) & 0xff);
  const g = c((n >> 8) & 0xff);
  const b = c(n & 0xff);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

type V = [number, number];

/** Point at distance len from p along an angle measured from straight down. */
function along(p: V, angle: number, len: number): V {
  return [p[0] + Math.sin(angle) * len, p[1] + Math.cos(angle) * len];
}

/**
 * A limb segment as a rounded capsule, shaded across its width: lit on the
 * side facing the light, darker on the far side.
 */
function capsule(g: CanvasRenderingContext2D, a: V, b: V, width: number, light: string, dark: string): void {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const gr = g.createLinearGradient(
    (a[0] + b[0]) / 2 - nx * width * 0.5,
    (a[1] + b[1]) / 2 - ny * width * 0.5,
    (a[0] + b[0]) / 2 + nx * width * 0.5,
    (a[1] + b[1]) / 2 + ny * width * 0.5,
  );
  gr.addColorStop(0, light);
  gr.addColorStop(1, dark);
  g.strokeStyle = gr;
  g.lineWidth = width;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(a[0], a[1]);
  g.lineTo(b[0], b[1]);
  g.stroke();
}

/** Draws one posed worker into ctx, in world px, feet centred at the origin. */
function drawFigure(g: CanvasRenderingContext2D, team: string, pose: Pose): void {
  const jacket = team;
  const jacketDark = shade(team, 0.62);
  const jacketLight = shade(team, 1.22);
  const helmet = shade(team, 1.1);

  g.save();
  if (pose.roll) {
    // Swim: pivot about the hips and tip forward.
    g.translate(0, -(THIGH + SHIN) * 0.6);
    g.rotate(pose.roll);
    g.translate(0, (THIGH + SHIN) * 0.6);
  }

  const hip: V = [0, -(THIGH + SHIN + FOOT_H) + pose.bob];
  const sh: V = [hip[0] + Math.sin(pose.lean) * TORSO, hip[1] - Math.cos(pose.lean) * TORSO];

  const leg = (hipA: number, kneeA: number, front: boolean): void => {
    const knee = along(hip, hipA, THIGH);
    const ankle = along(knee, kneeA, SHIN);
    const l = front ? TROUSER : TROUSER_DARK;
    const d = front ? TROUSER_DARK : shade(TROUSER_DARK, 0.8);
    capsule(g, hip, knee, 1.8, l, d);
    capsule(g, knee, ankle, 1.5, l, d);
    // Boot: a heel and a toe, pointing along the ground the way it faces.
    const toe: V = [ankle[0] + 1.25, ankle[1] + 0.25];
    const heel: V = [ankle[0] - 0.35, ankle[1] + 0.25];
    capsule(g, heel, toe, 1.1, front ? BOOT : BOOT_DARK, BOOT_DARK);
    capsule(g, [ankle[0], ankle[1] - 0.4], [ankle[0], ankle[1] + 0.2], 1.35, front ? BOOT : BOOT_DARK, BOOT_DARK);
  };

  const arm = (shA: number, elA: number, front: boolean): { hand: V; elbow: V } => {
    const s: V = [sh[0] + (front ? 0.25 : -0.25), sh[1] + 0.35];
    const elbow = along(s, shA, UPPER_ARM);
    const hand = along(elbow, elA, FOREARM);
    const l = front ? jacketLight : jacketDark;
    const d = front ? jacketDark : shade(jacketDark, 0.75);
    capsule(g, s, elbow, 1.35, l, d);
    capsule(g, elbow, hand, 1.15, l, d);
    // Glove.
    g.fillStyle = front ? GLOVE : GLOVE_DARK;
    g.beginPath();
    g.arc(hand[0], hand[1], 0.66, 0, Math.PI * 2);
    g.fill();
    return { hand, elbow };
  };

  // Back limbs first, darker, then torso, then front limbs.
  arm(pose.shB, pose.elB, false);
  leg(pose.hipB, pose.kneeB, false);

  // Torso: a tapered jacket, belt and reflective band.
  g.save();
  g.translate(hip[0], hip[1]);
  g.rotate(pose.lean);
  const tw = 3.0;
  const gr = g.createLinearGradient(-tw / 2, 0, tw / 2, 0);
  gr.addColorStop(0, jacketDark);
  gr.addColorStop(0.55, jacket);
  gr.addColorStop(1, jacketLight);
  g.fillStyle = gr;
  g.beginPath();
  g.moveTo(-tw * 0.5, 0.35);
  g.lineTo(tw * 0.5, 0.35);
  g.quadraticCurveTo(tw * 0.62, -TORSO * 0.6, tw * 0.48, -TORSO - 0.1);
  g.quadraticCurveTo(0, -TORSO - 0.55, -tw * 0.5, -TORSO - 0.1);
  g.quadraticCurveTo(-tw * 0.62, -TORSO * 0.6, -tw * 0.5, 0.35);
  g.fill();
  // Reflective band across the chest, and a belt with a buckle.
  g.fillStyle = REFLECT;
  g.fillRect(-tw * 0.55, -TORSO * 0.62, tw * 1.1, 0.42);
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(-tw * 0.55, -TORSO * 0.62 + 0.3, tw * 1.1, 0.12);
  g.fillStyle = '#2b2622';
  g.fillRect(-tw * 0.52, -0.25, tw * 1.04, 0.5);
  g.fillStyle = '#b89a52';
  g.fillRect(0.25, -0.22, 0.45, 0.44);
  g.restore();

  // Head: neck, face, helmet with brim and lamp.
  const neck = along(sh, Math.PI + pose.lean, NECK);
  const hc: V = [neck[0] + Math.sin(pose.lean + pose.head) * HEAD_R * 0.9, neck[1] - Math.cos(pose.lean + pose.head) * HEAD_R * 0.9];
  capsule(g, sh, neck, 0.85, SKIN, SKIN_DARK);
  g.save();
  g.translate(hc[0], hc[1]);
  g.rotate(pose.lean * 0.4 + pose.head);
  const face = g.createRadialGradient(0.45, -0.1, 0.1, 0, 0, HEAD_R * 1.15);
  face.addColorStop(0, '#f2cba8');
  face.addColorStop(1, SKIN_DARK);
  g.fillStyle = face;
  g.beginPath();
  g.ellipse(0.05, 0.1, HEAD_R * 0.92, HEAD_R, 0, 0, Math.PI * 2);
  g.fill();
  // Nose, eye, a hint of stubble along the jaw.
  g.fillStyle = SKIN_DARK;
  g.beginPath();
  g.ellipse(HEAD_R * 0.92, 0.15, 0.24, 0.3, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1d1712';
  g.beginPath();
  g.ellipse(0.5, -0.05, 0.14, 0.2, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(70,48,32,0.35)';
  g.beginPath();
  g.ellipse(0.2, 0.75, 0.75, 0.35, 0, 0, Math.PI * 2);
  g.fill();
  // Ear.
  g.fillStyle = SKIN_DARK;
  g.beginPath();
  g.ellipse(-0.35, 0.15, 0.22, 0.32, 0, 0, Math.PI * 2);
  g.fill();
  // Helmet: a dome with a brim, a highlight, and the lamp on its front.
  const hg = g.createLinearGradient(-1.2, -1.8, 1.0, -0.2);
  hg.addColorStop(0, shade(helmet, 1.25));
  hg.addColorStop(1, shade(helmet, 0.7));
  g.fillStyle = hg;
  g.beginPath();
  g.ellipse(0.05, -0.35, HEAD_R * 1.12, HEAD_R * 0.98, 0, Math.PI, Math.PI * 2);
  g.fill();
  g.fillRect(-HEAD_R * 1.05, -0.4, HEAD_R * 2.35, 0.38);
  g.fillStyle = 'rgba(255,255,255,0.45)';
  g.beginPath();
  g.ellipse(-0.2, -1.05, 0.5, 0.22, -0.3, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#3a3a3a';
  g.fillRect(HEAD_R * 0.75, -0.95, 0.5, 0.55);
  g.fillStyle = LAMP;
  g.fillRect(HEAD_R * 0.95, -0.88, 0.3, 0.4);
  g.restore();

  // Front leg and arm, and the shovel held in both hands.
  leg(pose.hipF, pose.kneeF, true);
  if (pose.tool === 'shovel') {
    // Shaft through both hands, blade beyond the front one.
    const fh = along(along([sh[0] + 0.25, sh[1] + 0.35], pose.shF, UPPER_ARM), pose.elF, FOREARM);
    const ux = Math.cos(pose.ta ?? 0.5);
    const uy = Math.sin(pose.ta ?? 0.5);
    const tail: V = [fh[0] - ux * 3.4, fh[1] - uy * 3.4];
    const neckS: V = [fh[0] + ux * 1.8, fh[1] + uy * 1.8];
    capsule(g, tail, neckS, 0.42, '#a87a46', '#6a4626');
    g.save();
    g.translate(neckS[0], neckS[1]);
    g.rotate(Math.atan2(uy, ux));
    const bg = g.createLinearGradient(0, -0.8, 0, 0.8);
    bg.addColorStop(0, '#dfe4ea');
    bg.addColorStop(1, '#7d8794');
    g.fillStyle = bg;
    g.beginPath();
    g.moveTo(0, -0.8);
    g.lineTo(1.9, -0.85);
    g.quadraticCurveTo(2.8, 0, 1.9, 0.85);
    g.lineTo(0, 0.8);
    g.closePath();
    g.fill();
    g.restore();
  }
  arm(pose.shF, pose.elF, true);
  g.restore();
}

/**
 * Renders one worker frame into the atlas at (ox, oy): the figure is drawn
 * once to a scratch canvas, then stamped onto the atlas over a dark, slightly
 * grown copy of its own silhouette, which is the outline.
 */
export function drawWorker(g: CanvasRenderingContext2D, ox: number, oy: number, team: string, frame: number): Rect {
  const scratch = document.createElement('canvas');
  scratch.width = WCELL;
  scratch.height = WCELL;
  const s = scratch.getContext('2d')!;
  s.imageSmoothingEnabled = true;
  s.save();
  // Feet at HALF_H below the cell centre, so the rect's centre is the entity's.
  s.translate(WCELL / 2, WCELL / 2 + HALF_H * WS);
  s.scale(WS, WS);
  drawFigure(s, team, POSES[frame] ?? POSES[WF.IDLE]);
  s.restore();

  const sil = document.createElement('canvas');
  sil.width = WCELL;
  sil.height = WCELL;
  const t = sil.getContext('2d')!;
  t.drawImage(scratch, 0, 0);
  t.globalCompositeOperation = 'source-in';
  t.fillStyle = OUTLINE;
  t.fillRect(0, 0, WCELL, WCELL);

  const r = 2;
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    g.drawImage(sil, ox + Math.round(Math.cos(a) * r), oy + Math.round(Math.sin(a) * r));
  }
  g.drawImage(scratch, ox, oy);
  return { x: ox, y: oy, w: WCELL, h: WCELL, s: WS };
}
