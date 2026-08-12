/**
 * Geometry helpers the collision pass needs.
 *
 * Kept apart from `collision.ts` because this is pure, easily-tested maths with
 * no notion of pens, impulses or tuning.
 */

import type { Vec2 } from './vec2';
import { clamp, dot, sub, vec } from './vec2';

export interface ClosestPoints {
  /** Parameter along the first segment, 0 at `p1` and 1 at `q1`. */
  s: number;
  /** Parameter along the second segment, 0 at `p2` and 1 at `q2`. */
  t: number;
  /** Closest point on the first segment. */
  c1: Vec2;
  /** Closest point on the second segment. */
  c2: Vec2;
  /** Distance between `c1` and `c2`. */
  distance: number;
}

/**
 * Closest pair of points between two line segments.
 *
 * Two capsules overlap exactly when their core segments are closer than the
 * sum of their radii, so this single routine is the whole narrow phase.
 *
 * Follows the standard clamped-parameter solution (Ericson, *Real-Time
 * Collision Detection*, §5.1.9), including the degenerate cases where one or
 * both segments collapse to a point.
 */
export function closestPointsBetweenSegments(
  p1: Vec2,
  q1: Vec2,
  p2: Vec2,
  q2: Vec2,
): ClosestPoints {
  const EPS = 1e-12;

  const d1 = sub(q1, p1); // direction and length of segment 1
  const d2 = sub(q2, p2); // direction and length of segment 2
  const r = sub(p1, p2);

  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);

  let s: number;
  let t: number;

  if (a <= EPS && e <= EPS) {
    // Both segments are points.
    s = 0;
    t = 0;
  } else if (a <= EPS) {
    // First segment is a point.
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = dot(d1, r);
    if (e <= EPS) {
      // Second segment is a point.
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;

      // Parallel segments give denom == 0; any s works, so pick the start.
      s = denom > EPS ? clamp((b * f - c * e) / denom, 0, 1) : 0;

      t = (b * s + f) / e;
      // t fell outside the segment: clamp it and re-solve for s.
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }

  const c1 = vec(p1.x + d1.x * s, p1.y + d1.y * s);
  const c2 = vec(p2.x + d2.x * t, p2.y + d2.y * t);
  return { s, t, c1, c2, distance: Math.hypot(c1.x - c2.x, c1.y - c2.y) };
}

/** Closest point to `point` on the segment `p`..`q`. */
export function closestPointOnSegment(point: Vec2, p: Vec2, q: Vec2): Vec2 {
  const d = sub(q, p);
  const lenSq = dot(d, d);
  if (lenSq <= 1e-12) return p;
  const t = clamp(dot(sub(point, p), d) / lenSq, 0, 1);
  return vec(p.x + d.x * t, p.y + d.y * t);
}
