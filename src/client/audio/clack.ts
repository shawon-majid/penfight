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
 * so the audio context is created lazily on the first gesture.
 */

export class ClackAudio {
  private context: AudioContext | null = null;
  private muted = false;
  /** Stops a ten-pen pile-up turning into one loud smear. */
  private lastPlayedAt = 0;

  /** Call from a click or key press — anything the browser counts as a gesture. */
  unlock(): void {
    if (this.context) {
      void this.context.resume();
      return;
    }
    try {
      this.context = new AudioContext();
    } catch {
      // No audio available. The game is perfectly playable without it.
      this.muted = true;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /**
   * @param impulse Strength of the hit in kg*m/s, straight from the solver.
   */
  clack(impulse: number): void {
    const context = this.context;
    if (!context || this.muted || context.state !== 'running') return;

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

    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.15);
  }

  /** A softer, lower thud for a pen going over the edge. */
  thud(): void {
    const context = this.context;
    if (!context || this.muted || context.state !== 'running') return;

    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(180, now);
    oscillator.frequency.exponentialRampToValueAtTime(60, now + 0.22);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);

    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.32);
  }

  /** A quiet clock tick, once a second as a turn runs out. */
  tick(): void {
    const context = this.context;
    if (!context || this.muted || context.state !== 'running') return;

    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(1500, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.05, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);

    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.06);
  }
}
