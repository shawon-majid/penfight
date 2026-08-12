/**
 * The overlay: who is playing, whose turn it is, and what just happened.
 *
 * Plain DOM on top of the canvas. Player names come from other people, so they
 * are always set with `textContent` and never interpolated into markup.
 */

import type { Match, Player } from '../../shared/game/match';
import { currentPlayer } from '../../shared/game/match';
import { colourFor, type ViewportInsets } from '../render/theme';
import type { Session } from '../modes/session';
import { strikeablePen } from '../modes/session';

export interface HudCallbacks {
  onRematch: () => void;
  onStart?: () => void;
  onLeave: () => void;
}

export class Hud {
  private readonly root: HTMLElement;
  private readonly callbacks: HudCallbacks;

  private readonly codeLabel = document.createElement('strong');
  private readonly copyButton = document.createElement('button');
  private readonly turnBanner = document.createElement('div');
  private readonly noticeBar = document.createElement('div');
  private readonly playerList = document.createElement('ul');
  private readonly hint = document.createElement('div');
  private readonly overlay = document.createElement('div');
  private readonly overlayTitle = document.createElement('h2');
  private readonly overlayBody = document.createElement('p');
  private readonly overlayAction = document.createElement('button');
  private readonly leaveButton = document.createElement('button');

  private lastCopiedCode: string | null = null;
  private readonly gestureHint: string;
  private readonly inviteLabel: string;

  constructor(root: HTMLElement, callbacks: HudCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
    const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    this.gestureHint = touch
      ? 'Drag from your pen and let go. Grab a tip to spin it.'
      : 'Grab your pen anywhere along its length, pull back, and let go. Grab a tip to make it spin.';
    this.inviteLabel = typeof navigator.share === 'function' ? 'Invite' : 'Copy invite';
    this.build();
  }

  private build(): void {
    this.root.classList.add('hud');

    const top = document.createElement('header');
    top.className = 'hud-top';

    const code = document.createElement('div');
    code.className = 'table-code';
    const codeCaption = document.createElement('span');
    codeCaption.textContent = 'Table';
    this.copyButton.type = 'button';
    this.copyButton.className = 'ghost-button';
    this.copyButton.textContent = this.inviteLabel;
    this.copyButton.addEventListener('click', () => this.copyInvite());
    code.append(codeCaption, this.codeLabel, this.copyButton);

    this.leaveButton.type = 'button';
    this.leaveButton.className = 'ghost-button';
    this.leaveButton.textContent = 'Leave';
    this.leaveButton.addEventListener('click', () => this.callbacks.onLeave());

    this.turnBanner.className = 'turn-banner';
    top.append(code, this.turnBanner, this.leaveButton);

    this.playerList.className = 'player-list';
    this.noticeBar.className = 'notice';
    this.hint.className = 'hint';

    this.overlay.className = 'overlay hidden';
    this.overlayAction.type = 'button';
    this.overlayAction.className = 'primary-button';
    this.overlayAction.addEventListener('click', () => this.overlayAction.dataset.action === 'start'
      ? this.callbacks.onStart?.()
      : this.callbacks.onRematch());
    const overlayCard = document.createElement('div');
    overlayCard.className = 'overlay-card';
    overlayCard.append(this.overlayTitle, this.overlayBody, this.overlayAction);
    this.overlay.append(overlayCard);

    this.root.append(top, this.playerList, this.hint, this.noticeBar, this.overlay);
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

    // The player list is a row across the top on a phone held upright and a
    // column down the side when held sideways. Ask which, rather than guess.
    //
    // The chips are measured, not the list element: the list stretches to its
    // container, and reserving that would leave a band of dead space beside a
    // column of short names.
    const chips = [...this.playerList.children].map((chip) => chip.getBoundingClientRect());
    if (chips.length > 0) {
      const isColumn = getComputedStyle(this.playerList).flexDirection.startsWith('column');
      if (isColumn) {
        left = Math.max(0, Math.max(...chips.map((chip) => chip.right)) - root.left);
      } else {
        top = Math.max(top, Math.max(...chips.map((chip) => chip.bottom)) - root.top);
      }
    }

    // Whichever of the hint and the notice is showing sits at the bottom.
    const bottomEdges = [this.hint, this.noticeBar]
      .filter((element) => element.textContent && element.offsetParent !== null)
      .map((element) => element.getBoundingClientRect().top);
    const bottom = bottomEdges.length
      ? Math.max(0, root.bottom - Math.min(...bottomEdges))
      : 0;

    return { top, right: 0, bottom, left };
  }

  update(session: Session): void {
    const { match } = session;
    this.codeLabel.textContent = match.code;
    this.copyButton.hidden = match.code === 'SOLO';

    this.renderPlayers(match, session.youAre);
    this.renderTurn(session);
    this.renderNotice(session);
    this.renderOverlay(session);
  }

  private renderPlayers(match: Match, youAre: string | null): void {
    this.playerList.replaceChildren();

    for (const [index, player] of match.players.entries()) {
      const item = document.createElement('li');
      item.className = 'player';
      if (player.eliminated) item.classList.add('is-out');
      if (index === match.turnIndex && match.phase !== 'finished') {
        item.classList.add('is-turn');
      }

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = colourFor(player.colourIndex).body;

      const name = document.createElement('span');
      name.className = 'player-name';
      name.textContent = player.id === youAre ? `${player.name} (you)` : player.name;

      const status = document.createElement('span');
      status.className = 'player-status';
      status.textContent = describeStatus(player);

      item.append(swatch, name, status);
      this.playerList.append(item);
    }
  }

  private renderTurn(session: Session): void {
    const { match } = session;

    if (match.phase === 'lobby') {
      this.turnBanner.textContent = 'Waiting for players';
      this.hint.textContent = '';
      return;
    }

    if (match.phase === 'finished') {
      this.turnBanner.textContent = 'Game over';
      this.hint.textContent = '';
      return;
    }

    const player = currentPlayer(match);
    if (!player) {
      this.turnBanner.textContent = '';
      return;
    }

    const yours = player.id === session.youAre;
    if (match.phase === 'resolving') {
      this.turnBanner.textContent = 'Pens are moving…';
    } else {
      this.turnBanner.textContent = yours ? 'Your turn' : `${player.name} is aiming`;
    }
    this.turnBanner.style.color = colourFor(player.colourIndex).accent;

    // Teach the gesture, but only while it is actually usable. The short form
    // is for phones, where a long line of text eats the screen.
    this.hint.textContent = strikeablePen(session) ? this.gestureHint : '';
  }

  private renderNotice(session: Session): void {
    this.noticeBar.textContent = session.notice ?? '';
    this.noticeBar.classList.toggle('hidden', !session.notice);
  }

  private renderOverlay(session: Session): void {
    const { match } = session;
    const isHost = session.hostId !== null && session.hostId === session.youAre;

    if (match.phase === 'lobby') {
      this.overlay.classList.remove('hidden');
      this.overlayTitle.textContent = `Table ${match.code}`;
      this.overlayBody.textContent =
        match.players.length < 2
          ? 'Share the code and wait for someone to join.'
          : `${match.players.length} players ready.`;
      this.overlayAction.dataset.action = 'start';
      this.overlayAction.textContent = 'Start the game';
      this.overlayAction.hidden = !isHost || match.players.length < 2;
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
      this.overlayBody.textContent = winner
        ? 'Last pen standing.'
        : 'Nobody left on the table. Call it a draw.';
      this.overlayAction.dataset.action = 'rematch';
      this.overlayAction.textContent = 'Play again';
      this.overlayAction.hidden = !isHost;
      return;
    }

    this.overlay.classList.add('hidden');
  }

  /**
   * Hand the invite over however this device does that.
   *
   * On a phone the share sheet is the natural route — one tap into whichever
   * chat the players are already in. Everywhere else, the clipboard.
   */
  private async copyInvite(): Promise<void> {
    const code = this.codeLabel.textContent ?? '';
    const invite = `${location.origin}/?table=${code}`;

    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Pen Fight', text: `Join my table: ${code}`, url: invite });
        return;
      } catch {
        // Cancelled, or sharing is not allowed here. Fall through to copying.
      }
    }

    try {
      await navigator.clipboard.writeText(invite);
      this.copyButton.textContent = 'Copied';
      this.lastCopiedCode = code;
      setTimeout(() => {
        if (this.lastCopiedCode === code) this.copyButton.textContent = this.inviteLabel;
      }, 1800);
    } catch {
      // Clipboard access can be refused; the code is on screen either way.
      this.copyButton.textContent = 'Copy failed';
    }
  }
}

function describeStatus(player: Player): string {
  if (player.eliminated) return 'out';
  if (player.isBot) return 'bot';
  if (!player.connected) return 'away';
  return '';
}
