/**
 * Wiring.
 *
 * Holds the lobby, the current session, the renderer, the aim controller and
 * the frame loop, and connects them. Deliberately thin — anything with a rule
 * in it belongs in `shared/`, and anything that draws belongs in `render/`.
 */

import { DEFAULT_TUNING } from '../shared/physics/tuning';
import { SIM_STEP } from '../shared/physics/world';
import type { MatchPhase } from '../shared/game/match';
import type { MatchRecord } from '../shared/game/results';
import { TURN_SECONDS } from '../shared/net/protocol';
import { Account } from './account/account';
import { ClackAudio } from './audio/clack';
import { AimController, type AimSnapshot } from './input/aim';
import { OnlineSession } from './modes/online';
import { api } from './net/server';
import { SoloSession } from './modes/solo';
import { strikeablePen, type Session } from './modes/session';
import { IntroTimeline } from './render/intro';
import { Renderer, type TurnClock } from './render/renderer';
import { Hud } from './ui/hud';
import { Lobby, type LobbyChoice } from './ui/lobby';
import { PlayerDock, ReactionBubbles } from './ui/reactions';
import { RoomScreen } from './ui/room';

/**
 * After a background tab wakes up, `requestAnimationFrame` hands us a huge
 * delta. Simulating all of it would freeze the page, so the backlog is capped
 * and anything past it is dropped — the next server snapshot puts online games
 * straight again anyway.
 */
const MAX_STEPS_PER_FRAME = 6;
/** The last stretch of a turn, when the clock turns red and ticks. */
const CLOCK_WARNING_SECONDS = 10;
const MAX_FRAME_DELTA_SECONDS = 0.25;

export interface AppElements {
  lobby: HTMLElement;
  game: HTMLElement;
  hud: HTMLElement;
  canvas: HTMLCanvasElement;
}

export class App {
  private readonly elements: AppElements;
  private readonly lobby: Lobby;
  private readonly renderer: Renderer;
  private readonly hud: Hud;
  private readonly room: RoomScreen;
  private readonly audio = new ClackAudio();
  private readonly account = new Account();
  private readonly dock: PlayerDock;
  private readonly bubbles: ReactionBubbles;

  /** The match in progress. Public so dev tooling can inspect and drive it. */
  session: Session | null = null;
  private aim: AimController | null = null;
  private aimSnapshot: AimSnapshot = { dragging: false, grab: null, pointer: null, strike: null };
  private unsubscribe: (() => void) | null = null;
  /**
   * True while the table is being set before play — the solo seating, then
   * the countdown. Nothing moves and nobody can aim; bots only think when the
   * session ticks, so they wait too.
   */
  private holding = false;
  /** The countdown at the start of a game, while it plays. */
  private intro: { timeline: IntroTimeline; startedAt: number; last: number } | null = null;
  /** The phase at the last update, to spot a game starting rather than one already going. */
  private lastPhase: MatchPhase | null = null;
  private readonly calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  /** The whole second the clock last showed, so it ticks once per second. */
  private lastClockSecond: number | null = null;

  private accumulator = 0;
  private lastFrameTime: number | null = null;
  private running = false;

  constructor(elements: AppElements) {
    this.elements = elements;
    this.renderer = new Renderer(elements.canvas);
    this.lobby = new Lobby(elements.lobby, this.account, (choice) => void this.begin(choice));
    this.hud = new Hud(elements.hud, {
      onRematch: () => this.session?.requestRematch(),
      onStart: () => {
        if (this.session instanceof OnlineSession) this.session.start();
      },
      onLeave: () => this.leave(),
    });
    this.room = new RoomScreen(elements.game, {
      onStart: () => {
        if (this.session instanceof OnlineSession) this.session.start();
      },
      onLeave: () => this.leave(),
      onPenLanded: () => this.audio.clack(0.008),
    });

    // Between the canvas and the display, so the display's panels always cover them.
    this.dock = new PlayerDock(elements.game, elements.hud, (reaction) => this.session?.react(reaction));
    this.bubbles = new ReactionBubbles(elements.game, elements.hud);

    // Browsers need a gesture before they will play sound — and phones may need several.
    this.audio.install();
  }

  /** Resolves once the account is known, which is when the boot screen can lift. */
  start(): Promise<void> {
    const invited = new URLSearchParams(location.search).get('table');
    this.showLobby(invited);
    // Guests: returns at once. Signed in, or back from Google: fills in the lobby when ready.
    return this.account.init();
  }

  private showLobby(prefillCode?: string | null): void {
    this.elements.game.classList.add('hidden');
    this.lobby.show(prefillCode);
  }

  private async begin(choice: LobbyChoice): Promise<void> {
    this.teardownSession();

    try {
      this.session = await this.createSession(choice);
    } catch (error) {
      this.lobby.setError(
        error instanceof Error ? error.message : 'Could not start the game.',
      );
      return;
    }

    this.lobby.hide();
    this.elements.game.classList.remove('hidden');

    this.aim = new AimController({
      canvas: this.elements.canvas,
      tuning: DEFAULT_TUNING,
      viewport: () => this.renderer.currentViewport(),
      strikeablePen: () => (this.session && !this.holding ? strikeablePen(this.session) : null),
      onStrike: (strike) => this.session?.submitStrike(strike),
      onChange: (snapshot) => {
        this.aimSnapshot = snapshot;
      },
    });

    const offChange = this.session.onChange(() => {
      if (!this.session) return;
      this.hud.update(this.session);
      this.syncRoom();
      this.maybeStartIntro();
      this.dock.update(this.session);
    });
    const offReaction = this.session.onReaction((playerId, reaction) => {
      if (this.session) this.bubbles.show(this.session.match, playerId, reaction);
    });
    this.unsubscribe = () => {
      offChange();
      offReaction();
    };
    this.hud.resetLayout();
    this.hud.update(this.session);
    this.dock.update(this.session);

    this.accumulator = 0;
    this.lastFrameTime = null;
    if (!this.running) {
      this.running = true;
      requestAnimationFrame(this.frame);
    }

    // Both kinds of game open on the waiting room: solo plays its seating once,
    // online stays in it until the host starts.
    const session = this.session;
    if (session instanceof SoloSession) {
      this.holding = true;
      const ready = await this.room.playSolo(session);
      if (!ready || this.session !== session) return;
      this.room.hide();
      this.holding = false;
    } else {
      this.syncRoom();
    }
    this.maybeStartIntro();
  }

  /**
   * Every game opens the same way, solo or online, first game or rematch:
   * pens land, then the count. Joining a game already under way skips it.
   */
  private maybeStartIntro(): void {
    const session = this.session;
    if (!session) return;
    const { phase, turnNumber } = session.match;
    const previous = this.lastPhase;
    // Still in the waiting room: the game has not started, whatever comes next.
    if (this.room.visible) return;
    this.lastPhase = phase;

    const starting =
      phase === 'aiming' && turnNumber === 0 && previous !== 'aiming' && previous !== 'resolving';
    if (!starting || this.intro || this.calm) return;

    this.intro = {
      timeline: new IntroTimeline(session.match.world.pens.length),
      startedAt: performance.now() / 1000,
      last: 0,
    };
    this.holding = true;
    this.elements.game.classList.add('is-intro');
  }

  /**
   * Online only: how long whoever is on has left, from the deadline the server
   * set. Nothing while the pens are moving, during the countdown, or in solo.
   */
  private turnClock(): TurnClock | null {
    const session = this.session;
    const deadline = session instanceof OnlineSession ? session.turnDeadline : null;
    if (!session || deadline === null || session.match.phase !== 'aiming' || this.holding) {
      this.lastClockSecond = null;
      return null;
    }
    // The first turn carries a little extra for the countdown; never show more than a full turn.
    const secondsLeft = Math.min(TURN_SECONDS, Math.max(0, (deadline - performance.now()) / 1000));
    const warning = secondsLeft <= CLOCK_WARNING_SECONDS;

    const whole = Math.ceil(secondsLeft);
    if (warning && whole > 0 && this.lastClockSecond !== null && whole !== this.lastClockSecond) {
      this.audio.tick();
    }
    this.lastClockSecond = whole;
    return { secondsLeft, fraction: secondsLeft / TURN_SECONDS, warning };
  }

  /** Sounds for the beats that just passed, and opening play on "Flick!". */
  private advanceIntro(now: number): { timeline: IntroTimeline; t: number } | null {
    const intro = this.intro;
    if (!intro) return null;
    const t = now - intro.startedAt;
    for (const beat of intro.timeline.beatsBetween(intro.last, t)) {
      if (beat.kind === 'landed') this.audio.clack(0.008);
      else if (beat.kind === 'count') this.audio.clack(0.014);
      else {
        this.audio.clack(0.03);
        this.holding = false;
        this.elements.game.classList.remove('is-intro');
      }
    }
    intro.last = t;
    if (t >= intro.timeline.endsAt) {
      this.intro = null;
      return null;
    }
    return { timeline: intro.timeline, t };
  }

  /** Online: the waiting room is up for exactly as long as the match is in its lobby. */
  private syncRoom(): void {
    const session = this.session;
    if (!(session instanceof OnlineSession)) return;
    if (session.match.phase === 'lobby') this.room.show(session);
    else if (this.room.visible) this.room.hide();
  }

  private async createSession(choice: LobbyChoice): Promise<Session> {
    if (choice.mode === 'solo') {
      return new SoloSession({
        playerName: choice.name,
        botCount: choice.botCount,
        difficulty: choice.difficulty,
        colourIndex: this.account.colour,
        avatar: this.account.avatar,
        onFinished: (record) => this.recordSolo(record),
      });
    }

    const code = choice.mode === 'create' ? await requestNewTableCode() : choice.code;
    // Keep the invite link in the address bar so a refresh rejoins the table.
    history.replaceState(null, '', `${location.pathname}?table=${code}`);
    return new OnlineSession({
      code,
      name: choice.name,
      colourIndex: this.account.colour,
      avatar: this.account.avatar,
      accessToken: () => this.account.accessToken(),
      signedIn: this.account.signedIn,
    });
  }

  /** Solo games go on the player's record: in this browser for a guest, on their profile if signed in. */
  private recordSolo(record: MatchRecord): void {
    this.account
      .recordSolo(record)
      .catch((error: unknown) => console.error('Could not record the game:', error));
  }

  private leave(): void {
    this.teardownSession();
    history.replaceState(null, '', location.pathname);
    this.showLobby(null);
  }

  private teardownSession(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.dock.hide();
    this.bubbles.clear();
    this.room.hide();
    this.holding = false;
    this.intro = null;
    this.lastPhase = null;
    this.elements.game.classList.remove('is-intro');
    this.aim?.destroy();
    this.aim = null;
    this.session?.destroy();
    this.session = null;
    this.aimSnapshot = { dragging: false, grab: null, pointer: null, strike: null };
  }

  /**
   * Fixed-step simulation, free-running rendering.
   *
   * The physics must advance in identical increments everywhere or two
   * browsers would disagree about the same shot, so the frame's elapsed time
   * is banked and spent in whole steps.
   */
  private frame = (timestampMs: number): void => {
    if (!this.session) {
      this.running = false;
      return;
    }

    const now = timestampMs / 1000;
    const delta = this.lastFrameTime === null ? 0 : Math.min(now - this.lastFrameTime, MAX_FRAME_DELTA_SECONDS);
    this.lastFrameTime = now;
    const intro = this.advanceIntro(now);

    // Time spent holding is not owed to the simulation afterwards.
    this.accumulator = this.holding ? 0 : this.accumulator + delta;

    let steps = 0;
    while (this.accumulator >= SIM_STEP && steps < MAX_STEPS_PER_FRAME) {
      const events = this.session.tick();
      for (const collision of events.collisions) this.audio.clack(collision.impulse);
      if (events.startedFalling.length > 0) this.audio.thud();
      this.accumulator -= SIM_STEP;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;

    const turnClock = this.turnClock();
    this.hud.tick();
    this.dock.tick(turnClock);

    // Read the aim fresh each frame: the drag may have moved since the last event.
    if (this.aim) this.aimSnapshot = this.aim.snapshot();

    // The waiting room covers the whole screen; no point drawing underneath it.
    if (!this.room.visible) {
      this.renderer.draw({
        match: this.session.match,
        aim: this.aimSnapshot,
        youAre: this.session.youAre,
        time: now,
        insets: this.hud.reservedSpace(this.dock.spaceBelowTable()),
        intro,
      });
      const viewport = this.renderer.currentViewport();
      this.bubbles.update(this.session.match, viewport);
      const table = this.renderer.tableOnScreen(this.session.match);
      this.dock.setTableBottom(table.top + table.height);
    }

    requestAnimationFrame(this.frame);
  };
}

/** Ask the server for a table nobody else is using. */
async function requestNewTableCode(): Promise<string> {
  const response = await fetch(api('/api/table'), { method: 'POST' });
  if (!response.ok) {
    throw new Error('Could not open a table. Try again in a moment.');
  }
  const body = (await response.json()) as { code?: string };
  if (!body.code) throw new Error('The server did not send back a table code.');
  return body.code;
}
