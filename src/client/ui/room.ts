/**
 * The waiting room: the table under the lamp with a seat for everyone, filling
 * up as people arrive.
 *
 * Online it is up for the whole of the lobby phase, driven by the session —
 * each new player's pen drops onto the table in front of their seat. Solo
 * plays the same scene once, quickly, as you and the bots sit down, so both
 * kinds of game begin the same way.
 *
 * The table, seats and pens are canvas; everything you can press or read
 * aloud is DOM on top.
 */

import { MAX_PLAYERS, type Player } from '../../shared/game/match';
import type { Session } from '../modes/session';
import {
  Desk,
  FONT_SANS,
  FONT_SERIF,
  INK,
  Sparks,
  clamp,
  drawPen,
  drawTable,
  easeOutBack,
  easeOutCubic,
  makeWoodTexture,
} from '../render/premium';
import { colourFor } from '../render/theme';
import { inviteButton } from './invite';

/** How long a pen takes to drop onto the table. */
const DROP_SECONDS = 0.55;
/** How long someone who left takes to fade from their seat. */
const LEAVE_SECONDS = 0.4;
/** Several people already at a table you join arrive one after another, this far apart. */
const ARRIVAL_STAGGER_SECONDS = 0.12;
/** Solo: the gap between each player sitting down, and the beat once all are seated. */
const SOLO_SEAT_SECONDS = 0.3;
const SOLO_READY_SECONDS = 0.55;

interface Seat {
  player: Player;
  index: number;
  /** When they arrived, in seconds on the frame clock. May be slightly in the future. */
  joinedAt: number;
  leftAt: number | null;
  greeted: boolean;
  landed: boolean;
}

export interface RoomCallbacks {
  onStart: () => void;
  onLeave: () => void;
  /** A pen just landed on the table — a good moment for a clack. */
  onPenLanded?: () => void;
}

export class RoomScreen {
  private readonly root = document.createElement('section');
  private readonly canvas = document.createElement('canvas');
  private readonly ctx = this.canvas.getContext('2d');
  private readonly calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  private readonly desk = new Desk(this.calm);
  private readonly sparks = new Sparks();
  private readonly callbacks: RoomCallbacks;

  private readonly footer = document.createElement('footer');
  private readonly centre = document.createElement('div');
  private readonly centreCaption = document.createElement('span');
  private readonly centreLabel = document.createElement('strong');
  private readonly inviteButton = document.createElement('button');
  private readonly countNumber = document.createElement('span');
  private readonly statusLine = document.createElement('p');
  private readonly startButton = document.createElement('button');
  private readonly roster = document.createElement('ul');

  private seats = new Map<string, Seat>();
  private seatCount = MAX_PLAYERS;
  private youAre: string | null = null;
  private hostId: string | null = null;
  private tableCode = '';

  private tableWood: HTMLCanvasElement | null = null;
  private tableWoodKey = '';
  private running = false;
  private lastFrame: number | null = null;
  /** Seconds, on the same clock the frames run on. */
  private now = performance.now() / 1000;

  private soloTimers: ReturnType<typeof setTimeout>[] = [];
  private finishSolo: ((completed: boolean) => void) | null = null;

  constructor(parent: HTMLElement, callbacks: RoomCallbacks) {
    this.callbacks = callbacks;
    this.build();
    parent.append(this.root);
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** Online: show the room for this session's lobby, or bring it up to date. */
  show(session: Session): void {
    this.seatCount = MAX_PLAYERS;
    this.tableCode = session.match.code;
    this.open();
    this.sync(session.match.players, session.youAre, session.hostId);
    this.renderControls(session);
  }

  /**
   * Solo: you and the bots sit down one after another, then a beat.
   * Resolves true when the table is ready, or false if the room was closed first.
   */
  playSolo(session: Session): Promise<boolean> {
    this.cancelSolo();
    const players = session.match.players;
    // You first, then the bots in order.
    const ordered = [
      ...players.filter((player) => player.id === session.youAre),
      ...players.filter((player) => player.id !== session.youAre),
    ];
    this.seatCount = players.length;
    this.tableCode = session.match.code;
    this.seats.clear();
    this.open();

    this.centreCaption.textContent = 'Solo';
    this.centreLabel.textContent = `You vs ${players.length - 1} bots`;
    this.centreLabel.classList.add('is-words');
    this.inviteButton.hidden = true;
    this.startButton.hidden = true;
    this.statusLine.textContent = 'Finding opponents…';

    const seated: Player[] = [];
    const step = this.calm ? 0 : SOLO_SEAT_SECONDS * 1000;
    return new Promise((resolve) => {
      this.finishSolo = resolve;
      ordered.forEach((player, i) => {
        this.soloTimers.push(
          setTimeout(() => {
            seated.push(player);
            this.sync(seated, session.youAre, null);
            this.renderCount();
          }, 150 + i * step),
        );
      });
      const ready = 150 + ordered.length * step + DROP_SECONDS * 1000;
      this.soloTimers.push(
        setTimeout(() => {
          this.statusLine.textContent = 'Table ready';
        }, ready),
      );
      this.soloTimers.push(
        setTimeout(() => {
          this.finishSolo = null;
          this.soloTimers = [];
          resolve(true);
        }, ready + SOLO_READY_SECONDS * 1000),
      );
    });
  }

  hide(): void {
    this.cancelSolo();
    this.root.classList.add('hidden');
    this.running = false;
    this.seats.clear();
    this.sparks.clear();
  }

  private cancelSolo(): void {
    for (const timer of this.soloTimers) clearTimeout(timer);
    this.soloTimers = [];
    this.finishSolo?.(false);
    this.finishSolo = null;
  }

  private open(): void {
    this.root.classList.remove('hidden');
    if (!this.running) {
      this.running = true;
      this.lastFrame = null;
      requestAnimationFrame(this.frame);
    }
  }

  /** Seat new arrivals, update everyone else, and start fading anyone who left. */
  private sync(players: readonly Player[], youAre: string | null, hostId: string | null): void {
    this.now = performance.now() / 1000;
    this.youAre = youAre;
    this.hostId = hostId;
    const present = new Set(players.map((player) => player.id));
    let arrivals = 0;

    for (const player of players) {
      const seat = this.seats.get(player.id);
      if (seat) {
        seat.player = player;
        seat.leftAt = null;
        continue;
      }
      const taken = new Set(
        [...this.seats.values()].filter((s) => s.leftAt === null).map((s) => s.index),
      );
      let index = 0;
      while (taken.has(index) && index < this.seatCount - 1) index++;
      this.seats.set(player.id, {
        player,
        index,
        joinedAt: this.calm ? -Infinity : this.now + arrivals * ARRIVAL_STAGGER_SECONDS,
        leftAt: null,
        greeted: this.calm,
        landed: this.calm,
      });
      arrivals++;
    }

    for (const [id, seat] of this.seats) {
      if (!present.has(id) && seat.leftAt === null) seat.leftAt = this.now;
    }

    this.roster.replaceChildren(
      ...players.map((player) => {
        const item = document.createElement('li');
        item.textContent = player.id === youAre ? `${player.name} (you)` : player.name;
        return item;
      }),
    );
  }

  private renderControls(session: Session): void {
    const { match } = session;
    const count = match.players.length;
    const isHost = session.hostId !== null && session.hostId === session.youAre;
    const host = match.players.find((player) => player.id === session.hostId);

    this.centreCaption.textContent = 'Table';
    this.centreLabel.textContent = match.code;
    this.centreLabel.classList.remove('is-words');
    this.inviteButton.hidden = false;

    this.startButton.hidden = !isHost;
    this.startButton.disabled = count < 2;
    this.statusLine.textContent =
      count < 2
        ? 'Share the code and wait for someone to join.'
        : isHost
          ? 'Start when everyone is in.'
          : `Waiting for ${host?.name ?? 'the host'} to start.`;
    this.renderCount();
  }

  private renderCount(): void {
    const seated = [...this.seats.values()].filter((seat) => seat.leftAt === null).length;
    this.countNumber.textContent = `${seated} / ${this.seatCount}`;
  }

  private build(): void {
    this.root.className = 'room hidden';
    this.root.setAttribute('aria-label', 'Waiting room');

    this.canvas.className = 'room-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');

    const top = document.createElement('header');
    top.className = 'room-top';
    const mark = document.createElement('span');
    mark.className = 'lobby-mark';
    mark.textContent = 'Pen Fight';
    const leave = document.createElement('button');
    leave.type = 'button';
    leave.className = 'ghost-button';
    leave.textContent = 'Leave';
    leave.addEventListener('click', () => this.callbacks.onLeave());
    top.append(mark, leave);

    this.centre.className = 'room-centre';
    this.centreCaption.className = 'eyebrow';
    this.centreLabel.className = 'room-code';
    this.inviteButton.type = 'button';
    this.inviteButton.className = 'ghost-button';
    inviteButton(this.inviteButton, () => this.tableCode);
    this.centre.append(this.centreCaption, this.centreLabel, this.inviteButton);

    this.footer.className = 'room-footer';
    const count = document.createElement('div');
    count.className = 'room-count';
    this.countNumber.className = 'room-count-number';
    const countCaption = document.createElement('span');
    countCaption.className = 'eyebrow';
    countCaption.textContent = 'Seated';
    count.append(this.countNumber, countCaption);
    this.statusLine.className = 'room-status';
    this.statusLine.setAttribute('aria-live', 'polite');
    this.startButton.type = 'button';
    this.startButton.className = 'primary-button room-start';
    this.startButton.textContent = 'Start game';
    this.startButton.addEventListener('click', () => this.callbacks.onStart());
    this.footer.append(count, this.statusLine, this.startButton);

    this.roster.className = 'visually-hidden';
    this.roster.setAttribute('aria-label', 'Players at the table');

    this.root.append(this.canvas, top, this.centre, this.footer, this.roster);
  }

  private frame = (timestamp: number): void => {
    const { ctx, canvas } = this;
    if (!this.running || !ctx) return;
    const now = timestamp / 1000;
    const dt = this.lastFrame === null ? 0 : Math.min(0.05, now - this.lastFrame);
    this.lastFrame = now;
    this.now = now;

    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) {
      requestAnimationFrame(this.frame);
      return;
    }
    if (canvas.width !== Math.round(w * pixelRatio) || canvas.height !== Math.round(h * pixelRatio)) {
      canvas.width = Math.round(w * pixelRatio);
      canvas.height = Math.round(h * pixelRatio);
    }
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    this.desk.resize(w, h, pixelRatio);

    const layout = this.layout(w, h);
    this.desk.draw(ctx, 1, now, dt, layout.cx, layout.cy - layout.tableH / 2, 0.25);

    const woodKey = `${Math.round(layout.tableW)}x${Math.round(layout.tableH)}@${pixelRatio}`;
    if (woodKey !== this.tableWoodKey) {
      this.tableWoodKey = woodKey;
      this.tableWood = makeWoodTexture(layout.tableW, layout.tableH, pixelRatio);
    }
    if (this.tableWood) {
      drawTable(ctx, this.tableWood, layout.cx, layout.cy, layout.tableW, layout.tableH, layout.radius);
    }
    this.centre.style.left = `${layout.cx}px`;
    this.centre.style.top = `${layout.cy}px`;

    this.drawSeats(ctx, layout, now);
    this.sparks.draw(ctx, dt);

    for (const [id, seat] of this.seats) {
      if (seat.leftAt !== null && now - seat.leftAt > LEAVE_SECONDS) this.seats.delete(id);
    }

    requestAnimationFrame(this.frame);
  };

  /**
   * The table fills the space between the top bar and the footer, with the
   * seats on a ring that follows its outline just outside it. A tall screen
   * gets a tall table.
   */
  private layout(w: number, h: number) {
    const u = clamp(Math.min(w, h) / 720, 0.72, 1.25);
    const top = 64 * u + 8;
    const bottom = h - this.footer.offsetHeight - 8;
    const cx = w / 2;
    const cy = (top + bottom) / 2;
    const seatGap = 40 * u;

    let halfW = Math.max(60, (w - 32) / 2 - seatGap - 46 * u);
    let halfH = Math.max(50, (bottom - top) / 2 - seatGap - 40 * u);
    if (halfW >= halfH) halfW = Math.min(halfW, halfH * 2);
    else halfH = Math.min(halfH, halfW * 2);

    return {
      u,
      cx,
      cy,
      tableW: halfW * 2,
      tableH: halfH * 2,
      radius: 30 * u,
      seatGap,
    };
  }

  private drawSeats(ctx: CanvasRenderingContext2D, layout: ReturnType<RoomScreen['layout']>, now: number): void {
    const { u, cx, cy, tableW, tableH, radius, seatGap } = layout;
    const yourSeat = (this.youAre && this.seats.get(this.youAre)?.index) || 0;
    const occupied = new Map<number, Seat>();
    for (const seat of this.seats.values()) {
      // Someone arriving takes precedence over someone fading out of the same chair.
      if (!occupied.has(seat.index) || seat.leftAt === null) occupied.set(seat.index, seat);
    }

    const avatar = 22 * u;
    const penLength = clamp(Math.min(tableW, tableH) * 0.3, 44 * u, 88 * u);

    for (let index = 0; index < this.seatCount; index++) {
      // Turned so that you are always at the bottom, nearest yourself.
      const around = (index - yourSeat + this.seatCount) % this.seatCount;
      const along = around / this.seatCount;
      const chair = aroundTable(tableW / 2 + seatGap, tableH / 2 + seatGap, radius + seatGap, along);
      const x = cx + chair.x;
      const y = cy + chair.y;
      const angle = Math.atan2(chair.y, chair.x);
      const seat = occupied.get(index);
      const arrived = seat ? clamp((now - seat.joinedAt) / DROP_SECONDS) : 0;

      if (!seat || arrived <= 0) {
        drawEmptySeat(ctx, x, y, avatar);
        continue;
      }

      const fade = seat.leftAt === null ? 1 : clamp(1 - (now - seat.leftAt) / LEAVE_SECONDS);
      const colour = colourFor(seat.player.colourIndex);

      // Their pen, dropping onto the table in front of them, pointing in.
      const spot = aroundTable(tableW * 0.33, tableH * 0.33, radius, along);
      const penX = cx + spot.x;
      const penY = cy + spot.y;
      const lift = clamp(1 - easeOutBack(arrived), 0, 1.2);
      drawPen(ctx, penX, penY, angle + Math.PI, penLength, colour, lift, clamp(arrived * 3) * fade);

      if (!seat.greeted) {
        seat.greeted = true;
        this.sparks.ring(x, y, colour.body, 36 * u, avatar);
        this.sparks.burst(x, y, 18, colour.accent, 90 * u);
      }
      if (arrived >= 1 && !seat.landed) {
        seat.landed = true;
        this.sparks.burst(penX, penY, 10, '#ffe2b0', 60 * u);
        this.callbacks.onPenLanded?.();
      }

      const appear = easeOutCubic(arrived) * fade;
      const away = !seat.player.connected;
      ctx.save();
      ctx.globalAlpha = appear;
      ctx.beginPath();
      ctx.arc(x, y, avatar, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(13, 12, 12, 0.9)';
      ctx.fill();
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = colour.body;
      ctx.globalAlpha = appear * (away ? 0.35 : 1);
      if (!away) {
        ctx.shadowColor = colour.body;
        ctx.shadowBlur = 14 * appear * ctx.getTransform().a;
      }
      ctx.stroke();
      ctx.restore();

      const you = seat.player.id === this.youAre;
      label(ctx, initial(seat.player.name), x, y + 1, `500 ${17 * u}px ${FONT_SERIF}`, INK.title, 0, appear);
      label(
        ctx,
        fit(ctx, seat.player.name.toUpperCase(), `500 ${9.5 * u}px ${FONT_SANS}`, 2 * u, 110 * u),
        x,
        y + avatar + 13 * u,
        `500 ${9.5 * u}px ${FONT_SANS}`,
        you ? INK.champagne : '#cfc6b0',
        2 * u,
        appear,
      );
      const tag = away
        ? 'AWAY'
        : seat.player.id === this.hostId
          ? 'HOST'
          : you
            ? 'YOU'
            : seat.player.isBot
              ? 'BOT'
              : '';
      if (tag) {
        label(ctx, tag, x, y - avatar - 11 * u, `500 ${7.5 * u}px ${FONT_SANS}`, INK.champagne, 2.5 * u, appear * 0.9);
      }
    }
  }
}

/**
 * A point on a rounded rectangle's outline, a fraction of the way round it —
 * starting bottom centre and going clockwise on screen. Even steps along the
 * outline space the chairs evenly however long or tall the table is.
 */
function aroundTable(halfW: number, halfH: number, radius: number, fraction: number): { x: number; y: number } {
  const r = Math.min(radius, halfW, halfH);
  const straightW = halfW - r;
  const straightH = halfH - r;
  const arc = (Math.PI / 2) * r;
  // Bottom half-edge, corner, left, corner, top, corner, right, corner, bottom half-edge.
  const pieces: { length: number; at: (k: number) => { x: number; y: number } }[] = [
    { length: straightW, at: (k) => ({ x: -k * straightW, y: halfH }) },
    { length: arc, at: (k) => corner(-straightW, straightH, r, Math.PI / 2 + (k * Math.PI) / 2) },
    { length: 2 * straightH, at: (k) => ({ x: -halfW, y: straightH - k * 2 * straightH }) },
    { length: arc, at: (k) => corner(-straightW, -straightH, r, Math.PI + (k * Math.PI) / 2) },
    { length: 2 * straightW, at: (k) => ({ x: -straightW + k * 2 * straightW, y: -halfH }) },
    { length: arc, at: (k) => corner(straightW, -straightH, r, (3 * Math.PI) / 2 + (k * Math.PI) / 2) },
    { length: 2 * straightH, at: (k) => ({ x: halfW, y: -straightH + k * 2 * straightH }) },
    { length: arc, at: (k) => corner(straightW, straightH, r, (k * Math.PI) / 2) },
    { length: straightW, at: (k) => ({ x: straightW - k * straightW, y: halfH }) },
  ];
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  let distance = (((fraction % 1) + 1) % 1) * total;
  for (const piece of pieces) {
    if (distance <= piece.length && piece.length > 0) return piece.at(distance / piece.length);
    distance -= piece.length;
  }
  return { x: 0, y: halfH };
}

function corner(cx: number, cy: number, r: number, angle: number): { x: number; y: number } {
  return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
}

function drawEmptySeat(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(13, 12, 12, 0.6)';
  ctx.fill();
  ctx.setLineDash([3, 4]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(205, 184, 148, 0.35)';
  ctx.stroke();
  ctx.restore();
  label(ctx, '+', x, y + 1, `300 ${radius * 0.75}px ${FONT_SANS}`, 'rgba(205, 184, 148, 0.45)', 0, 1);
}

function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}

/** Shorten with an ellipsis until it fits under the seat. */
function fit(ctx: CanvasRenderingContext2D, text: string, font: string, spacing: number, max: number): string {
  ctx.save();
  ctx.font = font;
  ctx.letterSpacing = `${spacing}px`;
  let value = text;
  while (value.length > 1 && ctx.measureText(value).width > max) value = value.slice(0, -1);
  ctx.restore();
  return value === text ? text : `${value.trimEnd()}…`;
}

/** Names come from other people: canvas text is never markup, so this is safe as-is. */
function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  font: string,
  colour: string,
  spacing: number,
  alpha: number,
): void {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = font;
  ctx.fillStyle = colour;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = `${spacing}px`;
  ctx.fillText(text, x, y);
  ctx.restore();
}
