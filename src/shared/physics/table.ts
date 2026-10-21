/**
 * The table: a plain rectangle with nothing around it.
 *
 * There are no walls. That is the whole point of the game — the edge is the
 * hazard.
 */

import type { Pen } from './pen';
import { penCentreOfMass } from './pen';
import { vec, type Vec2 } from './vec2';

export interface Table {
  /** Long side of the table. m */
  width: number;
  /** Short side of the table. m */
  height: number;
}

/**
 * A desk you would actually play this on.
 *
 * Sized against `maxStrikeImpulse`, not picked for looks: it has to be big
 * enough that a clean hit does not kill from anywhere on the table, and small
 * enough that a full-power miss is genuinely dangerous. See the note on that
 * setting in `tuning.ts`.
 */
export const DEFAULT_TABLE: Table = { width: 1.6, height: 1 };

export interface TableBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The table is centred on the origin, so maths stays symmetric. */
export function tableBounds(table: Table): TableBounds {
  return {
    minX: -table.width / 2,
    maxX: table.width / 2,
    minY: -table.height / 2,
    maxY: table.height / 2,
  };
}

/**
 * A pen is falling once its centre of mass passes the edge.
 *
 * Overhanging by a little is fine — it is the balance point that decides,
 * which is what happens on a real table. A pen with a heavy cap can hang its
 * light end a long way over.
 */
export function isOverEdge(pen: Pen, table: Table): boolean {
  const b = tableBounds(table);
  const { x, y } = penCentreOfMass(pen);
  return x < b.minX || x > b.maxX || y < b.minY || y > b.maxY;
}

/** How close a point is to the nearest edge. Negative once it is past it. */
export function distanceToEdge(point: Vec2, table: Table): number {
  const b = tableBounds(table);
  return Math.min(
    point.x - b.minX,
    b.maxX - point.x,
    point.y - b.minY,
    b.maxY - point.y,
  );
}

/**
 * Starting positions for `count` pens.
 *
 * Pens are laid out evenly around an oval inside the table, each pointing at
 * the middle. Everyone starts the same distance from an edge and the same
 * distance from their neighbours, so nobody is handed a bad seat.
 */
export function startingPoses(
  count: number,
  table: Table,
): Array<{ position: Vec2; angle: number }> {
  const radiusX = table.width * 0.36;
  const radiusY = table.height * 0.34;
  const poses: Array<{ position: Vec2; angle: number }> = [];

  for (let i = 0; i < count; i++) {
    // Start at the left so a two-player game sits face to face across the table.
    const theta = Math.PI + (i / count) * Math.PI * 2;
    const position = vec(Math.cos(theta) * radiusX, Math.sin(theta) * radiusY);
    // Point inwards, towards the centre of the table.
    poses.push({ position, angle: Math.atan2(-position.y, -position.x) });
  }

  return poses;
}
