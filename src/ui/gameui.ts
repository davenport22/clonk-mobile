import { CHUNK_NAMES, CHUNK_SHORT } from '../data/materials';

/** Single-glyph stand-ins for the carried chunk, matching the atlas colours. */
const CHUNK_ICONS = ['⬛', '🟫', '🟨', '⬜', '🪵'];
import { TEAM_COLORS } from '../render/atlas';
import { TOOL } from '../sim/input';

/** Radial geometry, shared with the touch handler that positions the box. */
export const RADIAL_BOX = 300;
export const RADIAL_RADIUS = 118;

export const TOOL_META = [
  { icon: '⛏', label: 'Dig', tool: TOOL.SHOVEL },
  { icon: '🧱', label: 'Loam', tool: TOOL.LOAM },
  { icon: '🧨', label: 'Blast', tool: TOOL.DYNAMITE },
  { icon: '🏠', label: 'Foundry', tool: TOOL.FOUNDRY },
  { icon: '🛗', label: 'Lift', tool: TOOL.ELEVATOR },
  { icon: '🛒', label: 'Lorry', tool: TOOL.LORRY },
];

/** Builds and updates the in-game overlay. Plain DOM: nothing React-shaped
 *  belongs anywhere near the game loop (PRD 6.2). */
export class GameOverlay {
  root: HTMLDivElement;
  stick: HTMLDivElement;
  knob: HTMLDivElement;
  btnA: HTMLDivElement;
  btnB: HTMLDivElement;
  radial: HTMLDivElement;
  slices: HTMLDivElement[] = [];
  controls: HTMLDivElement;
  private timer: HTMLDivElement;
  private scores: HTMLDivElement;
  private stock: HTMLDivElement;
  private hintEl: HTMLDivElement;
  private netEl: HTMLDivElement;
  private debugEl: HTMLDivElement;
  private banner: HTMLDivElement;
  private energyFill: HTMLElement;
  private breathBar: HTMLElement;
  private breathFill: HTMLElement;
  private slotIcon: HTMLElement;
  private face: HTMLElement;
  private keysEl: HTMLElement;
  private hintTimer = 0;
  private crewSlots: HTMLElement;
  private crewHire: HTMLElement;
  private crewSig = '';
  onTake: (index: number) => void = () => {};
  onCall: () => void = () => {};
  onHire: () => void = () => {};

  constructor(parent: HTMLElement) {
    const root = document.createElement('div');
    root.className = 'screen';
    root.style.background = 'transparent';
    root.style.pointerEvents = 'none';
    root.style.padding = '0';
    root.innerHTML = `
      <div id="hud">
        <div class="hudbox" id="timer">15:00</div>
        <div class="hudbox" id="scores"></div>
        <div class="hudbox" id="stock"></div>
      </div>
      <div id="vitals">
        <div id="portrait"><span id="face"></span></div>
        <div id="bars">
          <div class="bar energy"><i id="energyFill"></i></div>
          <div class="bar breath" id="breathBar"><i id="breathFill"></i></div>
        </div>
        <div id="slot"><span id="slotIcon"></span></div>
      </div>
      <div id="crew">
        <div id="crewSlots"></div>
        <div class="crewbtn" id="crewCall" title="Call the crew (C)">Call</div>
        <div class="crewbtn" id="crewHire" title="Hire a worker for 1 gold (R)">+ Hire</div>
      </div>
      <div id="net"></div>
      <div id="hint"></div>
      <div id="debug"></div>
      <div id="controls">
        <div id="stick"><div id="knob"></div></div>
        <div class="btn" id="btnA">DIG</div>
        <div class="btn" id="btnB">TOOL</div>
        <div id="radial"></div>
      </div>
      <div id="keys">
        <span><b>WASD</b> move</span><span><b>Mouse</b> aim</span>
        <span><b>Click</b> use</span><span><b>1-4</b> tool</span>
        <span><b>G</b> throw</span><span><b>Wheel</b> zoom</span>
        <span><b>Tab</b> map</span><span><b>F</b> fullscreen</span>
        <span><b>X</b> next worker</span><span><b>Right click</b> send crew</span>
        <span><b>C</b> call crew</span><span><b>V</b> stop crew</span><span><b>R</b> hire</span>
      </div>
      <div id="banner"><div class="card" id="bannerCard"></div></div>
    `;
    parent.appendChild(root);
    this.root = root;

    this.stick = root.querySelector('#stick')!;
    this.knob = root.querySelector('#knob')!;
    this.btnA = root.querySelector('#btnA')!;
    this.btnB = root.querySelector('#btnB')!;
    this.radial = root.querySelector('#radial')!;
    this.controls = root.querySelector('#controls')!;
    this.timer = root.querySelector('#timer')!;
    this.scores = root.querySelector('#scores')!;
    this.stock = root.querySelector('#stock')!;
    this.hintEl = root.querySelector('#hint')!;
    this.netEl = root.querySelector('#net')!;
    this.debugEl = root.querySelector('#debug')!;
    this.banner = root.querySelector('#banner')!;
    this.energyFill = root.querySelector('#energyFill')!;
    this.breathBar = root.querySelector('#breathBar')!;
    this.breathFill = root.querySelector('#breathFill')!;
    this.slotIcon = root.querySelector('#slotIcon')!;
    this.face = root.querySelector('#face')!;
    this.keysEl = root.querySelector('#keys')!;
    this.crewSlots = root.querySelector('#crewSlots')!;
    this.crewHire = root.querySelector('#crewHire')!;
    const tap = (el: Element, fn: (ev: PointerEvent) => void) =>
      el.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        fn(ev as PointerEvent);
      });
    tap(this.crewSlots, (ev) => {
      const slot = (ev.target as HTMLElement).closest('[data-k]') as HTMLElement | null;
      if (slot) this.onTake(Number(slot.dataset.k));
    });
    tap(root.querySelector('#crewCall')!, () => this.onCall());
    tap(this.crewHire, () => this.onHire());

    for (let i = 0; i < TOOL_META.length; i++) {
      const s = document.createElement('div');
      s.className = 'slice';
      s.innerHTML = `<span class="ico">${TOOL_META[i].icon}</span>${TOOL_META[i].label}`;
      // An arc from below-left to above-right of the button that opens it,
      // spaced so six slices sit side by side without overlapping. Selection is
      // by nearest slice, so the geometry only has to be reachable by one thumb
      // without covering the action button.
      const ang = ((-205 + i * 27) * Math.PI) / 180;
      s.style.left = `${RADIAL_BOX / 2 + Math.cos(ang) * RADIAL_RADIUS}px`;
      s.style.top = `${RADIAL_BOX / 2 + Math.sin(ang) * RADIAL_RADIUS}px`;
      this.radial.appendChild(s);
      this.slices.push(s);
    }
  }

  setTimer(seconds: number): void {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    this.timer.textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  setScores(score: Int32Array, teamCount: number, goal: number, melee = false): void {
    const mark = melee ? '☠' : '';
    let html = '';
    for (let t = 0; t < teamCount; t++) {
      html +=
        `<div class="s"><span class="dot" style="background:${TEAM_COLORS[t]}"></span>` +
        `${mark}${score[t]}/${goal}</div>`;
    }
    this.scores.innerHTML = html;
  }

  setStock(stock: Int32Array, team: number): void {
    const base = team * CHUNK_NAMES.length;
    let html = '';
    for (let k = 0; k < CHUNK_NAMES.length; k++) {
      html += `<span>${CHUNK_SHORT[k]} <b>${stock[base + k]}</b></span>`;
    }
    this.stock.innerHTML = html;
  }

  /** Clonk-style vitals: portrait, energy, breath, and the one carried item. */
  setVitals(
    teamColor: string,
    hpPercent: number,
    breathPercent: number,
    carrying: number,
    dead: boolean,
  ): void {
    this.face.style.background = teamColor;
    this.energyFill.style.width = `${Math.max(0, Math.min(100, hpPercent))}%`;
    this.energyFill.style.background =
      hpPercent > 55 ? '#5fbf4a' : hpPercent > 25 ? '#e0b433' : '#d8453f';
    const showBreath = breathPercent < 99;
    this.breathBar.classList.toggle('hidden', !showBreath);
    this.breathFill.style.width = `${Math.max(0, Math.min(100, breathPercent))}%`;
    this.slotIcon.textContent = carrying >= 0 ? CHUNK_ICONS[carrying] : '';
    this.portraitDead(dead);
  }

  private portraitDead(dead: boolean): void {
    this.face.classList.toggle('dead', dead);
  }

  /**
   * The crew bar: one chip per worker, the steered one raised, each with a
   * health strip and a glyph for its standing order. Rebuilt only when what
   * it shows changes.
   */
  setCrew(color: string, members: Array<{ steered: boolean; hp: number; order: number }>, canHire: boolean): void {
    const glyph = ['', '→', '⛏', '⇠', '↩'];
    let sig = color + (canHire ? '1' : '0');
    for (const m of members) sig += `${m.steered ? 'S' : '-'}${Math.round(m.hp / 10)}${m.order}`;
    if (sig === this.crewSig) return;
    this.crewSig = sig;
    let html = '';
    members.forEach((m, k) => {
      html +=
        `<div class="crewchip${m.steered ? ' on' : ''}" data-k="${k}" style="--team:${color}">` +
        `<span class="o">${m.steered ? '★' : glyph[m.order] ?? ''}</span>` +
        `<i style="width:${Math.max(0, Math.min(100, m.hp))}%"></i></div>`;
    });
    this.crewSlots.innerHTML = html;
    this.crewHire.classList.toggle('no', !canHire);
  }

  setToolAvailability(available: boolean[]): void {
    for (let i = 0; i < this.slices.length; i++) {
      this.slices[i].classList.toggle('no', !available[i]);
    }
  }

  /** Shows the desktop key legend. Hidden on touch, where it is noise. */
  showKeys(on: boolean): void {
    this.keysEl.classList.toggle('show', on);
  }

  hint(text: string, ms = 2600): void {
    this.hintEl.textContent = text;
    this.hintEl.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.hintEl.classList.remove('show'), ms);
  }

  net(text: string | null): void {
    if (text) {
      this.netEl.textContent = text;
      this.netEl.classList.add('show');
    } else {
      this.netEl.classList.remove('show');
    }
  }

  debug(text: string): void {
    this.debugEl.textContent = text;
  }

  showBanner(html: string): HTMLElement {
    const card = this.banner.querySelector('#bannerCard') as HTMLElement;
    card.innerHTML = html;
    this.banner.classList.add('show');
    return card;
  }

  hideBanner(): void {
    this.banner.classList.remove('show');
  }

  destroy(): void {
    clearTimeout(this.hintTimer);
    this.root.remove();
  }
}
