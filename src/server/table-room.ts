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
  randomFirstTurn,
  setConnected,
  skipTurn,
  stepMatch,
  submitStrike,
  type Match,
  type PlayerSpec,
} from '../shared/game/match';
import { buildMatchRecord, createTally, recordEliminations, type ShotTally } from '../shared/game/results';
import { cryptoRandomInt } from '../shared/game/rng';
import { DEFAULT_TABLE } from '../shared/physics/table';
import { DEFAULT_TUNING } from '../shared/physics/tuning';
import { SIM_HZ } from '../shared/physics/world';
import type {
  ClientMessage,
  MatchSnapshot,
  ServerMessage,
  WaitingPlayer,
  WinTally,
} from '../shared/net/protocol';
import {
  FIRST_TURN_GRACE_SECONDS,
  PROTOCOL_VERSION,
  TURN_SECONDS,
  decodeClientMessage,
  encode,
  restoreMatch,
  snapshotMatch,
} from '../shared/net/protocol';
import { accountIdOf, acceptedSubprotocol, saveOnlineMatch, type SupabaseEnv } from './supabase';

/** How long a player has to take their shot before the table moves on. */
/** Small cushion so browsers finish their animation before the snapshot lands. */
const SETTLE_BUFFER_MS = 250;
/** Cap on how long a single shot may be simulated for. */
const MAX_SHOT_FRAMES = SIM_HZ * 20;

interface Seat {
  spec: PlayerSpec;
  sockets: Set<WebSocket>;
}

export interface Env extends SupabaseEnv {
  TABLE_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export class TableRoom implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private code = '';
  /** Everyone who has taken a seat, in join order. */
  private seats = new Map<string, Seat>();
  /**
   * People who arrived after the match was dealt. They watch this one and are
   * dealt into the next, in the order they came.
   */
  private waiting = new Map<string, Seat>();
  /** Connections with no seat at all — the table was full. They still watch. */
  private spectators = new Set<WebSocket>();
  /** The live match, or null while the table is still filling up. */
  private match: Match | null = null;
  private hostId: string | null = null;
  /** Games won at this table, by player id. Kept across rematches. */
  private wins: WinTally = {};
  /** Identifies the current match in saved results, so saving twice is harmless. */
  private matchId: string | null = null;
  /** When the current match was dealt. ms since the epoch. */
  private matchStartedAt: number | null = null;
  /** Knock-outs and self-falls in the current match, for the players' profiles. */
  private tally: ShotTally = createTally();
  private turnEndsAt: number | null = null;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
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

    // Set by the Worker, which has already decided who this is.
    const playerId = url.searchParams.get('player');
    const name = (url.searchParams.get('name') ?? '').slice(0, 24) || 'Player';
    const colour = Number.parseInt(url.searchParams.get('colour') ?? '', 10);
    if (!playerId) return new Response('Missing player id.', { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.onOpen(server, playerId, name, Number.isNaN(colour) ? undefined : colour);

    const protocol = acceptedSubprotocol(request);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: protocol ? { 'Sec-WebSocket-Protocol': protocol } : {},
    });
  }

  // -- connections ----------------------------------------------------------

  private onOpen(
    socket: WebSocket,
    playerId: string,
    name: string,
    colourIndex: number | undefined,
  ): void {
    const seat = this.claimSeat(playerId, name, colourIndex);
    if (seat) {
      seat.sockets.add(socket);
      if (this.match && this.seats.has(playerId)) setConnected(this.match, playerId, true);
      this.hostId ??= playerId;
    } else {
      this.spectators.add(socket);
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
      wins: { ...this.wins },
      version: PROTOCOL_VERSION,
      signedIn: accountIdOf(playerId) !== null,
      serverNow: Date.now(),
      waiting: this.waitingList(),
    });
    this.broadcastSnapshot();
  }

  /**
   * Give a player their seat back, or a new one if there is room.
   *
   * Returning to your own seat is what makes a refresh or a flaky connection
   * survivable: your pen is still there, exactly where you left it.
   */
  private claimSeat(playerId: string, name: string, colourIndex: number | undefined): Seat | null {
    const existing = this.seats.get(playerId);
    if (existing) {
      existing.spec.name = name;
      // The colour is fixed once a match is dealt; before that, follow the player's choice.
      if (!this.match) existing.spec.colourIndex = colourIndex;
      return existing;
    }

    const waiting = this.waiting.get(playerId);
    if (waiting) {
      waiting.spec.name = name;
      waiting.spec.colourIndex = colourIndex;
      return waiting;
    }

    // Seats count everyone dealt in and everyone queued for the next match.
    if (this.seats.size + this.waiting.size >= MAX_PLAYERS) return null;

    const seat: Seat = { spec: { id: playerId, name, colourIndex }, sockets: new Set() };
    // Once a match is under way its seats are fixed; latecomers wait for the next.
    if (this.match) this.waiting.set(playerId, seat);
    else this.seats.set(playerId, seat);
    return seat;
  }

  private onClose(socket: WebSocket, playerId: string): void {
    this.spectators.delete(socket);

    const queued = this.waiting.get(playerId);
    if (queued) {
      queued.sockets.delete(socket);
      if (queued.sockets.size > 0) return;
      // Gone before their match began: they give up their place in the queue.
      this.waiting.delete(playerId);
      if (this.hostId === playerId) this.hostId = this.firstConnectedSeat();
      this.broadcastSnapshot();
      return;
    }

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

  /** The next host: the longest-seated player still connected, then whoever is waiting. */
  private firstConnectedSeat(): string | null {
    for (const [id, seat] of [...this.seats, ...this.waiting]) {
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

    this.match = this.dealMatch();
    this.armTurnTimer(FIRST_TURN_GRACE_SECONDS);
    this.broadcastSnapshot();
    this.persist();
  }

  private rematch(socket: WebSocket, playerId: string): void {
    if (playerId !== this.hostId) {
      this.sendTo(socket, { type: 'error', message: 'Only the host can start a rematch.' });
      return;
    }
    if (this.match && this.match.phase !== 'finished') return;

    // Drop anyone who left, bring in everyone who has been waiting, then deal again.
    for (const [id, seat] of [...this.seats]) {
      if (seat.sockets.size === 0) this.seats.delete(id);
    }
    for (const [id, seat] of this.waiting) {
      if (seat.sockets.size > 0 && this.seats.size < MAX_PLAYERS) this.seats.set(id, seat);
    }
    this.waiting.clear();
    this.clearTimers();
    this.match = this.seats.size >= MIN_PLAYERS ? this.dealMatch() : null;
    if (this.match) this.armTurnTimer(FIRST_TURN_GRACE_SECONDS);
    this.broadcastSnapshot();
    this.persist();
  }

  /** A fresh match for everyone seated, with a first player nobody can predict. */
  private dealMatch(): Match {
    const specs = this.rosterSpecs();
    this.matchId = crypto.randomUUID();
    this.matchStartedAt = Date.now();
    this.tally = createTally();
    return createMatch(this.code, specs, DEFAULT_TABLE, DEFAULT_TUNING, {
      firstTurnIndex: randomFirstTurn(specs.length, cryptoRandomInt),
    });
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
      this.sendTo(socket, this.snapshotMessage());
      return;
    }

    this.clearTurnTimer();

    // Everyone starts animating now.
    this.broadcast({ type: 'strike', playerId, strike: strike as never, turnNumber });

    // Run the shot out in one go and work out how long it will look like it took.
    let frames = 0;
    while (frames < MAX_SHOT_FRAMES) {
      const step = stepMatch(match);
      recordEliminations(this.tally, playerId, step.eliminated);
      frames++;
      if (step.settled) break;
    }

    // A shot is the only thing that can end a match, so this is the one place
    // a win is counted and results are saved.
    if (match.phase === 'finished') {
      if (match.winnerId) this.wins[match.winnerId] = (this.wins[match.winnerId] ?? 0) + 1;
      this.saveResults(match);
    }

    const animationMs = (frames / SIM_HZ) * 1000 + SETTLE_BUFFER_MS;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (match.phase === 'aiming') this.armTurnTimer();
      this.broadcastSnapshot();
      this.persist();
    }, animationMs);
  }

  /** Hand the finished match to Supabase, if anyone at the table is signed in. */
  private saveResults(match: Match): void {
    if (!this.matchId) return;
    const record = buildMatchRecord(match, this.tally, {
      id: this.matchId,
      mode: 'online',
      tableCode: this.code,
      startedAt: new Date(this.matchStartedAt ?? Date.now()),
      endedAt: new Date(),
      accountIdOf,
    });
    const saving = saveOnlineMatch(this.env, record).catch((error: unknown) =>
      console.error('Saving the match failed:', error),
    );
    this.state.waitUntil(saving);
  }

  // -- turn clock -----------------------------------------------------------

  /**
   * Nobody should be able to freeze a ten-person table by wandering off, so a
   * turn that is never taken is passed on automatically.
   */
  private armTurnTimer(graceSeconds = 0): void {
    this.clearTurnTimer();
    const match = this.match;
    if (!match || match.phase !== 'aiming') return;

    const player = currentPlayer(match);
    if (!player) return;

    const allowedMs = (TURN_SECONDS + graceSeconds) * 1000;
    this.turnEndsAt = Date.now() + allowedMs;
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
    }, allowedMs);
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

  private snapshotMessage(): ServerMessage {
    return {
      type: 'snapshot',
      snapshot: this.snapshot(),
      hostId: this.hostId ?? '',
      wins: { ...this.wins },
      serverNow: Date.now(),
      waiting: this.waitingList(),
    };
  }

  private waitingList(): WaitingPlayer[] {
    return [...this.waiting.values()]
      .filter((seat) => seat.sockets.size > 0)
      .map((seat) => ({ id: seat.spec.id, name: seat.spec.name }));
  }

  private broadcastSnapshot(): void {
    this.broadcast(this.snapshotMessage());
  }

  /** To everyone connected: seated, waiting for the next match, or just watching. */
  private broadcast(message: ServerMessage): void {
    const payload = encode(message);
    for (const seat of [...this.seats.values(), ...this.waiting.values()]) {
      for (const socket of seat.sockets) {
        try {
          socket.send(payload);
        } catch {
          seat.sockets.delete(socket);
        }
      }
    }
    for (const socket of this.spectators) {
      try {
        socket.send(payload);
      } catch {
        this.spectators.delete(socket);
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
      wins: this.wins,
      matchId: this.matchId,
      matchStartedAt: this.matchStartedAt,
      tally: this.tally,
    };
    void this.state.storage.put('table', payload);
  }

  private restore(saved: PersistedTable): void {
    this.code = saved.code;
    this.hostId = saved.hostId;
    this.wins = { ...(saved.wins ?? {}) };
    this.matchId = saved.matchId ?? null;
    this.matchStartedAt = saved.matchStartedAt ?? null;
    this.tally = saved.tally ?? createTally();
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
  /** Missing from tables saved before wins were counted. */
  wins?: WinTally;
  /** Missing from tables saved before results were recorded. */
  matchId?: string | null;
  matchStartedAt?: number | null;
  tally?: ShotTally;
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
