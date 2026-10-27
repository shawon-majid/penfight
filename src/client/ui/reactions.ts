/**
 * Your dock, and the bubbles reactions make.
 *
 * The dock is you at the table: your avatar in a ring of your pen colour that
 * drains with your turn clock, what you are up to, and the reaction button
 * beside it. Bottom-left on a wide screen, a row under the table on a phone
 * held upright.
 *
 * Both sit over the canvas but under the heads-up display, so the results
 * card and the players panel always cover them rather than the other way
 * round. Neither touches the match — a reaction is a passing remark, not part
 * of the game.
 */

import type { Match } from '../../shared/game/match';
import { localToWorld } from '../../shared/physics/pen';
import { REACTION_COOLDOWN_MS } from '../../shared/game/reactions';
import type { TurnClock } from '../render/renderer';
import { colourFor, toScreen, type Viewport } from '../render/theme';
import { strikeablePen, type Session } from '../modes/session';
import { REACTIONS, avatarSvg, reactionSvg } from './glyphs';

/** A little over the server's limit, so network jitter never gets one dropped. */
const CLIENT_COOLDOWN_MS = REACTION_COOLDOWN_MS + 250;
/** Matches the `reaction-pop` animation in the stylesheet. */
const BUBBLE_MS = 2800;
/** The reactions' line colour on the champagne button, where gold would vanish. */
const ON_CHAMPAGNE = '#211a10';
/** The close mark on the open button, in the same line style as the reactions. */
const CLOSE_SVG =
  `<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M13 13l14 14M27 13L13 27" fill="none" ` +
  `stroke="${ON_CHAMPAGNE}" stroke-width="2" stroke-linecap="round"/></svg>`;
/** Set once someone has sent a reaction, after which the button stops calling for attention. */
const DISCOVERED_KEY = 'penfight.reacted';
/** Circumference of the clock ring: r = 24 in a 52-unit box. */
const RING = 2 * Math.PI * 24;
/** Space above and below the dock when it sits under the table. Matches the stylesheet. */
const DOCK_GAP_PX = 12;

export class PlayerDock {
  readonly root = document.createElement('div');
  private readonly face = document.createElement('span');
  private readonly clock: SVGCircleElement;
  private readonly name = document.createElement('span');
  private readonly status = document.createElement('span');
  private readonly button = document.createElement('button');
  private readonly panel = document.createElement('div');
  private readonly onPick: (reaction: number) => void;
  private open = false;
  private coolUntil = 0;
  private yourTurn = false;
  /** What the face last showed, so it is only redrawn when that changes. */
  private shownFace = '';
  private shownClock = '';

  constructor(host: HTMLElement, before: Element | null, onPick: (reaction: number) => void) {
    this.onPick = onPick;
    this.root.className = 'player-dock';
    this.root.hidden = true;

    const avatar = document.createElement('span');
    avatar.className = 'dock-avatar';
    avatar.innerHTML =
      '<svg viewBox="0 0 52 52" aria-hidden="true"><circle class="dock-track" cx="26" cy="26" r="24"/>' +
      `<circle class="dock-clock" cx="26" cy="26" r="24" stroke-dasharray="${RING}" transform="rotate(-90 26 26)"/></svg>`;
    this.clock = avatar.querySelector<SVGCircleElement>('.dock-clock')!;
    this.face.className = 'dock-face';
    avatar.append(this.face);

    const text = document.createElement('span');
    text.className = 'dock-text';
    this.name.className = 'dock-name';
    this.status.className = 'dock-status';
    text.append(this.name, this.status);

    this.button.type = 'button';
    this.button.className = 'reaction-button';
    this.button.setAttribute('aria-label', 'React');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.title = 'React';
    this.button.innerHTML = reactionSvg(0, ON_CHAMPAGNE);
    this.button.addEventListener('click', () => (this.open ? this.close() : this.show()));

    this.panel.className = 'reaction-panel';
    this.panel.hidden = true;
    this.panel.setAttribute('role', 'group');
    this.panel.setAttribute('aria-label', 'Reactions');
    for (const [index, reaction] of REACTIONS.entries()) {
      const choice = document.createElement('button');
      choice.type = 'button';
      choice.innerHTML = reactionSvg(index);
      choice.setAttribute('aria-label', reaction.label);
      choice.title = reaction.label;
      choice.addEventListener('click', () => this.pick(index));
      this.panel.append(choice);
    }

    this.root.append(this.panel, avatar, text, this.button);
    host.insertBefore(this.root, before);

    // A tap anywhere else, or Escape, puts the panel away.
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (this.open && !this.root.contains(event.target as Node)) this.close();
      },
      { capture: true },
    );
    document.addEventListener('keydown', (event) => {
      if (this.open && event.key === 'Escape') this.close();
    });
  }

  /**
   * After anything in the match changed. Spectators have no pen to react from
   * and no seat to show, so they get no dock. The panel is put away the moment
   * your turn arrives, so it is never over the table as you aim.
   */
  update(session: Session): void {
    const { match, youAre } = session;
    const you = match.players.find((player) => player.id === youAre);
    if (!you || match.phase === 'lobby') {
      this.hide();
      return;
    }
    if (this.root.hidden) {
      this.root.hidden = false;
      // Each new game, the button asks to be noticed until it has been used once.
      this.button.classList.toggle('is-calling', !discovered());
    }

    const yourTurn = strikeablePen(session) !== null;
    if (yourTurn && !this.yourTurn) this.close();
    this.yourTurn = yourTurn;

    this.root.style.setProperty('--ring', colourFor(you.colourIndex).body);
    const face = you.avatar === undefined ? `initial:${you.name}` : `avatar:${you.avatar}`;
    if (face !== this.shownFace) {
      this.shownFace = face;
      if (you.avatar === undefined) this.face.textContent = you.name.trim().charAt(0).toUpperCase() || '?';
      else this.face.innerHTML = avatarSvg(you.avatar);
    }
    this.name.textContent = you.name;
    this.status.textContent = you.eliminated
      ? 'Out'
      : yourTurn
        ? 'Your turn'
        : match.phase === 'finished'
          ? 'Game over'
          : 'Waiting';
    this.root.classList.toggle('is-turn', yourTurn);
    this.root.classList.toggle('is-out', you.eliminated);
  }

  /**
   * Every frame: drain the ring with your clock. Only your own turn shows
   * here; in solo, with no clock, the ring stays full while you are on.
   */
  tick(clock: TurnClock | null): void {
    const mine = this.yourTurn ? clock : null;
    const left = this.yourTurn ? (mine ? mine.fraction : 1) : 0;
    const key = `${left.toFixed(3)}${mine?.warning ? 'w' : ''}`;
    if (key === this.shownClock) return;
    this.shownClock = key;
    // Fixed decimals: a tiny remainder would print as "1e-7", which CSS rejects outright.
    this.clock.style.strokeDashoffset = (RING * (1 - left)).toFixed(2);
    this.root.classList.toggle('is-warning', mine?.warning ?? false);
  }

  /**
   * How much room to keep between the table and the notes at the bottom. Only
   * on a phone held upright, where the dock is a row under the table; on a wide
   * screen it sits in a corner and needs nothing.
   */
  spaceBelowTable(): number {
    if (this.root.hidden) return 0;
    // Asked of the stylesheet rather than mirrored from its breakpoint, so the two cannot drift.
    const underTable = getComputedStyle(this.root).getPropertyValue('--under-table').trim() === '1';
    return underTable ? this.root.offsetHeight + DOCK_GAP_PX * 2 : 0;
  }

  /** On a phone held upright the dock sits just under the table. */
  setTableBottom(pixels: number): void {
    const value = `${Math.round(pixels)}px`;
    if (this.root.style.getPropertyValue('--table-bottom') !== value) {
      this.root.style.setProperty('--table-bottom', value);
    }
  }

  hide(): void {
    this.close();
    this.root.hidden = true;
    this.yourTurn = false;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.panel.hidden = true;
    this.button.classList.remove('is-open');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.innerHTML = reactionSvg(0, ON_CHAMPAGNE);
  }

  private show(): void {
    this.open = true;
    this.panel.hidden = false;
    this.button.classList.add('is-open');
    this.button.classList.remove('is-calling');
    this.button.setAttribute('aria-expanded', 'true');
    this.button.innerHTML = CLOSE_SVG;
  }

  private pick(reaction: number): void {
    this.close();
    markDiscovered();
    const now = performance.now();
    if (now < this.coolUntil) return;
    this.coolUntil = now + CLIENT_COOLDOWN_MS;
    this.onPick(reaction);
  }
}

function discovered(): boolean {
  try {
    return localStorage.getItem(DISCOVERED_KEY) !== null;
  } catch {
    return false;
  }
}

function markDiscovered(): void {
  try {
    localStorage.setItem(DISCOVERED_KEY, '1');
  } catch {
    // Storage blocked: the button keeps pulsing at the start of each game. Harmless.
  }
}

interface Bubble {
  element: HTMLElement;
  playerId: string;
  shownAt: number;
}

/**
 * The bubbles over pens. Each follows its pen as it moves, so a reaction
 * fired mid-shot rides along with it. A player whose pen is gone gets theirs
 * over their name instead.
 */
export class ReactionBubbles {
  private readonly host: HTMLElement;
  private readonly before: Element | null;
  private readonly bubbles = new Map<string, Bubble>();

  constructor(host: HTMLElement, before: Element | null) {
    this.host = host;
    this.before = before;
  }

  show(match: Match, playerId: string, reaction: number): void {
    const player = match.players.find((candidate) => candidate.id === playerId);
    if (!player) return;

    // One at a time per player: a new reaction replaces the last.
    this.bubbles.get(playerId)?.element.remove();

    const element = document.createElement('div');
    element.className = 'reaction-bubble';
    element.setAttribute('role', 'status');
    element.setAttribute('aria-label', `${player.name}: ${REACTIONS[reaction]?.label ?? ''}`);
    element.style.setProperty('--ring', colourFor(player.colourIndex).body);
    element.innerHTML = reactionSvg(reaction);
    element.hidden = true;
    this.host.insertBefore(element, this.before);
    this.bubbles.set(playerId, { element, playerId, shownAt: performance.now() });
  }

  /** Every frame while any are showing: keep each over its pen, and retire finished ones. */
  update(match: Match, viewport: Viewport): void {
    if (this.bubbles.size === 0) return;
    const now = performance.now();
    const hostBox = this.host.getBoundingClientRect();

    for (const bubble of this.bubbles.values()) {
      if (now - bubble.shownAt > BUBBLE_MS) {
        bubble.element.remove();
        this.bubbles.delete(bubble.playerId);
        continue;
      }

      const spot = this.anchor(match, viewport, bubble.playerId, hostBox);
      bubble.element.hidden = spot === null;
      if (spot) {
        bubble.element.style.left = `${spot.x}px`;
        bubble.element.style.top = `${spot.y}px`;
      }
    }
  }

  clear(): void {
    for (const bubble of this.bubbles.values()) bubble.element.remove();
    this.bubbles.clear();
  }

  /** The point the bubble's tail rests on, relative to the host. */
  private anchor(match: Match, viewport: Viewport, playerId: string, hostBox: DOMRect): { x: number; y: number } | null {
    const player = match.players.find((candidate) => candidate.id === playerId);
    const pen = player && match.world.pens.find((candidate) => candidate.id === player.penId);
    if (pen && pen.state !== 'out') {
      return toScreen(viewport, localToWorld(pen, { along: 0, across: 0 }));
    }

    const row = this.host.querySelector<HTMLElement>(`.player[data-player-id="${CSS.escape(playerId)}"] .player-avatar`);
    if (!row) return null;
    const box = row.getBoundingClientRect();
    // Hang it under the avatar rather than over it, so it never runs off the top.
    return { x: box.left + box.width / 2 - hostBox.left, y: box.bottom + 58 - hostBox.top };
  }
}
