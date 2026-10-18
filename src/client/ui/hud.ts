/**
 * The overlay: who is playing, whose turn it is, and what just happened.
 *
 * Plain DOM on top of the canvas. Player names come from other people, so they
 * are always set with `textContent` and never interpolated into markup.
 */

import type { Match, Player } from '../../shared/game/match';
import { currentPlayer, inOpeningRound, playerById, standings } from '../../shared/game/match';
import { colourFor, type ViewportInsets } from '../render/theme';
import type { Session } from '../modes/session';
import { strikeablePen } from '../modes/session';
import { inviteButton } from './invite';
import type { TurnClock } from '../render/renderer';

/** How long "Time's up" stays in the turn banner. */
const SKIP_NOTE_MS = 2400;

export interface HudCallbacks {
  onRematch: () => void;
  onStart?: () => void;
  onLeave: () => void;
}

export class Hud {
  private readonly root: HTMLElement;
  private readonly callbacks: HudCallbacks;

  private readonly codeCaption = document.createElement('span');
  private readonly codeLabel = document.createElement('strong');
  private readonly copyButton = document.createElement('button');
  private readonly turnBanner = document.createElement('div');
  private readonly turnText = document.createElement('span');
  private readonly turnClock = document.createElement('span');
  /** The thin bar under the chip of whoever is on, draining with their clock. */
  private clockBar: HTMLElement | null = null;
  private shownSeconds: number | null = null;
  /** The skip being announced in the banner, until it times out. */
  private showingSkip: number | null = null;
  private session: Session | null = null;
  private readonly noticeBar = document.createElement('div');
  /** The scoreboard: a glass panel down the side, or a row of chips on a phone. */
  private readonly playerPanel = document.createElement('section');
  private readonly playerCount = document.createElement('span');
  private readonly playerList = document.createElement('ul');
  private readonly hint = document.createElement('div');
  /** The opening-round rule, and which pens it just saved. */
  private readonly roundNote = document.createElement('div');
  private readonly overlay = document.createElement('div');
  private readonly overlayTitle = document.createElement('h2');
  private readonly overlayBody = document.createElement('p');
  private readonly overlayAction = document.createElement('button');
  /** The roster in the lobby, the standings at the end. */
  private readonly overlayList = document.createElement('ol');
  private readonly overlayLeave = document.createElement('button');
  /** The table code and invite on the results, online only. */
  private readonly overlayInvite = document.createElement('div');
  private readonly overlayCode = document.createElement('strong');
  private readonly overlayWaiting = document.createElement('p');
  private readonly leaveButton = document.createElement('button');

  /** The space kept clear for the display this match, and the screen size it was measured at. */
  private reserved: ViewportInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private reservedFor = '';
  private readonly gestureHint: string;

  constructor(root: HTMLElement, callbacks: HudCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
    const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    this.gestureHint = touch
      ? 'Drag from your pen and let go. Grab a tip to spin it.'
      : 'Grab your pen anywhere along its length, pull back, and let go. Grab a tip to make it spin.';
    this.build();
  }

  private build(): void {
    this.root.classList.add('hud');

    const top = document.createElement('header');
    top.className = 'hud-top';

    const code = document.createElement('div');
    code.className = 'table-code';
    this.codeCaption.className = 'eyebrow';
    this.copyButton.type = 'button';
    this.copyButton.className = 'ghost-button';
    inviteButton(this.copyButton, () => this.codeLabel.textContent ?? '');
    code.append(this.codeCaption, this.codeLabel, this.copyButton);

    this.leaveButton.type = 'button';
    this.leaveButton.className = 'ghost-button';
    this.leaveButton.textContent = 'Leave';
    this.leaveButton.addEventListener('click', () => this.callbacks.onLeave());

    this.turnBanner.className = 'turn-banner';
    this.turnText.className = 'turn-text';
    this.turnClock.className = 'turn-clock hidden';
    this.turnClock.setAttribute('role', 'timer');
    this.turnBanner.append(this.turnText, this.turnClock);
    top.append(code, this.turnBanner, this.leaveButton);

    this.playerPanel.className = 'player-panel';
    this.playerPanel.setAttribute('aria-label', 'Players');
    const panelHead = document.createElement('header');
    panelHead.className = 'player-panel-head';
    const panelTitle = document.createElement('span');
    panelTitle.className = 'eyebrow';
    panelTitle.textContent = 'Players';
    this.playerCount.className = 'player-count';
    panelHead.append(panelTitle, this.playerCount);
    this.playerList.className = 'player-list';
    this.playerPanel.append(panelHead, this.playerList);
    this.noticeBar.className = 'notice';
    this.hint.className = 'hint';
    this.roundNote.className = 'round-note';
    this.roundNote.setAttribute('aria-live', 'polite');

    this.overlay.className = 'overlay hidden';
    this.overlayAction.type = 'button';
    this.overlayAction.className = 'primary-button';
    this.overlayAction.addEventListener('click', () => this.overlayAction.dataset.action === 'start'
      ? this.callbacks.onStart?.()
      : this.callbacks.onRematch());
    this.overlayLeave.type = 'button';
    this.overlayLeave.className = 'secondary-button';
    this.overlayLeave.addEventListener('click', () => this.callbacks.onLeave());
    this.overlayList.className = 'overlay-list';

    const overlayActions = document.createElement('div');
    overlayActions.className = 'overlay-actions';
    overlayActions.append(this.overlayAction, this.overlayLeave);

    const overlayCard = document.createElement('div');
    overlayCard.className = 'overlay-card';
    this.overlayInvite.className = 'overlay-invite';
    const inviteCaption = document.createElement('span');
    inviteCaption.className = 'eyebrow';
    inviteCaption.textContent = 'Table';
    this.overlayCode.className = 'overlay-code';
    const inviteRow = document.createElement('div');
    inviteRow.className = 'overlay-invite-row';
    const invite = document.createElement('button');
    invite.type = 'button';
    invite.className = 'ghost-button';
    inviteButton(invite, () => this.overlayCode.textContent ?? '');
    inviteRow.append(this.overlayCode, invite);
    this.overlayWaiting.className = 'overlay-waiting';
    this.overlayInvite.append(inviteCaption, inviteRow, this.overlayWaiting);

    overlayCard.append(
      this.overlayTitle,
      this.overlayList,
      this.overlayInvite,
      this.overlayBody,
      overlayActions,
    );
    this.overlay.append(overlayCard);

    this.root.append(
      top,
      this.playerPanel,
      this.roundNote,
      this.hint,
      this.noticeBar,
      this.overlay,
    );
  }

  /**
   * How much of the screen the display is using, so the table can be laid out
   * clear of it.
   *
   * Measured from the elements themselves rather than mirrored from the CSS
   * breakpoints — the two could drift apart, and the symptom would be a pen
   * hidden under somebody's name.
   */
  reservedSpace(): ViewportInsets {
    const root = this.root.getBoundingClientRect();
    const topBar = this.turnBanner.parentElement!.getBoundingClientRect();

    let top = Math.max(0, topBar.bottom - root.top);
    let left = 0;

    // The players are a panel down the side on a wide screen and a row of
    // chips across the top on a phone held upright. Ask which, rather than guess.
    //
    // As a row, the chips are measured rather than the list, which stretches
    // to the full width whatever is in it.
    const isColumn = getComputedStyle(this.playerList).flexDirection.startsWith('column');
    if (isColumn) {
      left = Math.max(0, this.playerPanel.getBoundingClientRect().right - root.left);
    } else {
      const chips = [...this.playerList.children].map((chip) => chip.getBoundingClientRect());
      if (chips.length > 0) {
        top = Math.max(top, Math.max(...chips.map((chip) => chip.bottom)) - root.top);
      }
    }

    // Whichever of the round note, the hint and the notice is showing sits at
    // the bottom.
    const bottomEdges = [this.roundNote, this.hint, this.noticeBar]
      .filter((element) => element.textContent && element.offsetParent !== null)
      .map((element) => element.getBoundingClientRect().top);
    const bottom = bottomEdges.length
      ? Math.max(0, root.bottom - Math.min(...bottomEdges))
      : 0;

    // Notes come and go during a match — the hint on your turn, the opening
    // rule until the round ends — and following them would slide the table
    // around mid-game. So within one match on one screen size the reserved
    // space only ever grows.
    const size = `${Math.round(root.width)}x${Math.round(root.height)}`;
    if (size !== this.reservedFor) {
      this.reservedFor = size;
      this.reserved = { top: 0, right: 0, bottom: 0, left: 0 };
    }
    // Kept the same on opposite sides, so the table sits in the middle of the
    // screen rather than the middle of whatever space happens to be left.
    const across = Math.max(this.reserved.left, left);
    const down = Math.max(this.reserved.top, top, bottom);
    this.reserved = { top: down, right: across, bottom: down, left: across };
    return this.reserved;
  }

  /** A new match: let the reserved space settle afresh. */
  resetLayout(): void {
    this.reservedFor = '';
  }

  update(session: Session): void {
    this.session = session;
    const { match } = session;
    // Solo has no code to share; the bar just says what kind of table it is.
    const solo = match.code === 'SOLO';
    this.codeCaption.textContent = solo ? 'Solo' : 'Table';
    this.codeLabel.textContent = solo ? '' : match.code;
    this.copyButton.hidden = solo;

    this.renderPlayers(match, session);
    this.renderTurn(session);
    this.renderRoundNote(match);
    this.renderNotice(session);
    this.renderOverlay(session);
  }

  private renderPlayers(match: Match, session: Session): void {
    const { youAre } = session;
    this.playerList.replaceChildren();
    this.clockBar = null;
    const inPlay = match.phase === 'aiming' || match.phase === 'resolving';

    const standing = match.players.filter((player) => !player.eliminated).length;
    this.playerCount.textContent = inPlay
      ? `${standing} of ${match.players.length} left`
      : `${match.players.length} at the table`;

    for (const [index, player] of match.players.entries()) {
      const onTurn = inPlay && index === match.turnIndex;
      const tags: string[] = [];
      if (player.eliminated) {
        tags.push(player.outOnTurn !== null ? `Out \u00b7 turn ${player.outOnTurn + 1}` : 'Out');
      } else {
        if (player.id === youAre) tags.push('You');
        if (player.isBot) tags.push('Bot');
        if (player.id === session.hostId && match.code !== 'SOLO') tags.push('Host');
        if (!player.isBot && !player.connected) tags.push('Away');
        if (onTurn) tags.push(match.phase === 'aiming' ? 'aiming' : 'moving');
      }

      const item = playerRow(
        player.name,
        colourFor(player.colourIndex).body,
        tags.join(' \u00b7 '),
        session.wins[player.id] ?? 0,
      );
      if (player.eliminated) item.classList.add('is-out');
      if (onTurn) item.classList.add('is-turn');
      if (player.id === youAre) item.classList.add('is-you');

      if (onTurn && match.phase === 'aiming') {
        this.clockBar = document.createElement('span');
        this.clockBar.className = 'chip-clock';
        this.clockBar.hidden = true;
        item.append(this.clockBar);
      }
      this.playerList.append(item);
    }

    // People who arrived mid-match, dealt in when the next one starts.
    for (const player of session.waiting ?? []) {
      const tag = player.id === youAre ? 'You \u00b7 next round' : 'Next round';
      const item = playerRow(player.name, null, tag, null);
      item.classList.add('is-waiting');
      this.playerList.append(item);
    }
  }

  /**
   * Every frame: the turn clock, and the brief "time's up" note when a turn is
   * passed over. Cheap when nothing changed — it only touches the page when the
   * number of seconds does.
   */
  tick(clock: TurnClock | null): void {
    const session = this.session;

    const skip = session?.lastSkip;
    const skipFresh = skip && performance.now() - skip.at < SKIP_NOTE_MS;
    if (skipFresh && session) {
      // Re-asserted every frame: an update landing just after the skip would
      // otherwise paint over the note straight away.
      this.showingSkip = skip.at;
      const who = playerById(session.match, skip.playerId);
      const note =
        skip.reason === 'timeout'
          ? skip.playerId === session.youAre
            ? 'Time\u2019s up \u2014 your turn was skipped'
            : `Time\u2019s up \u2014 ${who ? `${who.name}\u2019s` : 'a'} turn skipped`
          : `${who?.name ?? 'A player'} is away \u2014 turn skipped`;
      if (this.turnText.textContent !== note) {
        this.turnText.textContent = note;
        this.turnText.style.color = 'var(--danger)';
      }
    } else if (this.showingSkip !== null && session) {
      this.showingSkip = null;
      this.renderTurn(session);
    }

    const showClock = clock !== null && this.showingSkip === null;
    this.turnClock.classList.toggle('hidden', !showClock);
    if (this.clockBar) this.clockBar.hidden = clock === null;
    if (!clock) {
      this.shownSeconds = null;
      return;
    }

    const seconds = Math.ceil(clock.secondsLeft);
    if (seconds !== this.shownSeconds) {
      this.shownSeconds = seconds;
      this.turnClock.textContent = `0:${String(seconds).padStart(2, '0')}`;
      this.turnClock.setAttribute('aria-label', `${seconds} seconds left`);
      this.turnClock.classList.toggle('is-warning', clock.warning);
      this.clockBar?.classList.toggle('is-warning', clock.warning);
    }
    if (this.clockBar) this.clockBar.style.setProperty('--left', String(clock.fraction));
  }

  private renderTurn(session: Session): void {
    const { match } = session;

    if (match.phase === 'lobby') {
      this.turnText.textContent = 'Waiting for players';
      this.showHint(false);
      return;
    }

    if (match.phase === 'finished') {
      this.turnText.textContent = 'Game over';
      this.showHint(false);
      return;
    }

    const player = currentPlayer(match);
    if (!player) {
      this.turnText.textContent = '';
      return;
    }

    const yours = player.id === session.youAre;
    if (match.phase === 'resolving') {
      this.turnText.textContent = 'Pens are moving…';
    } else if (match.turnNumber === 0) {
      // The first player is drawn at random; say so, or it looks like a bug.
      this.turnText.textContent = yours ? 'You go first' : `${player.name} goes first`;
    } else {
      this.turnText.textContent = yours ? 'Your turn' : `${player.name} is aiming`;
    }
    this.turnText.style.color = colourFor(player.colourIndex).accent;

    // Teach the gesture, but only while it is actually usable. The short form
    // is for phones, where a long line of text eats the screen.
    this.showHint(strikeablePen(session) !== null);
    if (session.waiting?.some((player) => player.id === session.youAre)) {
      this.hint.textContent = 'You\u2019re in the next round \u2014 watch this one.';
      this.hint.style.visibility = '';
    }
  }

  /**
   * Hidden rather than emptied: the line keeps its space, so the table is laid
   * out around it from the start and does not shift when your turn comes.
   */
  private showHint(visible: boolean): void {
    this.hint.textContent = this.gestureHint;
    this.hint.style.visibility = visible ? '' : 'hidden';
  }

  private renderRoundNote(match: Match): void {
    const lines: string[] = [];
    const inPlay = match.phase === 'aiming' || match.phase === 'resolving';

    if (inPlay && match.returnedToStart.length > 0 && match.phase === 'aiming') {
      const names = match.returnedToStart
        .map((id) => playerById(match, id)?.name)
        .filter((name): name is string => Boolean(name));
      if (names.length > 0) {
        lines.push(
          names.length === 1
            ? `${names[0]}'s pen went back to its start.`
            : `${names.join(', ')}'s pens went back to their starts.`,
        );
      }
    }

    if (inPlay && inOpeningRound(match)) {
      lines.push(
        'Opening round: a pen knocked off by someone else goes back to its start. ' +
          'Knock yourself off and you are out.',
      );
    } else if (match.phase === 'aiming' && match.openingEndedOnTurn === match.turnNumber) {
      lines.push('Opening round over. Every knock-out counts from now on.');
    }

    this.roundNote.textContent = lines.join(' ');
    this.roundNote.classList.toggle('hidden', lines.length === 0);
  }

  private renderNotice(session: Session): void {
    this.noticeBar.textContent = session.notice ?? '';
    this.noticeBar.classList.toggle('hidden', !session.notice);
  }

  private renderOverlay(session: Session): void {
    const { match } = session;
    const isHost = session.hostId !== null && session.hostId === session.youAre;
    const host = session.hostId ? playerById(match, session.hostId) : undefined;
    const hostName = host?.name ?? 'the host';
    this.overlayLeave.textContent = match.code === 'SOLO' ? 'Back to menu' : 'Leave table';

    // Before the game the waiting room has the screen; see ui/room.ts.
    if (match.phase === 'lobby') {
      this.overlay.classList.add('hidden');
      return;
    }

    if (match.phase === 'finished') {
      const winner = match.players.find((player) => player.id === match.winnerId);
      this.overlay.classList.remove('hidden');
      this.overlayTitle.textContent = winner
        ? winner.id === session.youAre
          ? 'You win'
          : `${winner.name} wins`
        : 'Everybody fell off';
      this.renderStandings(match, session);
      this.overlayBody.textContent = isHost
        ? winner
          ? ''
          : 'Nobody left on the table. Call it a draw.'
        : `Waiting for ${hostName} to start the next game.`;
      this.overlayAction.dataset.action = 'rematch';
      this.overlayAction.textContent = 'Play again';
      this.overlayAction.hidden = !isHost;
      this.overlayBody.hidden = !this.overlayBody.textContent;
      this.renderTableInvite(session);
      return;
    }

    this.overlay.classList.add('hidden');
  }

  /**
   * Online, the results also carry the way in: the table code to read out, an
   * invite to send, and who is already waiting to be dealt in.
   */
  private renderTableInvite(session: Session): void {
    const { match } = session;
    const solo = match.code === 'SOLO';
    this.overlayInvite.hidden = solo;
    if (solo) return;
    this.overlayCode.textContent = match.code;

    const waiting = session.waiting ?? [];
    const you = waiting.some((player) => player.id === session.youAre);
    const names = waiting.map((player) => (player.id === session.youAre ? 'you' : player.name));
    this.overlayWaiting.textContent = waiting.length
      ? `Joining next round: ${names.join(', ')}`
      : 'Share the code to bring more people in.';
    this.overlayWaiting.classList.toggle('is-you', you);
  }

  /** Final places, with each player's wins at this table. */
  private renderStandings(match: Match, session: Session): void {
    this.overlayList.replaceChildren(
      ...standings(match).map(({ player, place }) => {
        const wins = session.wins[player.id] ?? 0;
        return this.overlayRow(player, session, ordinal(place), `${wins} ${wins === 1 ? 'win' : 'wins'}`);
      }),
    );
  }

  private overlayRow(
    player: Player,
    session: Session,
    place: string | null,
    detail: string,
  ): HTMLLIElement {
    const row = document.createElement('li');
    row.className = 'overlay-row';
    if (player.id === session.youAre) row.classList.add('is-you');

    if (place) {
      const placeLabel = document.createElement('span');
      placeLabel.className = 'overlay-place';
      placeLabel.textContent = place;
      row.append(placeLabel);
    }

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = swatch.style.color = colourFor(player.colourIndex).body;

    const name = document.createElement('span');
    name.className = 'overlay-name';
    name.textContent = player.id === session.youAre ? `${player.name} (you)` : player.name;

    const extra = document.createElement('span');
    extra.className = 'overlay-detail';
    extra.textContent = detail;

    row.append(swatch, name, extra);
    return row;
  }
}

/**
 * One row of the scoreboard: an avatar ring in the player's colour, their name
 * with what they are up to underneath, and their wins at this table.
 *
 * @param colour null for someone not yet dealt in — an empty ring.
 * @param wins null to leave the column out.
 */
function playerRow(name: string, colour: string | null, tags: string, wins: number | null): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'player';

  const avatar = document.createElement('span');
  avatar.className = 'player-avatar';
  avatar.textContent = name.trim().charAt(0).toUpperCase() || '?';
  if (colour) avatar.style.setProperty('--ring', colour);

  const text = document.createElement('span');
  text.className = 'player-text';
  const label = document.createElement('span');
  label.className = 'player-name';
  label.textContent = name;
  const status = document.createElement('span');
  status.className = 'player-status';
  status.textContent = tags;
  text.append(label, status);
  item.append(avatar, text);

  if (wins !== null) {
    const tally = document.createElement('span');
    tally.className = 'player-wins';
    tally.textContent = String(wins);
    const caption = document.createElement('small');
    caption.textContent = wins === 1 ? 'win' : 'wins';
    tally.append(caption);
    item.append(tally);
  }
  return item;
}

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th". */
function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}
