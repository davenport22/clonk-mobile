/**
 * Tiny synthesised sound bank. No audio files: nothing to license, nothing to
 * download, and the AudioContext is unlocked on the Join tap because iOS
 * refuses to start audio without a user gesture (PRD 6.7).
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private lastDig = 0;
  enabled = true;

  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
    this.ctx = ctx;
    this.master = master;

    const len = Math.floor(ctx.sampleRate * 0.3);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    void ctx.resume();
  }

  private tone(freq: number, dur: number, type: OscillatorType, gain: number, slide = 1): void {
    if (!this.enabled || !this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide !== 1) osc.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private thud(dur: number, freq: number, gain: number): void {
    if (!this.enabled || !this.ctx || !this.master || !this.noise) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(freq, t);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur);
  }

  dig(material = 1): void {
    const now = performance.now();
    if (now - this.lastDig < 70) return;
    this.lastDig = now;
    if (material === 11) {
      // Wood: a woody knock rather than a gritty scrape.
      this.tone(180 + Math.random() * 60, 0.09, 'triangle', 0.22, 0.6);
      this.thud(0.06, 1600, 0.25);
    } else if (material === 2 || material === 8) {
      this.thud(0.09, 2600 + Math.random() * 800, 0.42);
    } else {
      this.thud(0.11, 900 + Math.random() * 500, 0.5);
    }
  }

  /** Explosion: a body of low noise with a falling tone under it. */
  explode(): void {
    this.thud(0.85, 420, 1.0);
    this.tone(90, 0.55, 'sawtooth', 0.3, 0.35);
    setTimeout(() => this.thud(0.5, 900, 0.35), 40);
  }

  fuse(): void {
    this.tone(1400, 0.05, 'square', 0.05, 1.4);
  }

  hurt(): void {
    this.thud(0.09, 500, 0.4);
    this.tone(220, 0.1, 'square', 0.12, 0.7);
  }

  die(): void {
    [330, 262, 196, 147].forEach((f, i) =>
      setTimeout(() => this.tone(f, 0.22, 'triangle', 0.2), i * 90),
    );
  }

  /** Shovel on bone. Short, dry, unmistakable. */
  clang(): void {
    this.thud(0.07, 1800, 0.45);
    this.tone(320, 0.08, 'square', 0.16, 0.5);
  }

  load(): void {
    this.thud(0.07, 1200, 0.28);
  }

  place(): void {
    this.thud(0.14, 600, 0.35);
    this.tone(150, 0.12, 'triangle', 0.14, 1.3);
  }

  wreck(): void {
    this.thud(0.6, 700, 0.6);
    this.tone(130, 0.4, 'square', 0.16, 0.5);
  }

  deposit(): void {
    this.tone(660, 0.1, 'triangle', 0.3);
    setTimeout(() => this.tone(990, 0.16, 'triangle', 0.26), 70);
  }

  build(): void {
    this.tone(180, 0.22, 'square', 0.16, 1.6);
  }

  splash(): void {
    this.thud(0.24, 2400, 0.34);
  }

  deny(): void {
    this.tone(150, 0.12, 'sawtooth', 0.14, 0.6);
  }

  over(win: boolean): void {
    if (win) {
      [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, 0.24, 'triangle', 0.24), i * 110));
    } else {
      [440, 349, 262].forEach((f, i) => setTimeout(() => this.tone(f, 0.3, 'triangle', 0.2), i * 140));
    }
  }
}
