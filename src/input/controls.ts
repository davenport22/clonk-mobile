import { BTN, TOOL_COUNT, makeInput, type InputFrame } from '../sim/input';
import { RADIAL_BOX, type GameOverlay } from '../ui/gameui';

const STICK_RADIUS = 46;

/**
 * Input for both targets, from one place.
 *
 * PRD 5.2 designs the phone scheme: a floating-origin thumb stick on the left,
 * one contextual action button on the right, and a press-and-drag radial with
 * four entries. That is the design target and it is what ships.
 *
 * Desktop is explicitly not a first-class target (PRD 2.3), but it is where the
 * game gets developed and where most people will first try a link, so it gets
 * real controls rather than the keyboard stub it started with: WASD to move, the
 * mouse to aim and dig, the wheel to zoom. The mouse feeds the aim channel of
 * the input frame, which is separate from the stick, so nothing about the touch
 * scheme changes to accommodate it.
 *
 * The two modes swap on whichever device the player last touched, so a laptop
 * with a touchscreen works either way.
 */
export class Controls {
  readonly frame: InputFrame = makeInput();
  onTactical: (on: boolean) => void = () => {};
  onToolChange: (tool: number) => void = () => {};
  onZoom: (delta: number) => void = () => {};

  /** True while the player is using a mouse and keyboard. */
  desktop = false;
  /** Cursor position in CSS pixels, for the caller to turn into a world aim. */
  cursorX = 0;
  cursorY = 0;
  hasCursor = false;

  private ui: GameOverlay;
  private stickId = -1;
  private stickOx = 0;
  private stickOy = 0;
  private radialId = -1;
  private radialCx = 0;
  private radialCy = 0;
  private radialSel = 0;
  private actionIds = new Set<number>();
  private activeTouches = 0;
  private tacticalOn = false;
  private lastTwoFinger = 0;
  private keys = new Set<string>();
  private mouseDown = false;
  private detach: Array<() => void> = [];

  constructor(ui: GameOverlay) {
    this.ui = ui;
    this.bind();
    this.selectTool(0);
  }

  private bind(): void {
    const el = this.ui.controls;
    const on = <T extends Event>(
      target: HTMLElement | Window,
      type: string,
      fn: (ev: T) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.detach.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };

    on<PointerEvent>(el, 'pointerdown', (ev) => this.down(ev));
    on<PointerEvent>(el, 'pointermove', (ev) => this.move(ev));
    on<PointerEvent>(el, 'pointerup', (ev) => this.up(ev));
    on<PointerEvent>(el, 'pointercancel', (ev) => this.up(ev));
    on<Event>(el, 'contextmenu', (ev) => ev.preventDefault());
    on<WheelEvent>(el, 'wheel', (ev) => this.wheel(ev), { passive: false });

    on<KeyboardEvent>(window, 'keydown', (ev) => this.key(ev, true));
    on<KeyboardEvent>(window, 'keyup', (ev) => this.key(ev, false));
    on<Event>(window, 'blur', () => this.releaseAll());
  }

  private setMode(desktop: boolean): void {
    if (this.desktop === desktop) return;
    this.desktop = desktop;
    this.ui.controls.classList.toggle('desktop', desktop);
    // Marks the whole document, so anything outside the game overlay - notably
    // the rotate-your-phone prompt - can react to what the player is actually
    // holding rather than to a media query's guess about the device.
    document.body.classList.toggle('using-mouse', desktop);
    if (desktop) {
      // Drop any half-finished touch gesture.
      this.stickId = -1;
      this.radialId = -1;
      this.ui.stick.classList.remove('on');
      this.ui.radial.classList.remove('on');
      this.frame.dx = 0;
      this.frame.dy = 0;
    } else {
      this.hasCursor = false;
      this.frame.ax = 0;
      this.frame.ay = 0;
    }
  }

  private releaseAll(): void {
    this.keys.clear();
    this.actionIds.clear();
    this.mouseDown = false;
    this.frame.dx = 0;
    this.frame.dy = 0;
    this.ui.btnA.classList.remove('down');
  }

  private isAction(ev: PointerEvent): boolean {
    return (ev.target as HTMLElement) === this.ui.btnA;
  }

  private isTool(ev: PointerEvent): boolean {
    return (ev.target as HTMLElement) === this.ui.btnB;
  }

  // --- pointer ---------------------------------------------------------------

  private down(ev: PointerEvent): void {
    if (ev.pointerType === 'mouse') {
      this.setMode(true);
      this.cursorX = ev.clientX;
      this.cursorY = ev.clientY;
      this.hasCursor = true;
      if (ev.button === 2) {
        // Right click cycles the tool: quicker than reaching for a number key.
        ev.preventDefault();
        this.selectTool((this.frame.sel + 1) % TOOL_COUNT);
        return;
      }
      if (ev.button === 0) {
        this.mouseDown = true;
        return;
      }
      return;
    }

    this.setMode(false);
    ev.preventDefault();
    this.activeTouches++;
    if (this.activeTouches >= 2) {
      const now = performance.now();
      if (now - this.lastTwoFinger > 400) {
        this.lastTwoFinger = now;
        this.tacticalOn = !this.tacticalOn;
        this.onTactical(this.tacticalOn);
      }
    }

    if (this.isAction(ev)) {
      this.actionIds.add(ev.pointerId);
      this.ui.btnA.classList.add('down');
      return;
    }
    if (this.isTool(ev)) {
      this.radialId = ev.pointerId;
      const r = this.ui.btnB.getBoundingClientRect();
      this.radialCx = r.left + r.width / 2;
      this.radialCy = r.top + r.height / 2;
      this.ui.radial.style.left = `${this.radialCx - RADIAL_BOX / 2}px`;
      this.ui.radial.style.top = `${this.radialCy - RADIAL_BOX / 2}px`;
      this.ui.radial.classList.add('on');
      this.ui.btnB.classList.add('down');
      this.radialSel = this.frame.sel;
      this.paintRadial();
      return;
    }
    if (this.stickId === -1 && ev.clientX < window.innerWidth * 0.62) {
      this.stickId = ev.pointerId;
      this.stickOx = ev.clientX;
      this.stickOy = ev.clientY;
      this.ui.stick.style.left = `${ev.clientX - 58}px`;
      this.ui.stick.style.top = `${ev.clientY - 58}px`;
      this.ui.stick.classList.add('on');
      this.setKnob(0, 0);
    }
  }

  private move(ev: PointerEvent): void {
    if (ev.pointerType === 'mouse') {
      this.setMode(true);
      this.cursorX = ev.clientX;
      this.cursorY = ev.clientY;
      this.hasCursor = true;
      return;
    }

    if (ev.pointerId === this.stickId) {
      let dx = ev.clientX - this.stickOx;
      let dy = ev.clientY - this.stickOy;
      const len = Math.hypot(dx, dy);
      if (len > STICK_RADIUS) {
        dx = (dx / len) * STICK_RADIUS;
        dy = (dy / len) * STICK_RADIUS;
        // Floating origin: drag past the edge and the stick centre follows.
        this.stickOx = ev.clientX - dx;
        this.stickOy = ev.clientY - dy;
        this.ui.stick.style.left = `${this.stickOx - 58}px`;
        this.ui.stick.style.top = `${this.stickOy - 58}px`;
      }
      this.setKnob(dx, dy);
      this.frame.dx = Math.round((dx / STICK_RADIUS) * 64);
      this.frame.dy = Math.round((dy / STICK_RADIUS) * 64);
      return;
    }

    if (ev.pointerId === this.radialId) {
      const dx = ev.clientX - this.radialCx;
      const dy = ev.clientY - this.radialCy;
      if (Math.hypot(dx, dy) > 26) {
        let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
        if (ang > 60) ang -= 360;
        // Slices run from -205 deg to -70 deg, 27 deg apart.
        const idx = Math.round((ang + 205) / 27);
        this.radialSel = Math.max(0, Math.min(TOOL_COUNT - 1, idx));
        this.paintRadial();
      }
    }
  }

  private up(ev: PointerEvent): void {
    if (ev.pointerType === 'mouse') {
      if (ev.button === 0) this.mouseDown = false;
      return;
    }
    this.activeTouches = Math.max(0, this.activeTouches - 1);
    if (ev.pointerId === this.stickId) {
      this.stickId = -1;
      this.frame.dx = 0;
      this.frame.dy = 0;
      this.setKnob(0, 0);
      this.ui.stick.classList.remove('on');
    }
    if (this.actionIds.has(ev.pointerId)) {
      this.actionIds.delete(ev.pointerId);
      if (this.actionIds.size === 0) this.ui.btnA.classList.remove('down');
    }
    if (ev.pointerId === this.radialId) {
      this.radialId = -1;
      this.ui.radial.classList.remove('on');
      this.ui.btnB.classList.remove('down');
      this.selectTool(this.radialSel);
    }
  }

  private wheel(ev: WheelEvent): void {
    ev.preventDefault();
    this.setMode(true);
    this.onZoom(ev.deltaY > 0 ? 1 : -1);
  }

  private setKnob(dx: number, dy: number): void {
    this.ui.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  private paintRadial(): void {
    for (let i = 0; i < this.ui.slices.length; i++) {
      this.ui.slices[i].classList.toggle('sel', i === this.radialSel);
    }
  }

  selectTool(tool: number): void {
    this.frame.sel = tool;
    this.radialSel = tool;
    this.paintRadial();
    const label = ['DIG', 'LOAM', 'BLAST', 'BUILD', 'LIFT', 'LORRY'];
    this.ui.btnA.textContent = label[tool] ?? 'USE';
    this.onToolChange(tool);
  }

  // --- keyboard --------------------------------------------------------------

  private key(ev: KeyboardEvent, down: boolean): void {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const k = ev.key.toLowerCase();
    if (down) this.setMode(true);
    if (down) this.keys.add(k);
    else this.keys.delete(k);

    if (down) {
      if (k >= '1' && k <= '6') this.selectTool(Number(k) - 1);
      if (k === 'q') this.selectTool((this.frame.sel + TOOL_COUNT - 1) % TOOL_COUNT);
      if (k === 'e') this.selectTool((this.frame.sel + 1) % TOOL_COUNT);
      if (k === 'tab') {
        ev.preventDefault();
        this.tacticalOn = !this.tacticalOn;
        this.onTactical(this.tacticalOn);
      }
      if (k === 'f') void toggleFullscreen();
      if (k === '+' || k === '=') this.onZoom(-1);
      if (k === '-') this.onZoom(1);
    }
    if (k === ' ' || k === 'tab') ev.preventDefault();

    const left = this.keys.has('a') || this.keys.has('arrowleft');
    const right = this.keys.has('d') || this.keys.has('arrowright');
    const up = this.keys.has('w') || this.keys.has('arrowup');
    const dn = this.keys.has('s') || this.keys.has('arrowdown');
    if (this.desktop) {
      this.frame.dx = (right ? 64 : 0) - (left ? 64 : 0);
      this.frame.dy = (dn ? 64 : 0) - (up ? 64 : 0);
    }
  }

  /** Assembles the frame handed to the simulation this tick. */
  devOverride: InputFrame | null = null;

  read(): InputFrame {
    if (this.devOverride) return this.devOverride;
    let buttons = 0;
    if (this.actionIds.size > 0 || this.mouseDown) buttons |= BTN.ACTION;
    if (this.radialId !== -1) buttons |= BTN.ALT;
    if (this.keys.has(' ')) buttons |= BTN.JUMP;
    if (this.keys.has('g') || this.keys.has('shift')) buttons |= BTN.THROW;
    this.frame.buttons = buttons;
    if (!this.desktop) {
      this.frame.ax = 0;
      this.frame.ay = 0;
    }
    return this.frame;
  }

  /** Sets the aim channel from a world-space direction. */
  setAim(dx: number, dy: number): void {
    const len = Math.hypot(dx, dy);
    if (len < 3) {
      this.frame.ax = 0;
      this.frame.ay = 0;
      return;
    }
    this.frame.ax = Math.max(-64, Math.min(64, Math.round((dx / len) * 64)));
    this.frame.ay = Math.max(-64, Math.min(64, Math.round((dy / len) * 64)));
  }

  destroy(): void {
    for (const fn of this.detach) fn();
    this.detach = [];
  }
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    // Blocked without a user gesture on some browsers; not fatal.
  }
}
