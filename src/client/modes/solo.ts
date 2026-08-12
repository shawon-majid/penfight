/**
 * Solo play: you against three bots, entirely in this tab.
 *
 * No server, no network, no account. The same `Match` the online game uses,
 * driven locally — which also makes this the place to test rule changes and
 * physics tuning without standing anything up.
 */

import type { BotDifficulty } from '../../shared/game/bots';
import { chooseBotStrike } from '../../shared/game/bots';
import type { Match, PlayerSpec } from '../../shared/game/match';
import {
  createMatch,
  currentPlayer,
  skipTurn,
  stepMatch,
  submitStrike,
} from '../../shared/game/match';
import { createRng, seedFromString, type Rng } from '../../shared/game/rng';
import type { Strike } from '../../shared/game/strike';
import { ChangeEmitter, NO_EVENTS, type FrameEvents, type Session } from './session';

/** A beat before a bot shoots, so a human can see whose turn it was. */
const BOT_THINKING_MS = 750;

const BOT_NAMES = ['Nib', 'Biro', 'Sharpie', 'Quill', 'Marker', 'Fineliner'];

export interface SoloOptions {
  playerName: string;
  botCount: number;
  difficulty: BotDifficulty;
  /** Fix the seed to replay an identical match. Defaults to the clock. */
  seed?: number;
}

export const YOU = 'you';

export class SoloSession implements Session {
  readonly hostId = YOU;
  readonly youAre = YOU;
  notice: string | null = null;
  match: Match;

  private readonly emitter = new ChangeEmitter();
  private readonly options: SoloOptions;
  private rng: Rng;
  private botTimer: ReturnType<typeof setTimeout> | null = null;
  private botThinkingSince: number | null = null;
  private destroyed = false;

  constructor(options: SoloOptions) {
    this.options = options;
    this.rng = createRng(options.seed ?? seedFromString(String(Date.now())));
    this.match = this.buildMatch();
  }

  private buildMatch(): Match {
    const specs: PlayerSpec[] = [{ id: YOU, name: this.options.playerName || 'You' }];
    for (let i = 0; i < this.options.botCount; i++) {
      specs.push({ id: `bot-${i}`, name: BOT_NAMES[i % BOT_NAMES.length], isBot: true });
    }
    return createMatch('SOLO', specs);
  }

  tick(): FrameEvents {
    if (this.destroyed) return NO_EVENTS;

    if (this.match.phase === 'resolving') {
      const result = stepMatch(this.match);
      if (result.turnEnded || result.eliminated.length > 0) this.emitter.emit();
      return result;
    }

    this.maybeStartBotTurn();
    return NO_EVENTS;
  }

  submitStrike(strike: Strike): void {
    const result = submitStrike(this.match, YOU, strike);
    if (result.ok) this.emitter.emit();
  }

  requestRematch(): void {
    this.clearBotTimer();
    this.rng = createRng(this.rng.next() * 0xffffffff);
    this.match = this.buildMatch();
    this.emitter.emit();
  }

  onChange(listener: () => void): () => void {
    return this.emitter.subscribe(listener);
  }

  destroy(): void {
    this.destroyed = true;
    this.clearBotTimer();
    this.emitter.clear();
  }

  /**
   * Bots think on a timer rather than inline, for two reasons: the pause is
   * readable, and the search runs after the browser has painted the new turn
   * instead of stalling the frame that reveals it.
   */
  private maybeStartBotTurn(): void {
    if (this.match.phase !== 'aiming' || this.botTimer) return;

    const onTurn = currentPlayer(this.match);
    if (!onTurn?.isBot) return;

    const turnAtScheduleTime = this.match.turnNumber;
    this.botThinkingSince = turnAtScheduleTime;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      this.botThinkingSince = null;
      // The table may have moved on while we waited (rematch, say).
      if (this.destroyed || this.match.turnNumber !== turnAtScheduleTime) return;
      if (this.match.phase !== 'aiming') return;

      const player = currentPlayer(this.match);
      if (!player?.isBot) return;

      const decision = chooseBotStrike(this.match, player.id, this.rng, this.options.difficulty);
      if (decision) {
        submitStrike(this.match, player.id, decision.strike);
      } else {
        // Nothing worth hitting — pass rather than stall the table.
        skipTurn(this.match);
      }
      this.emitter.emit();
    }, BOT_THINKING_MS);
  }

  /** True while a bot is lining up. The HUD shows a "thinking" hint. */
  get botIsThinking(): boolean {
    return this.botThinkingSince !== null;
  }

  private clearBotTimer(): void {
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = null;
    this.botThinkingSince = null;
  }
}
