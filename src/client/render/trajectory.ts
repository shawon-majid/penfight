/**
 * The dotted line that shows where your pen is about to go.
 *
 * It is deliberately limited: it runs the *real* solver, but on a world
 * containing only your own pen, and only for a short while. So it shows you
 * honestly how spin will curve the shot — the thing that is hard to learn by
 * eye — without handing you the outcome of the whole rack.
 */

import { SIM_HZ, cloneWorld, findPen, step, type World } from '../../shared/physics/world';
import { vec, type Vec2 } from '../../shared/physics/vec2';
import type { Strike } from '../../shared/game/strike';
import { applyStrike } from '../../shared/game/strike';

/** How far ahead the guide looks. Long enough to read the curve, short enough to stay a hint. */
const PREVIEW_SECONDS = 0.55;

export function previewPath(
  world: World,
  strike: Strike,
  seconds = PREVIEW_SECONDS,
): Vec2[] {
  const solo = cloneWorld(world);
  // Everything else is removed, so the preview cannot reveal collisions.
  solo.pens = solo.pens.filter((pen) => pen.id === strike.penId);

  const pen = findPen(solo, strike.penId);
  if (!pen) return [];

  applyStrike(solo, strike);

  const points: Vec2[] = [vec(pen.x, pen.y)];
  const frames = Math.round(seconds * SIM_HZ);
  for (let frame = 0; frame < frames; frame++) {
    step(solo);
    points.push(vec(pen.x, pen.y));
    if (pen.state !== 'onTable') break;
  }
  return points;
}
