/**
 * The artwork for reactions and avatars.
 *
 * Thin champagne line drawings on dark glass, in the same hand as the table's
 * brass rim and the display's hairlines. Drawn here as SVG rather than taken
 * from an emoji font, so they look the same on every device and are ours.
 *
 * The markup is fixed strings from this file, never anything a player typed,
 * which is what makes it safe to hand to `innerHTML`.
 */

import { AVATAR_COUNT, REACTION_COUNT } from '../../shared/game/reactions';

const GOLD = '#d9c7a3';
const RED = '#f0786a';
const TEAR = '#8fc3ea';

const line = (paths: string, extra = '') =>
  `<g fill="none" stroke="${GOLD}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</g>${extra}`;
const FACE = '<circle cx="20" cy="20" r="15"/>';
const dot = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="1.3" fill="${GOLD}"/>`;

/** In the order they appear in the panel. The index is what goes over the wire. */
export const REACTIONS: ReadonlyArray<{ label: string; art: string }> = [
  {
    label: 'Ha',
    art: line(`${FACE}<path d="M12.5 17q2.5-3 5 0M22.5 17q2.5-3 5 0"/><path d="M12.5 23h15q-1 7-7.5 7t-7.5-7z" fill="rgba(217,199,163,.25)"/>`),
  },
  {
    label: 'Smug',
    art: line(`${FACE}<path d="M12.5 17.5h5M22.5 17.5h5M13 14.5l4.5-1M23 13.5l4.5 1M15 26q5 2 10-2.5"/>`),
  },
  {
    label: 'Cool',
    art: line(
      `${FACE}<path d="M24 26q-4 2.6-8 0"/>`,
      `<path d="M9.5 15h21v2q-.5 5-5 5h-1.5q-3 0-3-4q0 4-3 4h-1.5q-5 0-5-5z" fill="${GOLD}"/>`,
    ),
  },
  {
    label: 'Gasp',
    art: line(`${FACE}<circle cx="15" cy="17" r="2.6"/><circle cx="25" cy="17" r="2.6"/><ellipse cx="20" cy="26.5" rx="2.6" ry="3.4"/>`),
  },
  {
    label: 'Sob',
    art: line(
      `${FACE}<path d="M12.5 17q2.5 2.5 5 0M22.5 17q2.5 2.5 5 0M16 28q4-3.5 8 0"/>`,
      `<path d="M14.5 20v7M25.5 20v7" stroke="${TEAR}" stroke-width="1.8" stroke-linecap="round"/>`,
    ),
  },
  {
    label: 'Fume',
    art: line(
      `${FACE}<path d="M15.5 27.5q4.5-3 9 0"/>`,
      `${dot(15, 19)}${dot(25, 19)}<path d="M11.5 13.5l6 2.5M28.5 13.5l-6 2.5" stroke="${RED}" stroke-width="1.8" stroke-linecap="round"/>`,
    ),
  },
  {
    label: 'Dizzy',
    art: line(`${FACE}<path d="M13 17l4 4M17 17l-4 4M23 17l4 4M27 17l-4 4M13.5 27q1.6-1.6 3.2 0t3.2 0t3.2 0t3.2 0"/>`),
  },
  {
    label: 'Hurry up',
    art: line(
      `${FACE}<path d="M12.5 18h5M22.5 18h5"/><circle cx="20" cy="26" r="1.8"/>`,
      `<path d="M28 5h4l-4 4h4M33 1.5h2.6l-2.6 2.6h2.6" fill="none" stroke="${GOLD}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`,
    ),
  },
  {
    label: 'Phew',
    art: line(
      `${FACE}<path d="M14 26.5h12M17 24.5v4M20 24.5v4M23 24.5v4"/>`,
      `${dot(15, 18)}${dot(25, 18)}<path d="M31 8q-2.6 3.4 0 4.8q2.6-1.4 0-4.8z" fill="${TEAR}"/>`,
    ),
  },
  {
    label: 'Nice aim',
    art: line(
      '<circle cx="20" cy="20" r="14"/><circle cx="20" cy="20" r="8"/><path d="M20 3v6M20 31v6M3 20h6M31 20h6"/>',
      `<circle cx="20" cy="20" r="2.6" fill="${RED}"/>`,
    ),
  },
  {
    label: 'On fire',
    art: line(
      '<path d="M20 5q9 9 8 18q-.6 9-8 9t-8-9q0-6 5-9q0 5 3 6q-3-8 0-15z"/><path d="M20 21q4.5 4 3.5 7.5q-.8 2.5-3.5 2.5t-3.5-2.5q0-2.6 2.5-4"/>',
    ),
  },
  {
    label: 'Snapped',
    art: line(
      '<path d="M6 27l11-6.5M6 27l-1.5-2.5l11-6.5l1.5 2.5M8.5 22.5l2 3.4M23 20l11-6.5l-1.5-2.5l-11 6.5zM34 13.5l3-1.2"/><path d="M19 12l1 3M23 10.5l-.4 3.4M15.5 14l2.2 2"/>',
    ),
  },
];

/** Desk-and-writing emblems. The index is what is stored and sent. */
export const AVATARS: ReadonlyArray<{ label: string; art: string }> = [
  { label: 'Nib', art: '<path d="M16 4l7 10l-7 14l-7-14z"/><path d="M16 14v8"/><circle cx="16" cy="13" r="1.6"/>' },
  { label: 'Quill', art: '<path d="M24 4q-12 4-14 18l-3 6M24 4q2 12-11 17M12 16l5-1M11 20l5-1"/>' },
  { label: 'Inkwell', art: '<path d="M11 13h10v2q4 2 4 6v6H7v-6q0-4 4-6z"/><path d="M13 13V9h6v4M16 9V5"/>' },
  { label: 'Crown', art: '<path d="M6 24l-1-13l6 6l5-9l5 9l6-6l-1 13z"/><path d="M6 27h20"/>' },
  { label: 'Star', art: '<path d="M16 4l3.6 7.5l8.2 1.1l-6 5.8l1.5 8.2L16 22.7l-7.3 3.9l1.5-8.2l-6-5.8l8.2-1.1z"/>' },
  { label: 'Moon', art: '<path d="M21 5a11 11 0 1 0 6 18a9 9 0 0 1-6-18z"/>' },
  { label: 'Compass', art: '<circle cx="16" cy="16" r="11"/><path d="M16 8l3 8l-3 8l-3-8z"/><path d="M16 3v2M16 27v2M3 16h2M27 16h2"/>' },
  { label: 'Anchor', art: '<circle cx="16" cy="7" r="2.6"/><path d="M16 9.6V27M11 13h10M6 19q1 8 10 8t10-8M6 19l-1.5 2.5M26 19l1.5 2.5"/>' },
  { label: 'Key', art: '<circle cx="11" cy="11" r="5.5"/><path d="M15 15l11 11M21.5 21.5l3-3M24 24l3-3"/>' },
  { label: 'Bolt', art: '<path d="M18 3L8 18h7l-2 11l11-16h-7z"/>' },
  { label: 'Gem', art: '<path d="M8 6h16l5 7l-13 15L3 13z"/><path d="M3 13h26M12 6l-3 7l7 15l7-15l-3-7"/>' },
  { label: 'Shield', art: '<path d="M16 3l11 4v8q0 9-11 14q-11-5-11-14V7z"/><path d="M16 9v14M10 15h12"/>' },
];

if (REACTIONS.length !== REACTION_COUNT || AVATARS.length !== AVATAR_COUNT) {
  throw new Error('The reaction or avatar artwork is out of step with shared/game/reactions.ts.');
}

/**
 * @param ink redraws the champagne lines in another colour, for a reaction
 *   sitting on a champagne button rather than on dark glass.
 */
export function reactionSvg(index: number, ink?: string): string {
  const reaction = REACTIONS[index] ?? REACTIONS[0];
  const art = ink ? reaction.art.replaceAll(GOLD, ink) : reaction.art;
  return `<svg viewBox="0 0 40 40" aria-hidden="true">${art}</svg>`;
}

export function avatarSvg(index: number): string {
  const avatar = AVATARS[index] ?? AVATARS[0];
  return (
    `<svg viewBox="0 0 32 32" aria-hidden="true"><g fill="none" stroke="${GOLD}" stroke-width="1.6" ` +
    `stroke-linecap="round" stroke-linejoin="round">${avatar.art}</g></svg>`
  );
}
