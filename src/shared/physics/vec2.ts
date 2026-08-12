/**
 * Minimal 2D vector maths.
 *
 * Vectors are plain readonly objects so they are trivially JSON-serialisable
 * and safe to share across the network boundary. Every function is pure.
 */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

export const ZERO: Vec2 = vec(0, 0);

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** 2D cross product. Returns the scalar z-component of `a x b`. */
export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

/** Rotate `v` 90 degrees counter-clockwise. Used to build contact tangents. */
export function perp(v: Vec2): Vec2 {
  return { x: -v.y, y: v.x };
}

export function length(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

export function lengthSq(v: Vec2): number {
  return v.x * v.x + v.y * v.y;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Unit vector, or `ZERO` when the input has no meaningful direction. */
export function normalize(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y);
  return len > 1e-12 ? { x: v.x / len, y: v.y / len } : ZERO;
}

/** Direction unit vector for an angle in radians. */
export function fromAngle(radians: number): Vec2 {
  return { x: Math.cos(radians), y: Math.sin(radians) };
}

export function angleOf(v: Vec2): number {
  return Math.atan2(v.y, v.x);
}

export function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Clamp a vector's magnitude to `max`, preserving direction.
 * Returns the input untouched when it is already short enough.
 */
export function clampLength(v: Vec2, max: number): Vec2 {
  const len = Math.hypot(v.x, v.y);
  if (len <= max || len < 1e-12) return v;
  return { x: (v.x / len) * max, y: (v.y / len) * max };
}
