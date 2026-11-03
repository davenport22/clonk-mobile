/**
 * One player's input for one tick. Six bytes on the wire, which is exactly the
 * budget PRD 6.4 assumed.
 *
 * The aim channel is separate from the stick on purpose. On a phone there is
 * only a thumb, so digging follows the movement stick (PRD 5.2). On a desktop
 * there is a mouse, and a mouse is a far better aiming device than a stick, so
 * it gets its own two bytes rather than fighting movement for the same ones.
 * Both travel through the relay identically, so a phone player and a desktop
 * player can share a round without the simulation caring which is which.
 */
export interface InputFrame {
  /** Stick, -64..64. */
  dx: number;
  dy: number;
  /** Aim direction, -64..64, or 0,0 when the player is not aiming. */
  ax: number;
  ay: number;
  buttons: number;
  /** Selected tool from the radial. */
  sel: number;
}

export const BTN = {
  ACTION: 1,
  ALT: 2,
  JUMP: 4,
  /** Explicit throw. The contextual action covers it on a phone, but a mouse
   *  player aiming at diggable ground would otherwise never be able to throw. */
  THROW: 8,
};

/**
 * The radial.
 *
 * PRD 5.2 budgeted four entries for a thumb. Six fit on the same quarter arc
 * once the slices are sized against the arc rather than guessed, and the game
 * genuinely has six things worth selecting. Everything else stays contextual:
 * the shovel hits, digs or throws depending on what is in front of it, and a
 * lorry is pushed by walking into it rather than by choosing a tool.
 */
export const TOOL = {
  SHOVEL: 0,
  LOAM: 1,
  DYNAMITE: 2,
  FOUNDRY: 3,
  ELEVATOR: 4,
  LORRY: 5,
};

export const TOOL_COUNT = 6;
export const INPUT_BYTES = 6;

export const NEUTRAL: InputFrame = { dx: 0, dy: 0, ax: 0, ay: 0, buttons: 0, sel: 0 };

export function makeInput(): InputFrame {
  return { dx: 0, dy: 0, ax: 0, ay: 0, buttons: 0, sel: 0 };
}

export function copyInput(src: InputFrame, dst: InputFrame): void {
  dst.dx = src.dx;
  dst.dy = src.dy;
  dst.ax = src.ax;
  dst.ay = src.ay;
  dst.buttons = src.buttons;
  dst.sel = src.sel;
}

export function writeInput(f: InputFrame, view: DataView, off: number): void {
  view.setInt8(off, f.dx);
  view.setInt8(off + 1, f.dy);
  view.setInt8(off + 2, f.ax);
  view.setInt8(off + 3, f.ay);
  view.setUint8(off + 4, f.buttons);
  view.setUint8(off + 5, f.sel);
}

export function readInput(view: DataView, off: number, out: InputFrame): InputFrame {
  out.dx = view.getInt8(off);
  out.dy = view.getInt8(off + 1);
  out.ax = view.getInt8(off + 2);
  out.ay = view.getInt8(off + 3);
  out.buttons = view.getUint8(off + 4);
  out.sel = view.getUint8(off + 5);
  return out;
}
