import { GOLD_TO_WIN_SOLO, MODE, MODE_NAMES } from '../data/config';
import { Game } from '../game/loop';
import { Relay, defaultRelayUrl } from '../net/client';
import type { PlayerInfo, ServerMsg } from '../net/protocol';
import { TEAM_COLORS } from '../render/atlas';
import { GameOverlay } from './gameui';

const ATTRIBUTION =
  'Inspired by the Clonk series by RedWolf Design. Not affiliated with or endorsed by RedWolf Design.';

function roomFromUrl(): string {
  const q = new URLSearchParams(location.search).get('r');
  if (q) return q.toUpperCase();
  const m = location.pathname.match(/\/r\/([A-Z0-9]{4,8})/i);
  return m ? m[1].toUpperCase() : '';
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

/**
 * True for a device whose primary input is a finger. iOS cannot be told to lock
 * orientation (PRD 6.7), so a portrait phone gets an overlay asking politely -
 * but a desktop window that happens to be tall must never be told to rotate a
 * phone it does not have.
 */
function isTouchFirst(): boolean {
  return (
    window.matchMedia('(pointer: coarse)').matches ||
    (navigator.maxTouchPoints ?? 0) > 1
  );
}

export class App {
  private canvas: HTMLCanvasElement;
  private root: HTMLElement;
  private screen: HTMLDivElement | null = null;
  private rotate: HTMLDivElement;
  private overlay: GameOverlay | null = null;
  private game: Game | null = null;
  private relay: Relay | null = null;
  private you = 0;
  private isHost = false;
  private roomCode = '';
  private players: PlayerInfo[] = [];
  private teamCount = 2;
  private mode: number = MODE.GOLD;
  private fillBots = true;
  private name: string;

  constructor(canvas: HTMLCanvasElement, root: HTMLElement) {
    this.canvas = canvas;
    this.root = root;
    this.name = localStorage.getItem('undermine.name') ?? '';

    this.rotate = document.createElement('div');
    this.rotate.id = 'rotate';
    this.rotate.innerHTML = '<div>Turn your phone sideways<br><span class="muted">Undermine plays in landscape</span></div>';
    root.appendChild(this.rotate);
    const checkOrientation = () => {
      const portrait = window.innerHeight > window.innerWidth * 1.05;
      const show = portrait && this.game !== null && isTouchFirst();
      this.rotate.classList.toggle('show', show);
    };
    window.addEventListener('resize', checkOrientation);
    window.addEventListener('orientationchange', checkOrientation);
    this.checkOrientation = checkOrientation;

    const code = roomFromUrl();
    if (code) this.showMenu(code);
    else this.showMenu('');
  }

  private checkOrientation: () => void;

  private mount(html: string): HTMLDivElement {
    this.screen?.remove();
    const el = document.createElement('div');
    el.className = 'screen';
    el.innerHTML = html;
    this.root.appendChild(el);
    this.screen = el;
    return el;
  }

  // --- menu ----------------------------------------------------------------

  showMenu(prefillCode: string, error = ''): void {
    this.teardownGame();
    const installHint =
      isIos() && !isStandalone()
        ? '<p class="muted">Tip: Share → Add to Home Screen for full screen and no browser bars.</p>'
        : isTouchFirst()
          ? ''
          : '<p class="muted">On a keyboard: <b>WASD</b> move, <b>mouse</b> aims, <b>click</b> digs,' +
            ' <b>1-4</b> pick a tool, <b>G</b> throws, <b>wheel</b> zooms, <b>Tab</b> is the map,' +
            ' <b>F</b> is fullscreen.</p>';
    const el = this.mount(`
      <div class="card">
        <h1>Undermine</h1>
        <div class="tag">Dig, build, sabotage. One round is a coffee break.</div>
        <input id="name" placeholder="Nickname" maxlength="16" value="${escapeHtml(this.name)}" />
        <button class="primary" id="solo">Play solo</button>
        <button id="host">Create a room</button>
        <div class="row">
          <input id="code" placeholder="ROOM CODE" maxlength="6" value="${escapeHtml(prefillCode)}"
                 autocapitalize="characters" autocomplete="off" spellcheck="false" />
          <button id="join">Join</button>
        </div>
        <div class="err" id="err">${escapeHtml(error)}</div>
        ${installHint}
        <details>
          <summary class="muted">Relay server</summary>
          <input id="relay" value="${escapeHtml(defaultRelayUrl())}" />
          <div class="muted">Run <code>npm run relay</code> for a local one.</div>
        </details>
        <p class="muted" style="margin-top:14px">${ATTRIBUTION}</p>
      </div>
    `);

    const nameEl = el.querySelector<HTMLInputElement>('#name')!;
    const codeEl = el.querySelector<HTMLInputElement>('#code')!;
    const relayEl = el.querySelector<HTMLInputElement>('#relay')!;
    const errEl = el.querySelector<HTMLDivElement>('#err')!;

    const persist = () => {
      this.name = nameEl.value.trim();
      localStorage.setItem('undermine.name', this.name);
      const url = relayEl.value.trim();
      if (url) localStorage.setItem('undermine.relay', url);
    };

    el.querySelector('#solo')!.addEventListener('click', () => {
      persist();
      this.startSolo();
    });
    el.querySelector('#host')!.addEventListener('click', () => {
      persist();
      void this.connectAndSend({ t: 'create', name: this.name || 'Host' }, errEl);
    });
    el.querySelector('#join')!.addEventListener('click', () => {
      persist();
      const code = codeEl.value.trim().toUpperCase();
      if (code.length < 4) {
        errEl.textContent = 'Enter the six character room code.';
        return;
      }
      void this.connectAndSend({ t: 'join', room: code, name: this.name || 'Player' }, errEl);
    });
    codeEl.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') el.querySelector<HTMLElement>('#join')!.click();
    });
  }

  // --- lobby ---------------------------------------------------------------

  private showLobby(): void {
    const link = `${location.origin}${location.pathname.replace(/index\.html$/, '')}?r=${this.roomCode}`;
    const el = this.mount(`
      <div class="card">
        <h1>Room ready</h1>
        <div class="tag">Send the link. No accounts, no downloads.</div>
        <div class="code">${this.roomCode}</div>
        <button id="share">Copy invite link</button>
        <ul class="players" id="list"></ul>
        <button id="teams">Teams: 2</button>
        <button id="mode">Mode: Gold Rush</button>
        <button id="bots">Fill empty slots with bots: on</button>
        <button class="primary" id="go">Start round</button>
        <button id="leave">Leave</button>
        <div class="err" id="err"></div>
      </div>
    `);

    el.querySelector('#share')!.addEventListener('click', async () => {
      const btn = el.querySelector<HTMLButtonElement>('#share')!;
      try {
        const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
        if (nav.share) await nav.share({ title: 'Undermine', text: 'Dig with me', url: link });
        else await navigator.clipboard.writeText(link);
        btn.textContent = 'Link copied';
      } catch {
        btn.textContent = link;
      }
    });
    el.querySelector('#teams')!.addEventListener('click', () => {
      this.teamCount = this.teamCount === 2 ? 4 : this.teamCount === 4 ? 1 : 2;
      this.renderLobby();
    });
    el.querySelector('#mode')!.addEventListener('click', () => {
      this.mode = this.mode === MODE.GOLD ? MODE.MELEE : MODE.GOLD;
      this.renderLobby();
    });
    el.querySelector('#bots')!.addEventListener('click', () => {
      this.fillBots = !this.fillBots;
      this.renderLobby();
    });
    el.querySelector('#go')!.addEventListener('click', () => {
      this.relay?.send({
        t: 'start',
        teamCount: this.teamCount,
        mode: this.mode,
        fillBots: this.fillBots,
      });
    });
    el.querySelector('#leave')!.addEventListener('click', () => {
      this.relay?.close();
      this.relay = null;
      this.showMenu('');
    });
    this.renderLobby();
  }

  private renderLobby(): void {
    if (!this.screen) return;
    const list = this.screen.querySelector('#list');
    const teams = this.screen.querySelector<HTMLButtonElement>('#teams');
    const modeBtn = this.screen.querySelector<HTMLButtonElement>('#mode');
    const botsBtn = this.screen.querySelector<HTMLButtonElement>('#bots');
    const go = this.screen.querySelector<HTMLButtonElement>('#go');
    if (!list || !teams || !go || !modeBtn || !botsBtn) return;

    modeBtn.textContent = `Mode: ${MODE_NAMES[this.mode]}`;
    modeBtn.disabled = !this.isHost;
    botsBtn.textContent = `Fill empty slots with bots: ${this.fillBots ? 'on' : 'off'}`;
    botsBtn.disabled = !this.isHost;

    list.innerHTML = this.players
      .map((p, i) => {
        const team = this.teamCount > 1 ? i % this.teamCount : 0;
        const you = p.id === this.you ? ' (you)' : '';
        const host = i === 0 ? ' · host' : '';
        return `<li><span class="dot" style="background:${TEAM_COLORS[team]}"></span>${escapeHtml(p.name)}${you}${host}</li>`;
      })
      .join('');

    teams.textContent =
      this.teamCount === 1 ? 'Teams: free-for-all' : `Teams: ${this.teamCount}`;
    teams.disabled = !this.isHost;
    go.disabled = !this.isHost;
    go.textContent = this.isHost
      ? this.players.length > 1
        ? `Start round (${this.players.length} players)`
        : 'Start round (solo in a room)'
      : 'Waiting for the host…';
  }

  // --- transitions ---------------------------------------------------------

  private async connectAndSend(
    msg: { t: 'create'; name: string } | { t: 'join'; room: string; name: string },
    errEl: HTMLElement,
  ): Promise<void> {
    errEl.textContent = 'Connecting…';
    this.relay?.close();
    const relay = new Relay(defaultRelayUrl(), {
      onControl: (m) => this.onControl(m),
      onBundle: (b) => this.gameLockstepPush(b),
      onSnapshot: (_tick, payload) => this.game?.applySnapshot(payload),
      onClose: (reason) => {
        if (this.game) this.showMenu('', `Disconnected: ${reason}`);
        else if (this.screen?.querySelector('#err')) {
          this.screen.querySelector('#err')!.textContent = `Disconnected: ${reason}`;
        }
      },
    });
    try {
      await relay.connect();
      this.relay = relay;
      relay.send(msg);
      errEl.textContent = '';
    } catch (err) {
      errEl.textContent = `${(err as Error).message}. Start the relay with \`npm run relay\`, or set the relay URL below.`;
    }
  }

  private gameLockstepPush(b: import('../net/protocol').Bundle): void {
    this.pendingBundles.push(b);
    this.flushBundles();
  }

  private pendingBundles: import('../net/protocol').Bundle[] = [];
  private bundleSink: ((b: import('../net/protocol').Bundle) => void) | null = null;

  private flushBundles(): void {
    if (!this.bundleSink) return;
    for (const b of this.pendingBundles) this.bundleSink(b);
    this.pendingBundles.length = 0;
  }

  private onControl(msg: ServerMsg): void {
    if (msg.t === 'joined') {
      this.roomCode = msg.room;
      this.you = msg.you;
      this.players = msg.players;
      this.isHost = msg.host === msg.you;
      history.replaceState(null, '', `?r=${msg.room}`);
      this.showLobby();
    } else if (msg.t === 'players') {
      this.players = msg.players;
      this.isHost = msg.host === this.you;
      this.renderLobby();
    } else if (msg.t === 'start') {
      this.you = msg.you;
      this.players = msg.players;
      this.isHost = msg.host === msg.you;
      this.teamCount = msg.teamCount;
      this.mode = msg.mode;
      // Bots occupy player slots, so the simulation's player count is the
      // length of the bot mask, not the number of people in the room.
      const bots = msg.bots ?? [];
      const count = Math.max(msg.players.length, bots.length);
      this.startOnline(msg.seed, count, msg.teamCount, msg.mode, bots);
    } else if (msg.t === 'error') {
      const err = this.screen?.querySelector('#err');
      if (err) err.textContent = msg.msg;
      else this.showMenu('', msg.msg);
    } else if (msg.t === 'ended') {
      this.showMenu('', msg.reason);
    } else {
      this.game?.handleControl(msg);
    }
  }

  /**
   * Solo is a real round against bots, not an empty island.
   *
   * PRD R9 is "nobody to play with", and the first thing anyone does with a
   * link is tap the single-player button to see what the game is. Dropping them
   * alone onto an island answers that question badly.
   */
  private startSolo(): void {
    this.relay?.close();
    this.relay = null;
    this.launch({
      seed: (Math.random() * 0x7fffffff) | 0,
      you: 0,
      playerCount: 4,
      teamCount: 2,
      goldToWin: GOLD_TO_WIN_SOLO,
      mode: this.mode,
      bots: [false, true, true, true],
      relay: null,
      isHost: true,
      onExit: () => this.showMenu(''),
    });
  }

  private startOnline(
    seed: number,
    playerCount: number,
    teamCount: number,
    mode: number,
    bots: boolean[],
  ): void {
    this.launch({
      seed,
      you: this.you,
      playerCount,
      teamCount,
      mode,
      bots,
      relay: this.relay,
      isHost: this.isHost,
      onExit: () => {
        this.relay?.close();
        this.relay = null;
        this.showMenu('');
      },
    });
  }

  private launch(opts: ConstructorParameters<typeof Game>[2]): void {
    this.screen?.remove();
    this.screen = null;
    this.teardownGame();
    this.overlay = new GameOverlay(this.root);
    try {
      this.game = new Game(this.canvas, this.overlay, opts);
    } catch (err) {
      this.overlay.destroy();
      this.overlay = null;
      this.showMenu('', (err as Error).message);
      return;
    }
    this.bundleSink = (b) => this.game?.pushBundle(b);
    this.flushBundles();
    this.game.start();
    this.checkOrientation();
    if (import.meta.env.DEV) {
      (window as unknown as { __undermine: unknown }).__undermine = {
        app: this,
        game: this.game,
        controls: this.game.devControls(),
      };
    }
  }

  private teardownGame(): void {
    this.game?.stop();
    this.game = null;
    this.overlay?.destroy();
    this.overlay = null;
    this.bundleSink = null;
    this.pendingBundles.length = 0;
    this.rotate.classList.remove('show');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
