/**
 * Colours, and the mapping from table metres to screen pixels.
 *
 * The simulation is in metres. Nothing under `shared/` has any idea how big
 * the screen is; that conversion happens here and only here, which is why the
 * renderer can be swapped out without touching the game.
 */

import type { Table } from '../../shared/physics/table';
import { vec, type Vec2 } from '../../shared/physics/vec2';

export interface PlayerColour {
  /** Barrel of the pen. */
  body: string;
  /** Cap and clip — a darker shade of the barrel. */
  cap: string;
  /** Aim guides and the player's name in the list. */
  accent: string;
  name: string;
}

/**
 * Ten colours, one per seat, chosen to stay apart from each other on a wooden
 * table and to survive the most common form of colour blindness by pairing
 * hue differences with lightness differences.
 */
export const PLAYER_COLOURS: PlayerColour[] = [
  { body: '#e94f4f', cap: '#8f2020', accent: '#ff7b7b', name: 'Red' },
  { body: '#3f8fe0', cap: '#1d4a80', accent: '#79bcff', name: 'Blue' },
  { body: '#f0b429', cap: '#8a6410', accent: '#ffd166', name: 'Amber' },
  { body: '#43b581', cap: '#1d6a4a', accent: '#7fe0b4', name: 'Green' },
  { body: '#b06de0', cap: '#5f2f85', accent: '#d3a3f5', name: 'Violet' },
  { body: '#ff8b3d', cap: '#94441a', accent: '#ffb280', name: 'Orange' },
  { body: '#2fc4c4', cap: '#146464', accent: '#79ecec', name: 'Teal' },
  { body: '#ef6ba8', cap: '#8d2a5c', accent: '#ffa1cb', name: 'Pink' },
  { body: '#9aa7b4', cap: '#4d5866', accent: '#c8d3de', name: 'Steel' },
  { body: '#8fd14f', cap: '#4a7520', accent: '#c0ef8b', name: 'Lime' },
];

export function colourFor(index: number): PlayerColour {
  return PLAYER_COLOURS[index % PLAYER_COLOURS.length];
}

export const THEME = {
  room: '#15171c',
  roomEdge: '#0d0e12',
  tableTop: '#3f2f22',
  tableTopLight: '#5a4531',
  tableRim: '#241a12',
  tableShadow: 'rgba(0, 0, 0, 0.55)',
  penShadow: 'rgba(0, 0, 0, 0.35)',
  aimGuide: 'rgba(239, 236, 231, 0.82)',
  aimGuideFaint: 'rgba(239, 236, 231, 0.26)',
  danger: '#f0786a',
  text: '#f2efe9',
  textDim: 'rgba(242, 239, 233, 0.55)',
} as const;

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

export interface Viewport {
  /** Pixels per metre. */
  scale: number;
  /** Screen position of the table's centre. */
  centreX: number;
  centreY: number;
  /**
   * True when the table is drawn turned a quarter turn.
   *
   * The table is a landscape rectangle, and a phone held upright is not. Rather
   * than shrink the table to fit — which would leave it postage-stamp sized
   * with empty bands either side — we turn the *view*. The simulation is
   * untouched and every player is looking at the same table; it is just
   * oriented to whatever screen they happen to be holding.
   */
  rotated: boolean;
}

/**
 * Breathing room around the table, in metres.
 *
 * Enough that a pen tipping over the edge is still visible as it goes — it
 * shrinks and fades within its half-second fall, so it never needs the full
 * distance it would actually travel. Kept tight because on a phone this margin
 * is the only thing between the table and the edges of the screen.
 */
export const DEFAULT_MARGIN_METRES = 0.1;

/**
 * Screen space already spoken for by the heads-up display, in CSS pixels.
 *
 * The table is fitted into what is left rather than the whole canvas, so a
 * player's name chip can never end up sitting on top of a pen they are trying
 * to aim. Measured from the real elements rather than guessed from breakpoints,
 * so the layout and the table can never disagree.
 */
export interface ViewportInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: ViewportInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Fit the table into the space the display leaves, with room to spare around
 * it so a pen going over the edge is still visible as it goes.
 *
 * Tries the table both ways round and keeps whichever comes out bigger. On a
 * desktop that is always upright; on a phone held vertically it is turned.
 */
export function fitViewport(
  canvasWidth: number,
  canvasHeight: number,
  table: Table,
  insets: ViewportInsets = NO_INSETS,
  marginMetres = DEFAULT_MARGIN_METRES,
): Viewport {
  // Never let the display squeeze the table out entirely — on a very small
  // screen it is better to overlap a little than to have nothing to play on.
  const availableWidth = Math.max(canvasWidth * 0.5, canvasWidth - insets.left - insets.right);
  const availableHeight = Math.max(canvasHeight * 0.5, canvasHeight - insets.top - insets.bottom);

  const worldWidth = table.width + marginMetres * 2;
  const worldHeight = table.height + marginMetres * 2;

  const upright = Math.min(availableWidth / worldWidth, availableHeight / worldHeight);
  const turned = Math.min(availableWidth / worldHeight, availableHeight / worldWidth);
  const rotated = turned > upright;

  return {
    scale: rotated ? turned : upright,
    // Centre of what is left over, not centre of the screen.
    centreX: insets.left + availableWidth / 2,
    centreY: insets.top + availableHeight / 2,
    rotated,
  };
}

/**
 * Metres to pixels.
 *
 * Upright, the y axis flips so +y is up on screen as in the maths. Turned, the
 * table's long axis runs down the screen instead. Both are reflections of the
 * same handedness, so a pen spinning one way on one screen spins the same way
 * on the other.
 */
export function toScreen(viewport: Viewport, point: Vec2): Vec2 {
  const { scale, centreX, centreY } = viewport;
  return viewport.rotated
    ? vec(centreX + point.y * scale, centreY + point.x * scale)
    : vec(centreX + point.x * scale, centreY - point.y * scale);
}

/** Pixels back to metres — used to turn a pointer position into a grab point. */
export function toWorld(viewport: Viewport, screenX: number, screenY: number): Vec2 {
  const { scale, centreX, centreY } = viewport;
  return viewport.rotated
    ? vec((screenY - centreY) / scale, (screenX - centreX) / scale)
    : vec((screenX - centreX) / scale, (centreY - screenY) / scale);
}

/**
 * A world direction as a screen direction.
 *
 * Directions rotate like points but do not translate, so they need their own
 * conversion — used for the aim arrow, which points where the pen will go.
 */
export function toScreenDirection(viewport: Viewport, direction: Vec2): Vec2 {
  return viewport.rotated
    ? vec(direction.y, direction.x)
    : vec(direction.x, -direction.y);
}
