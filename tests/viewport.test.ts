import { describe, expect, it } from 'vitest';
import { DEFAULT_TABLE, tableBounds } from '../src/shared/physics/table';
import { cross, sub, vec } from '../src/shared/physics/vec2';
import {
  DEFAULT_MARGIN_METRES,
  fitViewport,
  toScreen,
  toScreenDirection,
  toWorld,
} from '../src/client/render/theme';

/**
 * The metres-to-pixels mapping. Pure maths with no canvas in it, which is why
 * it can be tested here.
 *
 * The case that matters is the quarter turn used on a phone held upright. It
 * has to keep the table inside the screen, keep the pointer mapping exact (or
 * you would grab a pen and the game would think you grabbed empty table), and
 * keep the same handedness, or pens would appear to spin backwards on phones.
 */

const PHONE_PORTRAIT = { width: 390, height: 844 };
const PHONE_LANDSCAPE = { width: 844, height: 390 };
const DESKTOP = { width: 1440, height: 900 };

describe('choosing an orientation', () => {
  it('leaves the table upright on a wide screen', () => {
    const viewport = fitViewport(DESKTOP.width, DESKTOP.height, DEFAULT_TABLE);
    expect(viewport.rotated).toBe(false);
  });

  it('turns the table on a phone held upright', () => {
    const viewport = fitViewport(PHONE_PORTRAIT.width, PHONE_PORTRAIT.height, DEFAULT_TABLE);
    expect(viewport.rotated).toBe(true);
  });

  it('leaves it upright on a phone held sideways', () => {
    const viewport = fitViewport(PHONE_LANDSCAPE.width, PHONE_LANDSCAPE.height, DEFAULT_TABLE);
    expect(viewport.rotated).toBe(false);
  });

  it('always picks whichever way round shows the table bigger', () => {
    for (const screen of [PHONE_PORTRAIT, PHONE_LANDSCAPE, DESKTOP, { width: 600, height: 600 }]) {
      const chosen = fitViewport(screen.width, screen.height, DEFAULT_TABLE);

      // Work out the scale the other way round and check it is not better.
      const worldWidth = DEFAULT_TABLE.width + DEFAULT_MARGIN_METRES * 2;
      const worldHeight = DEFAULT_TABLE.height + DEFAULT_MARGIN_METRES * 2;
      const upright = Math.min(screen.width / worldWidth, screen.height / worldHeight);
      const turned = Math.min(screen.width / worldHeight, screen.height / worldWidth);

      expect(chosen.scale).toBeCloseTo(Math.max(upright, turned), 8);
    }
  });

  it('makes the turn worth having on a phone', () => {
    const upright = fitViewport(PHONE_PORTRAIT.width, PHONE_PORTRAIT.height, {
      width: DEFAULT_TABLE.height,
      height: DEFAULT_TABLE.width,
    });
    const turned = fitViewport(PHONE_PORTRAIT.width, PHONE_PORTRAIT.height, DEFAULT_TABLE);
    // Same pixels either way — the point is the table is not squeezed into a
    // letterbox, so the scale matches what a portrait table would get.
    expect(turned.scale).toBeCloseTo(upright.scale, 8);
  });
});

describe.each([
  ['upright', DESKTOP],
  ['turned', PHONE_PORTRAIT],
])('the %s mapping', (_name, screen) => {
  const viewport = fitViewport(screen.width, screen.height, DEFAULT_TABLE);

  it('sends the middle of the table to the middle of the screen', () => {
    const centre = toScreen(viewport, vec(0, 0));
    expect(centre.x).toBeCloseTo(screen.width / 2, 8);
    expect(centre.y).toBeCloseTo(screen.height / 2, 8);
  });

  it('converts back and forth without drift', () => {
    for (const point of [vec(0.3, -0.2), vec(-0.71, 0.44), vec(0, 0.5), vec(0.8, 0)]) {
      const screenPoint = toScreen(viewport, point);
      const back = toWorld(viewport, screenPoint.x, screenPoint.y);
      expect(back.x).toBeCloseTo(point.x, 10);
      expect(back.y).toBeCloseTo(point.y, 10);
    }
  });

  it('keeps the whole table on screen', () => {
    const bounds = tableBounds(DEFAULT_TABLE);
    const corners = [
      toScreen(viewport, vec(bounds.minX, bounds.minY)),
      toScreen(viewport, vec(bounds.minX, bounds.maxY)),
      toScreen(viewport, vec(bounds.maxX, bounds.minY)),
      toScreen(viewport, vec(bounds.maxX, bounds.maxY)),
    ];

    for (const corner of corners) {
      expect(corner.x).toBeGreaterThanOrEqual(0);
      expect(corner.x).toBeLessThanOrEqual(screen.width);
      expect(corner.y).toBeGreaterThanOrEqual(0);
      expect(corner.y).toBeLessThanOrEqual(screen.height);
    }
  });

  it('agrees with itself about directions', () => {
    const from = vec(0.1, 0.2);
    const to = vec(0.5, -0.1);
    const worldDirection = sub(to, from);

    const screenFrom = toScreen(viewport, from);
    const screenTo = toScreen(viewport, to);
    const expected = sub(screenTo, screenFrom);
    const actual = toScreenDirection(viewport, worldDirection);

    // Directions are not scaled by the viewport, so compare shapes.
    expect(actual.x * viewport.scale).toBeCloseTo(expected.x, 8);
    expect(actual.y * viewport.scale).toBeCloseTo(expected.y, 8);
  });
});

describe('leaving room for the display', () => {
  it('centres the table in what is left, not in the whole screen', () => {
    const insets = { top: 120, right: 0, bottom: 40, left: 0 };
    const viewport = fitViewport(
      PHONE_PORTRAIT.width,
      PHONE_PORTRAIT.height,
      DEFAULT_TABLE,
      insets,
    );

    const availableHeight = PHONE_PORTRAIT.height - insets.top - insets.bottom;
    expect(viewport.centreY).toBeCloseTo(insets.top + availableHeight / 2, 8);
    expect(viewport.centreX).toBeCloseTo(PHONE_PORTRAIT.width / 2, 8);
  });

  it('keeps the table clear of the space the display asked for', () => {
    const insets = { top: 140, right: 0, bottom: 60, left: 0 };
    const viewport = fitViewport(
      PHONE_PORTRAIT.width,
      PHONE_PORTRAIT.height,
      DEFAULT_TABLE,
      insets,
    );

    const bounds = tableBounds(DEFAULT_TABLE);
    const tops = [
      toScreen(viewport, vec(bounds.minX, bounds.minY)),
      toScreen(viewport, vec(bounds.maxX, bounds.maxY)),
      toScreen(viewport, vec(bounds.minX, bounds.maxY)),
      toScreen(viewport, vec(bounds.maxX, bounds.minY)),
    ];

    for (const corner of tops) {
      expect(corner.y).toBeGreaterThanOrEqual(insets.top);
      expect(corner.y).toBeLessThanOrEqual(PHONE_PORTRAIT.height - insets.bottom);
    }
  });

  it('makes room on the side when the display is a column', () => {
    const insets = { top: 40, right: 0, bottom: 0, left: 200 };
    const viewport = fitViewport(844, 390, DEFAULT_TABLE, insets);

    const bounds = tableBounds(DEFAULT_TABLE);
    const leftEdge = Math.min(
      toScreen(viewport, vec(bounds.minX, bounds.minY)).x,
      toScreen(viewport, vec(bounds.minX, bounds.maxY)).x,
      toScreen(viewport, vec(bounds.maxX, bounds.minY)).x,
      toScreen(viewport, vec(bounds.maxX, bounds.maxY)).x,
    );
    expect(leftEdge).toBeGreaterThanOrEqual(insets.left);
  });

  it('refuses to let the display squeeze the table away entirely', () => {
    // A display claiming almost the whole screen: overlapping a little beats
    // having nothing to play on.
    const greedy = { top: 800, right: 300, bottom: 0, left: 0 };
    const viewport = fitViewport(390, 844, DEFAULT_TABLE, greedy);
    const unconstrained = fitViewport(390 / 2, 844 / 2, DEFAULT_TABLE);
    expect(viewport.scale).toBeCloseTo(unconstrained.scale, 8);
    expect(viewport.scale).toBeGreaterThan(0);
  });
});

describe('handedness', () => {
  it('turns the view without mirroring it, so spin reads the same way', () => {
    const upright = fitViewport(DESKTOP.width, DESKTOP.height, DEFAULT_TABLE);
    const turned = fitViewport(PHONE_PORTRAIT.width, PHONE_PORTRAIT.height, DEFAULT_TABLE);
    expect(upright.rotated).toBe(false);
    expect(turned.rotated).toBe(true);

    // Three points that wind one way in the world should wind the same way on
    // screen in both orientations. If one mirrored, the signs would differ and
    // a pen spinning clockwise on a laptop would look anticlockwise on a phone.
    const a = vec(0, 0);
    const b = vec(0.3, 0);
    const c = vec(0, 0.3);

    const windingOn = (viewport: ReturnType<typeof fitViewport>) => {
      const [sa, sb, sc] = [a, b, c].map((point) => toScreen(viewport, point));
      return Math.sign(cross(sub(sb, sa), sub(sc, sa)));
    };

    expect(windingOn(turned)).toBe(windingOn(upright));
  });
});
