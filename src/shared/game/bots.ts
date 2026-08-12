/**
 * Bots.
 *
 * The bot does not have a special physics model or any hidden knowledge. It
 * plays the game the way a person would think about it: line up a handful of
 * plausible shots, imagine each one, and take the one that looked best.
 *
 * "Imagine each one" is literal — it clones the world, applies the candidate
 * strike and runs the real solver to a standstill. That means the bot is
 * automatically correct about spin, rebounds and chain reactions, and it can
 * never drift out of step with the game as the physics is tuned.
 *
 * Difficulty is how many shots it gets to consider and how steady its hand is,
 * not a cheat.
 */

import { penCentre, type Pen } from '../physics/pen';
import { distanceToEdge } from '../physics/table';
import type { Vec2 } from '../physics/vec2';
import { normalize, scale, sub, vec } from '../physics/vec2';
import { cloneWorld, findPen, simulateUntilSettled, SIM_HZ } from '../physics/world';
import type { Match } from './match';
import { playerById } from './match';
import type { Rng } from './rng';
import type { Strike } from './strike';
import { applyStrike } from './strike';

export type BotDifficulty = 'easy' | 'normal' | 'hard';

interface BotProfile {
  /** How many shots the bot gets to try out in its head. */
  candidates: number;
  /** Aim error added to the shot it picked. radians */
  aimJitter: number;
  /** Power error, as a fraction of full power. */
  powerJitter: number;
  /** Error in where along the pen it actually connects. */
  contactJitter: number;
  /** How much it cares about not falling off itself. Higher is more cautious. */
  caution: number;
}

const PROFILES: Record<BotDifficulty, BotProfile> = {
  easy: { candidates: 4, aimJitter: 0.16, powerJitter: 0.22, contactJitter: 0.4, caution: 0.4 },
  normal: { candidates: 12, aimJitter: 0.06, powerJitter: 0.1, contactJitter: 0.18, caution: 1 },
  hard: { candidates: 24, aimJitter: 0.02, powerJitter: 0.04, contactJitter: 0.06, caution: 1.4 },
};

/** How long the bot is allowed to imagine one shot. 4s is past any real shot. */
const LOOKAHEAD_FRAMES = SIM_HZ * 4;

export interface BotDecision {
  strike: Strike;
  /** Score the bot expected. Exposed for debugging and for tests. */
  expectedScore: number;
}

/**
 * Choose a shot for a bot player. Returns null if the bot has no pen in play.
 */
export function chooseBotStrike(
  match: Match,
  playerId: string,
  rng: Rng,
  difficulty: BotDifficulty = 'normal',
): BotDecision | null {
  const player = playerById(match, playerId);
  if (!player || player.eliminated) return null;

  const myPen = findPen(match.world, player.penId);
  if (!myPen || myPen.state !== 'onTable') return null;

  const targets = match.world.pens.filter(
    (pen) => pen.state === 'onTable' && pen.ownerId !== playerId,
  );
  if (targets.length === 0) return null;

  const profile = PROFILES[difficulty];
  const candidates = buildCandidates(match, myPen, targets, profile, rng);

  let best: BotDecision | null = null;
  for (const strike of candidates) {
    const score = rateStrike(match, playerId, strike, difficulty);
    if (!best || score > best.expectedScore) {
      best = { strike, expectedScore: score };
    }
  }

  if (!best) return null;
  return { strike: addHumanError(best.strike, profile, rng), expectedScore: best.expectedScore };
}

/**
 * Propose shots worth thinking about.
 *
 * Each one lines up on a target pen and aims *through* it towards whichever
 * edge that pen is nearest — the same instinct a person has when they pick
 * which way to send someone. Variations in power and in where the flick lands
 * fill out the rest of the list.
 */
function buildCandidates(
  match: Match,
  myPen: Pen,
  targets: readonly Pen[],
  profile: BotProfile,
  rng: Rng,
): Strike[] {
  const strikes: Strike[] = [];
  const powers = [0.45, 0.7, 1];
  const contacts = [0, 0.55, -0.55];

  // Cycle target/power/contact combinations until the budget is used up, so
  // an easy bot still gets a spread of ideas rather than three shots at one pen.
  let index = 0;
  while (strikes.length < profile.candidates) {
    const target = targets[index % targets.length];
    const power = powers[Math.floor(index / targets.length) % powers.length];
    const contactAlong =
      contacts[Math.floor(index / (targets.length * powers.length)) % contacts.length];

    const direction = aimThrough(myPen, target, match.world.table);
    strikes.push({
      penId: myPen.id,
      contact: { along: contactAlong, across: 0 },
      direction,
      power,
    });

    index++;
    // Once every sensible combination is exhausted, jitter for more variety.
    if (index > targets.length * powers.length * contacts.length) {
      const last = strikes[strikes.length - 1];
      strikes[strikes.length - 1] = {
        ...last,
        direction: rotate(last.direction, rng.jitter(0.25)),
        power: Math.min(1, Math.max(0.2, last.power + rng.jitter(0.2))),
      };
    }
  }

  return strikes;
}

/**
 * Aim at the spot on the near side of `target` that will send it towards its
 * closest edge — pool's "ghost ball", with a pen instead of a ball.
 */
function aimThrough(myPen: Pen, target: Pen, table: { width: number; height: number }): Vec2 {
  const towardsEdge = nearestEdgeDirection(penCentre(target), table);
  const contactSpot = sub(penCentre(target), scale(towardsEdge, myPen.radius + target.radius));
  const aim = normalize(sub(contactSpot, penCentre(myPen)));
  // Degenerate overlap: just shove it straight at the edge.
  return aim.x === 0 && aim.y === 0 ? towardsEdge : aim;
}

/** Unit vector from a point towards the edge it is closest to. */
function nearestEdgeDirection(point: Vec2, table: { width: number; height: number }): Vec2 {
  const left = point.x + table.width / 2;
  const right = table.width / 2 - point.x;
  const bottom = point.y + table.height / 2;
  const top = table.height / 2 - point.y;
  const nearest = Math.min(left, right, bottom, top);

  if (nearest === left) return vec(-1, 0);
  if (nearest === right) return vec(1, 0);
  if (nearest === bottom) return vec(0, -1);
  return vec(0, 1);
}

function rotate(v: Vec2, radians: number): Vec2 {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return vec(v.x * cos - v.y * sin, v.x * sin + v.y * cos);
}

/**
 * Play a shot out in a copy of the world and say how much the bot liked it.
 *
 * Knocking someone off is worth far more than nudging them, and putting your
 * own pen off the table is a disaster — which is exactly the shape of the real
 * decision.
 *
 * Exported because it is the interesting half of the bot: swap this function
 * and you have a different personality (a spoiler that only defends, a bully
 * that goes for the leader) without touching the search around it.
 */
export function rateStrike(
  match: Match,
  playerId: string,
  strike: Strike,
  difficulty: BotDifficulty = 'normal',
): number {
  const profile = PROFILES[difficulty];
  const before = match.world;
  const after = cloneWorld(before);
  applyStrike(after, strike);
  simulateUntilSettled(after, LOOKAHEAD_FRAMES);

  let score = 0;

  for (const penBefore of before.pens) {
    if (penBefore.state !== 'onTable') continue;
    const penAfter = after.pens.find((candidate) => candidate.id === penBefore.id);
    if (!penAfter) continue;

    const mine = penBefore.ownerId === playerId;
    const wentOff = penAfter.state !== 'onTable';

    if (wentOff) {
      score += mine ? -1000 * profile.caution : 100;
      continue;
    }

    // Otherwise, credit progress towards (or away from) the edge.
    const edgeBefore = distanceToEdge(penCentre(penBefore), before.table);
    const edgeAfter = distanceToEdge(penCentre(penAfter), after.table);
    const gained = edgeBefore - edgeAfter;
    score += mine ? -gained * 30 * profile.caution : gained * 20;
  }

  return score;
}

/** Blur the chosen shot so bots miss the way people do. */
function addHumanError(strike: Strike, profile: BotProfile, rng: Rng): Strike {
  return {
    ...strike,
    direction: rotate(strike.direction, rng.jitter(profile.aimJitter)),
    power: Math.min(1, Math.max(0.05, strike.power + rng.jitter(profile.powerJitter))),
    contact: {
      along: Math.max(-1, Math.min(1, strike.contact.along + rng.jitter(profile.contactJitter))),
      across: strike.contact.across,
    },
  };
}
