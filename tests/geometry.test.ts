import { describe, expect, it } from 'vitest';
import {
  closestPointOnSegment,
  closestPointsBetweenSegments,
} from '../src/shared/physics/geometry';
import { vec } from '../src/shared/physics/vec2';

/**
 * The whole narrow phase rests on this one routine, so it is worth pinning
 * down properly — including the awkward cases (parallel, degenerate) that only
 * show up once in a while but produce nonsense collisions when they are wrong.
 */
describe('closestPointsBetweenSegments', () => {
  it('finds the crossing point when two segments intersect', () => {
    const result = closestPointsBetweenSegments(
      vec(-1, 0),
      vec(1, 0),
      vec(0, -1),
      vec(0, 1),
    );
    expect(result.distance).toBeCloseTo(0, 10);
    expect(result.c1.x).toBeCloseTo(0, 10);
    expect(result.c1.y).toBeCloseTo(0, 10);
  });

  it('measures the gap between parallel segments', () => {
    const result = closestPointsBetweenSegments(
      vec(0, 0),
      vec(2, 0),
      vec(0, 0.5),
      vec(2, 0.5),
    );
    expect(result.distance).toBeCloseTo(0.5, 10);
  });

  it('clamps to endpoints when the segments do not overlap', () => {
    const result = closestPointsBetweenSegments(
      vec(0, 0),
      vec(1, 0),
      vec(3, 0),
      vec(4, 0),
    );
    expect(result.distance).toBeCloseTo(2, 10);
    expect(result.c1.x).toBeCloseTo(1, 10);
    expect(result.c2.x).toBeCloseTo(3, 10);
  });

  it('handles a segment that has collapsed to a point', () => {
    const result = closestPointsBetweenSegments(
      vec(5, 5),
      vec(5, 5),
      vec(0, 0),
      vec(10, 0),
    );
    expect(result.distance).toBeCloseTo(5, 10);
    expect(result.c2.x).toBeCloseTo(5, 10);
  });

  it('handles both segments collapsed to points', () => {
    const result = closestPointsBetweenSegments(vec(0, 0), vec(0, 0), vec(3, 4), vec(3, 4));
    expect(result.distance).toBeCloseTo(5, 10);
  });

  it('is symmetric in its arguments', () => {
    const a = closestPointsBetweenSegments(vec(-1, 0.2), vec(1, -0.3), vec(0.4, 1), vec(-0.2, -1));
    const b = closestPointsBetweenSegments(vec(0.4, 1), vec(-0.2, -1), vec(-1, 0.2), vec(1, -0.3));
    expect(a.distance).toBeCloseTo(b.distance, 10);
  });
});

describe('closestPointOnSegment', () => {
  it('projects onto the middle of the segment', () => {
    const point = closestPointOnSegment(vec(0.5, 3), vec(0, 0), vec(1, 0));
    expect(point.x).toBeCloseTo(0.5, 10);
    expect(point.y).toBeCloseTo(0, 10);
  });

  it('clamps past the end', () => {
    const point = closestPointOnSegment(vec(9, 1), vec(0, 0), vec(1, 0));
    expect(point.x).toBeCloseTo(1, 10);
  });
});
