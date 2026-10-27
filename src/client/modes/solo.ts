/**
 * Solo play: you against three bots, entirely in this tab.
 *
 * No server, no network, no account. The same `Match` the online game uses,
 * driven locally — which also makes this the place to test rule changes and
 * physics tuning without standing anything up.
 */

import type { BotDifficulty } from '../../shared/game/bots';
import { chooseBotStrike } from '../../shared/game/bots';
import type { Match, MatchPhase, PlayerSpec } from '../../shared/game/match';
import {
  createMatch,
  currentPlayer,
  randomFirstTurn,
  skipTurn,
  stepMatch,
  submitStrike,
} from '../../shared/game/match';
import {
  buildMatchRecord,
  createTally,
  recordEliminations,
  type MatchRecord,
  type ShotTally,
} from '../../shared/game/results';
import { isReaction } from '../../shared/game/reactions';
import { createRng, seedFromString, type Rng } from '../../shared/game/rng';
import { DEFAULT_TABLE } from '../../shared/physics/table';
import { DEFAULT_TUNING } from '../../shared/physics/tuning';
import type { Strike } from '../../shared/game/strike';
import type { WinTally } from '../../shared/net/protocol';
import { randomId } from '../random-id';
import {
  ChangeEmitter,
  NO_EVENTS,
  type FrameEvents,
  type ReactionListener,
  type Session,
} from './session';

/** A beat before a bot shoots, so a human can see whose turn it was. */
const BOT_THINKING_MS = 750;

const BOT_NAMES = ['Nib', 'Biro', 'Sharpie', 'Quill', 'Marker', 'Fineliner'];
/** Avatars for the bots, by seat: the nib for Nib, the quill for Quill, and so on. */
const BOT_AVATARS = [0, 2, 6, 1, 9, 11, 7];

export interface SoloOptions {
  playerName: string;
  botCount: number;
  difficulty: BotDifficulty;
  /** The pen colour the player picked, if any. The bots take what is left. */
  colourIndex?: number | null;
  /** The player's avatar. The bots take others. */
  avatar?: number;
  /** Called once when a match ends, with the whole match. */
  onFinished?: (record: MatchRecord) => void;
  /** Fix the seed to replay an identical match. Defaults to the clock. */
  seed?: number;
}

export const YOU = 'you';

export class SoloSession implements Session {
  readonly hostId = YOU;
  readonly youAre = YOU;
  notice: string | null = null;
  match: Match;
  /** Wins across rematches in this sitting. Gone when you leave the table. */
  readonly wins: WinTally = {};

  private readonly emitter = new ChangeEmitter();
  private readonly reactions = new ChangeEmitter<[string, number]>();
  private readonly options: SoloOptions;
  private rng: Rng;
  private tally: ShotTally = createTally();
  private startedAt = new Date();
  private botTimer: ReturnType<typeof setTimeout> | null = null;
  private botThinkingSince: number | null = null;
  private destroyed = false;

  constructor(options: SoloOptions) {
    this.options = options;
    this.rng = createRng(options.seed ?? seedFromString(String(Date.now())));
    this.match = this.buildMatch();
  }

  private buildMatch(): Match {
    this.tally = createTally();
    this.startedAt = new Date();
    const specs: PlayerSpec[] = [
      {
        id: YOU,
        name: this.options.playerName || 'You',
        colourIndex: this.options.colourIndex ?? undefined,
        avatar: this.options.avatar,
      },
    ];
    // Each bot keeps the same avatar every game, skipping whichever one is yours.
    const botAvatars = BOT_AVATARS.filter((avatar) => avatar !== this.options.avatar);
    for (let i = 0; i < this.options.botCount; i++) {
      specs.push({
        id: `bot-${i}`,
        name: BOT_NAMES[i % BOT_NAMES.length],
        isBot: true,
        avatar: botAvatars[i % botAvatars.length],
      });
    }
    // Drawn from the session's seeded generator, so a fixed seed still
    // replays an identical match, first player included.
    const firstTurnIndex = randomFirstTurn(specs.length, (n) => Math.floor(this.rng.next() * n));
    return createMatch('SOLO', specs, DEFAULT_TABLE, DEFAULT_TUNING, { firstTurnIndex });
  }

  tick(): FrameEvents {
    if (this.destroyed) return NO_EVENTS;

    if (this.match.phase === 'resolving') {
      // Read before stepping: the turn passes on the frame the table settles.
      const shooterId = currentPlayer(this.match)?.id;
      const result = stepMatch(this.match);
      if (shooterId) recordEliminations(this.tally, shooterId, result.eliminated);
      // Widened by hand: TypeScript does not know stepMatch can end the match.
      const phase = this.match.phase as MatchPhase;
      const { winnerId } = this.match;
      if (result.turnEnded && phase === 'finished') {
        if (winnerId) this.wins[winnerId] = (this.wins[winnerId] ?? 0) + 1;
        this.options.onFinished?.(
          buildMatchRecord(this.match, this.tally, {
            id: randomId(),
            mode: 'solo',
            difficulty: this.options.difficulty,
            startedAt: this.startedAt,
            endedAt: new Date(),
            // Solo games know nothing of accounts; the database files the
            // player's seat under whoever is signed in.
            accountIdOf: () => null,
          }),
        );
      }
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

  /** Nobody to send it to: it just shows over your pen. */
  react(reaction: number): void {
    if (!isReaction(reaction)) return;
    this.reactions.emit(YOU, reaction);
  }

  onReaction(listener: ReactionListener): () => void {
    return this.reactions.subscribe(listener);
  }

  onChange(listener: () => void): () => void {
    return this.emitter.subscribe(listener);
  }

  destroy(): void {
    this.destroyed = true;
    this.clearBotTimer();
    this.emitter.clear();
    this.reactions.clear();
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
