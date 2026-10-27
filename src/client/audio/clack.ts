/**
 * The clack.
 *
 * A pen hitting a pen is a short, bright, woody knock. It is synthesised
 * rather than sampled so there is nothing to download, and the pitch and
 * loudness follow the strength of the hit — a graze ticks, a full-power strike
 * cracks. That feedback does real work: it tells you how much of your shot
 * actually went into the other pen.
 *
 * Browsers refuse to make noise until the user has interacted with the page,
 * so the audio context is created lazily on the first gesture. Phones are
 * stricter than desktops about what counts: on mobile Chrome a touch
 * `pointerdown` is not a gesture at all (only the lift is), and iOS suspends
 * the context again whenever the page is backgrounded or a call comes in. So
 * rather than unlocking once, every gesture gets another go until the context
 * is actually running.
 */

type AudioContextConstructor = typeof AudioContext;

/** The gestures browsers accept as permission to play sound, between them. */
const UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;

export class ClackAudio {
  private context: AudioContext | null = null;
  /** Everything goes through here, so phone speakers get a little more level. */
  private output: GainNode | null = null;
  private muted = false;
  /** Stops a ten-pen pile-up turning into one loud smear. */
  private lastPlayedAt = 0;

  /**
   * Listen for gestures for the life of the page. Each one is a no-op once the
   * context is running, so leaving the listeners attached costs nothing.
   */
  install(target: Window = window): void {
    const unlock = () => this.unlock();
    for (const type of UNLOCK_EVENTS) {
      target.addEventListener(type, unlock, { capture: true, passive: true });
    }
    // Coming back to the tab: iOS leaves the context 'interrupted' until resumed.
    target.document.addEventListener('visibilitychange', () => {
      if (target.document.visibilityState === 'visible' && this.context) this.unlock();
    });
  }

  /** Call from a click or key press — anything the browser counts as a gesture. */
  unlock(): void {
    if (this.context) {
      if (this.context.state !== 'running') {
        void this.context.resume().catch(() => undefined);
        this.primeSilence(this.context);
      }
      return;
    }
    const Constructor: AudioContextConstructor | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
    if (!Constructor) {
      // No audio available. The game is perfectly playable without it.
      this.muted = true;
      return;
    }
    try {
      this.context = new Constructor();
    } catch {
      this.muted = true;
      return;
    }
    this.output = this.context.createGain();
    this.output.gain.value = 1.6;
    this.output.connect(this.context.destination);
    if (this.context.state !== 'running') void this.context.resume().catch(() => undefined);
    this.primeSilence(this.context);
  }

  /**
   * Older iOS only truly unlocks once something has been *played* inside the
   * gesture, so play a single silent sample.
   */
  private primeSilence(context: AudioContext): void {
    try {
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 1, 22050);
      source.connect(context.destination);
      source.start(0);
    } catch {
      // Harmless: the resume above is what matters on current browsers.
    }
  }

  /** A context ready to play into, or null — and if it was asleep, a nudge to wake it. */
  private ready(): { context: AudioContext; output: GainNode } | null {
    const context = this.context;
    const output = this.output;
    if (!context || !output || this.muted) return null;
    if (context.state !== 'running') {
      void context.resume().catch(() => undefined);
      return null;
    }
    return { context, output };
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /**
   * @param impulse Strength of the hit in kg*m/s, straight from the solver.
   */
  clack(impulse: number): void {
    const ready = this.ready();
    if (!ready) return;
    const { context, output } = ready;

    const now = context.currentTime;
    if (now - this.lastPlayedAt < 0.02) return;
    this.lastPlayedAt = now;

    // A full-power hit is around 0.03; scale that to a sensible range.
    const strength = Math.min(1, impulse / 0.02);
    if (strength < 0.04) return;

    const oscillator = context.createOscillator();
    const gain = context.createGain();

    // Harder hits ring slightly higher, the way a firmer knock does.
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(320 + strength * 340, now);
    oscillator.frequency.exponentialRampToValueAtTime(120, now + 0.09);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.05 + strength * 0.2, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);

    oscillator.connect(gain).connect(output);
    oscillator.start(now);
    oscillator.stop(now + 0.15);
  }

  /**
   * A softer, lower thud for a pen going over the edge. Kept above ~110 Hz:
   * anything lower simply does not come out of a phone speaker.
   */
  thud(): void {
    const ready = this.ready();
    if (!ready) return;
    const { context, output } = ready;

    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(260, now);
    oscillator.frequency.exponentialRampToValueAtTime(110, now + 0.22);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);

    oscillator.connect(gain).connect(output);
    oscillator.start(now);
    oscillator.stop(now + 0.32);
  }

  /** A quiet clock tick, once a second as a turn runs out. */
  tick(): void {
    const ready = this.ready();
    if (!ready) return;
    const { context, output } = ready;

    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(1500, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.05, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);

    oscillator.connect(gain).connect(output);
    oscillator.start(now);
    oscillator.stop(now + 0.06);
  }
}
