/**
 * One table, living on the server.
 *
 * Each table code maps to exactly one of these — a Cloudflare Durable Object,
 * which is a single-threaded piece of state with its own address. That is a
 * good fit here: the whole point of a table is that there is one of it, and
 * that everyone's shots are applied in one agreed order.
 *
 * How a shot is handled:
 *
 *   1. A strike arrives. It is checked against this object's copy of the
 *      match — right player, right turn, real pen.
 *   2. The shot is simulated *to completion immediately*, which takes a few
 *      milliseconds, and we note how many frames it lasted.
 *   3. The strike is broadcast at once so every browser starts animating.
 *   4. A timer fires when the animation would have finished, and the settled
 *      state is broadcast as the authoritative snapshot.
 *
 * That way the server does one short burst of work per shot instead of
 * simulating at sixty frames a second alongside everyone else, and the players
 * still see the shot play out in real time.
 */

import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  createMatch,
  currentPlayer,
  playerById,
  setConnected,
  skipTurn,
  stepMatch,
  submitStrike,
  type Match,
  type PlayerSpec,
} from '../shared/game/match';
import { SIM_HZ } from '../shared/physics/world';
import type { ClientMessage, MatchSnapshot, ServerMessage } from '../shared/net/protocol';
import {
  PROTOCOL_VERSION,
  decodeClientMessage,
  encode,
  restoreMatch,
  snapshotMatch,
} from '../shared/net/protocol';

/** How long a player has to take their shot before the table moves on. */
const TURN_SECONDS = 45;
/** Small cushion so browsers finish their animation before the snapshot lands. */
const SETTLE_BUFFER_MS = 250;
/** Cap on how long a single shot may be simulated for. */
const MAX_SHOT_FRAMES = SIM_HZ * 20;

interface Seat {
  spec: PlayerSpec;
  sockets: Set<WebSocket>;
}

export interface Env {
  TABLE_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export class TableRoom implements DurableObject {
  private readonly state: DurableObjectState;
  private code = '';
  /** Everyone who has taken a seat, in join order. */
  private seats = new Map<string, Seat>();
  /** The live match, or null while the table is still filling up. */
  private match: Match | null = null;
  private hostId: string | null = null;
  private turnEndsAt: number | null = null;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    // Restore across an eviction, so a table survives a quiet spell.
    this.state.blockConcurrencyWhile(async () => {
      const saved = await this.state.storage.get<PersistedTable>('table');
      if (saved) this.restore(saved);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.code = url.searchParams.get('code') ?? this.code;

    if (url.pathname.endsWith('/reserve')) {
      // The worker asks whether this code is free before handing it out.
      return Response.json({ taken: this.seats.size > 0 });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a websocket.', { status: 426 });
    }

    const playerId = url.searchParams.get('player');
    const name = (url.searchParams.get('name') ?? '').slice(0, 24) || 'Player';
    if (!playerId) return new Response('Missing player id.', { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.onOpen(server, playerId, name);

    return new Response(null, { status: 101, webSocket: client });
  }

  // -- connections ----------------------------------------------------------

  private onOpen(socket: WebSocket, playerId: string, name: string): void {
    const seat = this.claimSeat(playerId, name);
    if (seat) {
      seat.sockets.add(socket);
      if (this.match) setConnected(this.match, playerId, true);
      this.hostId ??= playerId;
    }

    socket.addEventListener('message', (event) => {
      const message = decodeClientMessage(String(event.data));
      if (message) this.onMessage(socket, playerId, message);
    });

    const drop = () => this.onClose(socket, playerId);
    socket.addEventListener('close', drop);
    socket.addEventListener('error', drop);

    this.sendTo(socket, {
      type: 'welcome',
      playerId,
      hostId: this.hostId ?? playerId,
      snapshot: this.snapshot(),
      version: PROTOCOL_VERSION,
    });
    this.broadcastSnapshot();
  }

  /**
   * Give a player their seat back, or a new one if there is room.
   *
   * Returning to your own seat is what makes a refresh or a flaky connection
   * survivable: your pen is still there, exactly where you left it.
   */
  private claimSeat(playerId: string, name: string): Seat | null {
    const existing = this.seats.get(playerId);
    if (existing) {
      existing.spec.name = name;
      return existing;
    }

    // Once a match is under way the seats are fixed; latecomers spectate.
    if (this.match || this.seats.size >= MAX_PLAYERS) return null;

    const seat: Seat = { spec: { id: playerId, name }, sockets: new Set() };
    this.seats.set(playerId, seat);
    return seat;
  }

  private onClose(socket: WebSocket, playerId: string): void {
    const seat = this.seats.get(playerId);
    if (!seat) return;
    seat.sockets.delete(socket);

    // Other tabs may still be open for the same player.
    if (seat.sockets.size > 0) return;

    if (this.match) {
      setConnected(this.match, playerId, false);
      if (this.match.phase === 'aiming') this.armTurnTimer();
    } else {
      // Nobody has started yet, so free the seat for someone else.
      this.seats.delete(playerId);
    }

    if (this.hostId === playerId) this.hostId = this.firstConnectedSeat();
    this.broadcastSnapshot();
    this.persist();
  }

  private firstConnectedSeat(): string | null {
    for (const [id, seat] of this.seats) {
      if (seat.sockets.size > 0) return id;
    }
    return null;
  }

  // -- messages -------------------------------------------------------------

  private onMessage(socket: WebSocket, playerId: string, message: ClientMessage): void {
    switch (message.type) {
      case 'ping':
        this.sendTo(socket, { type: 'pong' });
        return;

      case 'join':
        // Seats are claimed on connect; nothing more to do.
        return;

      case 'start':
        this.startMatch(socket, playerId);
        return;

      case 'rematch':
        this.rematch(socket, playerId);
        return;

      case 'strike':
        this.handleStrike(socket, playerId, message.strike);
        return;
    }
  }

  private startMatch(socket: WebSocket, playerId: string): void {
    if (this.match) return;
    if (playerId !== this.hostId) {
      this.sendTo(socket, { type: 'error', message: 'Only the host can start the game.' });
      return;
    }
    if (this.seats.size < MIN_PLAYERS) {
      this.sendTo(socket, { type: 'error', message: 'Two players are needed to start.' });
      return;
    }

    this.match = createMatch(this.code, this.rosterSpecs());
    this.armTurnTimer();
    this.broadcastSnapshot();
    this.persist();
  }

  private rematch(socket: WebSocket, playerId: string): void {
    if (playerId !== this.hostId) {
      this.sendTo(socket, { type: 'error', message: 'Only the host can start a rematch.' });
      return;
    }
    if (this.match && this.match.phase !== 'finished') return;

    // Drop anyone who left, then deal again.
    for (const [id, seat] of [...this.seats]) {
      if (seat.sockets.size === 0) this.seats.delete(id);
    }
    this.clearTimers();
    this.match =
      this.seats.size >= MIN_PLAYERS ? createMatch(this.code, this.rosterSpecs()) : null;
    if (this.match) this.armTurnTimer();
    this.broadcastSnapshot();
    this.persist();
  }

  /**
   * The core of the server: validate a shot, run it out, tell everyone.
   */
  private handleStrike(socket: WebSocket, playerId: string, strike: unknown): void {
    const match = this.match;
    if (!match) {
      this.sendTo(socket, { type: 'error', message: 'The game has not started yet.' });
      return;
    }

    const turnNumber = match.turnNumber;
    const result = submitStrike(match, playerId, strike as never);
    if (!result.ok) {
      this.sendTo(socket, { type: 'error', message: describeRejection(result.reason) });
      // Put them back in step with the truth.
      this.sendTo(socket, { type: 'snapshot', snapshot: this.snapshot(), hostId: this.hostId ?? '' });
      return;
    }

    this.clearTurnTimer();

    // Everyone starts animating now.
    this.broadcast({ type: 'strike', playerId, strike: strike as never, turnNumber });

    // Run the shot out in one go and work out how long it will look like it took.
    let frames = 0;
    while (frames < MAX_SHOT_FRAMES) {
      const step = stepMatch(match);
      frames++;
      if (step.settled) break;
    }

    const animationMs = (frames / SIM_HZ) * 1000 + SETTLE_BUFFER_MS;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (match.phase === 'aiming') this.armTurnTimer();
      this.broadcastSnapshot();
      this.persist();
    }, animationMs);
  }

  // -- turn clock -----------------------------------------------------------

  /**
   * Nobody should be able to freeze a ten-person table by wandering off, so a
   * turn that is never taken is passed on automatically.
   */
  private armTurnTimer(): void {
    this.clearTurnTimer();
    const match = this.match;
    if (!match || match.phase !== 'aiming') return;

    const player = currentPlayer(match);
    if (!player) return;

    this.turnEndsAt = Date.now() + TURN_SECONDS * 1000;
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      if (!this.match || this.match.phase !== 'aiming') return;

      const stillOnTurn = currentPlayer(this.match);
      if (!stillOnTurn) return;

      skipTurn(this.match);
      this.broadcast({
        type: 'skipped',
        playerId: stillOnTurn.id,
        reason: playerById(this.match, stillOnTurn.id)?.connected ? 'timeout' : 'disconnected',
      });
      this.armTurnTimer();
      this.broadcastSnapshot();
    }, TURN_SECONDS * 1000);
  }

  private clearTurnTimer(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    this.turnEndsAt = null;
  }

  private clearTimers(): void {
    this.clearTurnTimer();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  // -- state plumbing -------------------------------------------------------

  private rosterSpecs(): PlayerSpec[] {
    return [...this.seats.values()].map((seat) => ({ ...seat.spec }));
  }

  /**
   * The table as everyone should see it.
   *
   * Before the match starts this is a preview built from the roster, so people
   * watch pens appear on the table as their friends join.
   */
  private snapshot(): MatchSnapshot {
    if (this.match) return snapshotMatch(this.match, this.turnEndsAt);

    const preview = createMatch(this.code, this.rosterSpecs());
    preview.phase = 'lobby';
    return snapshotMatch(preview, null);
  }

  private broadcastSnapshot(): void {
    this.broadcast({ type: 'snapshot', snapshot: this.snapshot(), hostId: this.hostId ?? '' });
  }

  private broadcast(message: ServerMessage): void {
    const payload = encode(message);
    for (const seat of this.seats.values()) {
      for (const socket of seat.sockets) {
        try {
          socket.send(payload);
        } catch {
          seat.sockets.delete(socket);
        }
      }
    }
  }

  private sendTo(socket: WebSocket, message: ServerMessage): void {
    try {
      socket.send(encode(message));
    } catch {
      // The socket went away mid-send; the close handler will tidy up.
    }
  }

  private persist(): void {
    const payload: PersistedTable = {
      code: this.code,
      hostId: this.hostId,
      roster: this.rosterSpecs(),
      snapshot: this.match ? snapshotMatch(this.match, null) : null,
    };
    void this.state.storage.put('table', payload);
  }

  private restore(saved: PersistedTable): void {
    this.code = saved.code;
    this.hostId = saved.hostId;
    this.seats = new Map(
      saved.roster.map((spec) => [spec.id, { spec, sockets: new Set<WebSocket>() }]),
    );
    if (saved.snapshot) {
      // A restarted table picks the match back up rather than silently
      // resetting it. Everyone is marked away until their socket comes back.
      this.match = restoreMatch(saved.snapshot);
      for (const player of this.match.players) player.connected = false;
    }
  }
}

interface PersistedTable {
  code: string;
  hostId: string | null;
  roster: PlayerSpec[];
  snapshot: MatchSnapshot | null;
}

function describeRejection(reason: string): string {
  switch (reason) {
    case 'not-your-turn':
      return 'Hold on — it is not your turn.';
    case 'not-your-pen':
      return 'That is not your pen.';
    case 'pen-not-in-play':
      return 'Your pen is out of the game.';
    case 'wrong-phase':
      return 'The table is still moving.';
    default:
      return 'That shot was not allowed.';
  }
}
