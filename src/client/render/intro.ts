/**
 * The start of every game: the table settles under the lamp, the pens land on
 * it one after another, then 3 · 2 · 1 · Flick!
 *
 * Purely a matter of timing. The renderer asks it how far along each part is;
 * the app asks it when play may begin and which beats just passed, for sound.
 * Nothing here touches the match, so every player's table stays identical.
 */

import { clamp, easeOutBack, easeOutCubic } from './premium';

/** The table easing in. */
const SETTLE_SECONDS = 0.8;
/** First pen lands after this, the rest follow at this spacing, each taking this long to fall. */
const FIRST_PEN_SECONDS = 0.35;
const PEN_SPACING_SECONDS = 0.12;
const PEN_DROP_SECONDS = 0.45;
/** A breath between the last pen landing and the count. */
const BEFORE_COUNT_SECONDS = 0.25;
/** Each of 3, 2 and 1. */
const BEAT_SECONDS = 0.6;
/** How long "Flick!" stays up once play has begun. */
const FLICK_SECONDS = 0.7;

export type IntroBeat =
  | { kind: 'landed'; pen: number }
  | { kind: 'count'; value: 3 | 2 | 1 }
  | { kind: 'flick' };

export class IntroTimeline {
  readonly penCount: number;
  /** Seconds from the start at which the count begins, play opens, and it is all over. */
  readonly countAt: number;
  readonly flickAt: number;
  readonly endsAt: number;

  constructor(penCount: number, calm = false) {
    this.penCount = penCount;
    const lastLanding = FIRST_PEN_SECONDS + Math.max(0, penCount - 1) * PEN_SPACING_SECONDS + PEN_DROP_SECONDS;
    this.countAt = calm ? 0 : Math.max(SETTLE_SECONDS, lastLanding) + BEFORE_COUNT_SECONDS;
    this.flickAt = this.countAt + 3 * BEAT_SECONDS;
    this.endsAt = this.flickAt + FLICK_SECONDS;
  }

  /** 1.08 down to 1: the camera settling onto the table. */
  zoom(t: number): number {
    return 1.08 - 0.08 * easeOutCubic(clamp(t / SETTLE_SECONDS));
  }

  /** Darkness over the whole scene as it fades up from the room. */
  fadeIn(t: number): number {
    return clamp(1 - t / 0.4);
  }

  /** How high pen `index` still is (0 = on the table) and how visible. */
  pen(index: number, t: number): { lift: number; alpha: number } {
    const k = clamp((t - this.landingStart(index)) / PEN_DROP_SECONDS);
    return { lift: clamp(1 - easeOutBack(k), 0, 1.2), alpha: clamp(k * 3) };
  }

  /** What the big text in the middle says right now, and how far through its beat. */
  caption(t: number): { text: string; progress: number } | null {
    if (t < this.countAt || t >= this.endsAt) return null;
    if (t >= this.flickAt) {
      return { text: 'Flick!', progress: (t - this.flickAt) / FLICK_SECONDS };
    }
    const beat = Math.floor((t - this.countAt) / BEAT_SECONDS);
    return {
      text: String(3 - beat),
      progress: (t - this.countAt - beat * BEAT_SECONDS) / BEAT_SECONDS,
    };
  }

  /** Every beat that happened in (from, to] — pens landing, numbers, the flick. */
  beatsBetween(from: number, to: number): IntroBeat[] {
    const beats: IntroBeat[] = [];
    const passed = (at: number) => at > from && at <= to;
    for (let pen = 0; pen < this.penCount; pen++) {
      if (passed(this.landingStart(pen) + PEN_DROP_SECONDS)) beats.push({ kind: 'landed', pen });
    }
    for (let beat = 0; beat < 3; beat++) {
      if (passed(this.countAt + beat * BEAT_SECONDS)) {
        beats.push({ kind: 'count', value: (3 - beat) as 3 | 2 | 1 });
      }
    }
    if (passed(this.flickAt)) beats.push({ kind: 'flick' });
    return beats;
  }

  private landingStart(index: number): number {
    return FIRST_PEN_SECONDS + index * PEN_SPACING_SECONDS;
  }
}
