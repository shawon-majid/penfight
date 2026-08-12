/**
 * Wiring.
 *
 * Holds the lobby, the current session, the renderer, the aim controller and
 * the frame loop, and connects them. Deliberately thin — anything with a rule
 * in it belongs in `shared/`, and anything that draws belongs in `render/`.
 */

import { DEFAULT_TUNING } from '../shared/physics/tuning';
import { SIM_STEP } from '../shared/physics/world';
import { ClackAudio } from './audio/clack';
import { AimController, type AimSnapshot } from './input/aim';
import { OnlineSession } from './modes/online';
import { SoloSession } from './modes/solo';
import { strikeablePen, type Session } from './modes/session';
import { Renderer } from './render/renderer';
import { Hud } from './ui/hud';
import { Lobby, type LobbyChoice } from './ui/lobby';

/**
 * After a background tab wakes up, `requestAnimationFrame` hands us a huge
 * delta. Simulating all of it would freeze the page, so the backlog is capped
 * and anything past it is dropped — the next server snapshot puts online games
 * straight again anyway.
 */
const MAX_STEPS_PER_FRAME = 6;
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
  private readonly audio = new ClackAudio();

  /** The match in progress. Public so dev tooling can inspect and drive it. */
  session: Session | null = null;
  private aim: AimController | null = null;
  private aimSnapshot: AimSnapshot = { dragging: false, grab: null, pointer: null, strike: null };
  private unsubscribe: (() => void) | null = null;

  private accumulator = 0;
  private lastFrameTime: number | null = null;
  private running = false;

  constructor(elements: AppElements) {
    this.elements = elements;
    this.renderer = new Renderer(elements.canvas);
    this.lobby = new Lobby(elements.lobby, (choice) => void this.begin(choice));
    this.hud = new Hud(elements.hud, {
      onRematch: () => this.session?.requestRematch(),
      onStart: () => {
        if (this.session instanceof OnlineSession) this.session.start();
      },
      onLeave: () => this.leave(),
    });

    // Browsers need a gesture before they will play sound.
    window.addEventListener('pointerdown', () => this.audio.unlock(), { once: true });
  }

  start(): void {
    const invited = new URLSearchParams(location.search).get('table');
    this.showLobby(invited);
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
      strikeablePen: () => (this.session ? strikeablePen(this.session) : null),
      onStrike: (strike) => this.session?.submitStrike(strike),
      onChange: (snapshot) => {
        this.aimSnapshot = snapshot;
      },
    });

    this.unsubscribe = this.session.onChange(() => {
      if (this.session) this.hud.update(this.session);
    });
    this.hud.update(this.session);

    this.accumulator = 0;
    this.lastFrameTime = null;
    if (!this.running) {
      this.running = true;
      requestAnimationFrame(this.frame);
    }
  }

  private async createSession(choice: LobbyChoice): Promise<Session> {
    if (choice.mode === 'solo') {
      return new SoloSession({
        playerName: choice.name,
        botCount: choice.botCount,
        difficulty: choice.difficulty,
      });
    }

    const code = choice.mode === 'create' ? await requestNewTableCode() : choice.code;
    // Keep the invite link in the address bar so a refresh rejoins the table.
    history.replaceState(null, '', `${location.pathname}?table=${code}`);
    return new OnlineSession({ code, name: choice.name });
  }

  private leave(): void {
    this.teardownSession();
    history.replaceState(null, '', location.pathname);
    this.showLobby(null);
  }

  private teardownSession(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
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
    this.accumulator += delta;

    let steps = 0;
    while (this.accumulator >= SIM_STEP && steps < MAX_STEPS_PER_FRAME) {
      const events = this.session.tick();
      for (const collision of events.collisions) this.audio.clack(collision.impulse);
      if (events.startedFalling.length > 0) this.audio.thud();
      this.accumulator -= SIM_STEP;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;

    // Read the aim fresh each frame: the drag may have moved since the last event.
    if (this.aim) this.aimSnapshot = this.aim.snapshot();

    this.renderer.draw({
      match: this.session.match,
      aim: this.aimSnapshot,
      youAre: this.session.youAre,
      time: now,
      insets: this.hud.reservedSpace(),
    });

    requestAnimationFrame(this.frame);
  };
}

/** Ask the server for a table nobody else is using. */
async function requestNewTableCode(): Promise<string> {
  const response = await fetch('/api/table', { method: 'POST' });
  if (!response.ok) {
    throw new Error('Could not open a table. Try again in a moment.');
  }
  const body = (await response.json()) as { code?: string };
  if (!body.code) throw new Error('The server did not send back a table code.');
  return body.code;
}
