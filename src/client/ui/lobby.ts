/**
 * The front screen: pick a name, then play alone or with other people.
 *
 * Glass cards over the lamp-lit desk the boot screen leaves behind.
 */

import type { BotDifficulty } from '../../shared/game/bots';
import { normaliseCode } from '../../shared/game/codes';
import type { Account } from '../account/account';
import { colourFor } from '../render/theme';
import { CardArt, DeskBackdrop } from './backdrop';
import { ProfilePanel, googleButton } from './profile';

export type LobbyChoice =
  | { mode: 'solo'; name: string; botCount: number; difficulty: BotDifficulty }
  | { mode: 'create'; name: string }
  | { mode: 'join'; name: string; code: string };

const DIFFICULTIES: BotDifficulty[] = ['easy', 'normal', 'hard'];

export class Lobby {
  private readonly root: HTMLElement;
  private readonly onChoose: (choice: LobbyChoice) => void;
  private readonly account: Account;
  private readonly profile: ProfilePanel;
  private readonly backdrop: DeskBackdrop;
  private readonly soloArt: CardArt;
  private readonly onlineArt: CardArt;
  private readonly accountBar = document.createElement('div');
  /** The account name last put in the name box, to tell it apart from the player's typing. */
  private shownName = '';

  private readonly nameField = document.createElement('label');
  private readonly nameInput = document.createElement('input');
  private readonly codeInput = document.createElement('input');
  private readonly difficultyGroup = document.createElement('fieldset');
  private readonly errorLine = document.createElement('p');

  constructor(root: HTMLElement, account: Account, onChoose: (choice: LobbyChoice) => void) {
    this.root = root;
    this.account = account;
    this.onChoose = onChoose;
    this.backdrop = new DeskBackdrop(root);
    this.soloArt = new CardArt('solo', colourFor(account.colour ?? 0));
    this.onlineArt = new CardArt('online', colourFor(0));
    this.build();
    this.profile = new ProfilePanel(root, account);
    this.renderAccount();
    account.onChange(() => this.renderAccount());
  }

  show(prefillCode?: string | null): void {
    this.root.classList.remove('hidden');
    this.backdrop.start();
    this.errorLine.textContent = '';
    if (prefillCode) this.codeInput.value = prefillCode;
    if (!this.account.signedIn) this.nameInput.focus({ preventScroll: true });
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.backdrop.stop();
  }

  setError(message: string): void {
    this.errorLine.textContent = message;
  }

  /**
   * Signed in, you play under your profile name, which is changed in the
   * profile. A guest types one here, and it is remembered on this device.
   */
  private get playerName(): string {
    if (this.account.signedIn) return this.account.name;
    return this.nameInput.value.trim().slice(0, 24) || 'Player';
  }

  private get difficulty(): BotDifficulty {
    const checked = this.difficultyGroup.querySelector<HTMLInputElement>('input:checked');
    return (checked?.value as BotDifficulty | undefined) ?? 'normal';
  }

  private rememberName(): void {
    if (this.account.signedIn) return;
    this.account.setName(this.playerName).catch((error: unknown) => {
      console.error('Could not save the name:', error);
    });
  }

  /** Who you are playing as, and the way in or out. */
  private renderAccount(): void {
    const { state } = this.account;
    const colour = colourFor(this.account.colour ?? 0);
    this.soloArt.setColour(colour);

    if (state.status === 'loading') {
      const label = document.createElement('span');
      label.className = 'account-label';
      label.textContent = 'Signing you in…';
      this.accountBar.replaceChildren(label);
    } else {
      const signedIn = state.status === 'signedIn';
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'account-chip';
      chip.setAttribute('aria-label', 'Open your profile');
      chip.addEventListener('click', () => this.profile.show());

      const avatar = document.createElement('span');
      avatar.className = 'account-avatar';
      avatar.style.setProperty('--ring', colour.body);
      const name = signedIn ? state.profile.displayName : 'Guest';
      avatar.textContent = name.trim().charAt(0).toUpperCase() || 'G';

      const text = document.createElement('span');
      text.className = 'account-text';
      const nameLine = document.createElement('span');
      nameLine.className = 'account-name';
      nameLine.textContent = name;
      const caption = document.createElement('span');
      caption.className = 'account-caption';
      caption.textContent = 'Profile';
      text.append(nameLine, caption);
      chip.append(avatar, text);

      if (signedIn) {
        const signOut = button('Sign out', 'ghost-button', () => {
          this.account.signOut().catch((error: unknown) => {
            console.error('Could not sign out:', error);
          });
        });
        this.accountBar.replaceChildren(chip, signOut);
      } else {
        this.accountBar.replaceChildren(chip, googleButton(this.account, 'Sign in'));
      }
    }

    // The name box is for guests. Signed in, the name lives in the profile.
    this.nameField.classList.toggle('hidden', state.status === 'signedIn');
    // Follow the account's name, unless the player has typed over it.
    if (this.nameInput.value === this.shownName) this.nameInput.value = this.account.name;
    this.shownName = this.account.name;

    if (this.account.signInError) {
      this.setError(`Sign-in failed: ${this.account.signInError}`);
      this.account.signInError = null;
    }
  }

  private build(): void {
    this.root.classList.add('lobby');

    const page = document.createElement('div');
    page.className = 'lobby-page';

    // --- top bar ---
    const top = document.createElement('header');
    top.className = 'lobby-top';
    const mark = document.createElement('span');
    mark.className = 'lobby-mark';
    mark.textContent = 'Pen Fight';
    this.accountBar.className = 'account-bar';
    top.append(mark, this.accountBar);

    // --- title and name ---
    const hero = document.createElement('section');
    hero.className = 'lobby-hero';
    const title = document.createElement('h1');
    title.className = 'lobby-title';
    title.textContent = 'Pen Fight';
    const tagline = document.createElement('p');
    tagline.className = 'tagline';
    tagline.textContent = 'Flick your pen. Knock everyone else off the table. Last pen standing wins.';

    this.nameField.className = 'name-field';
    const nameCaption = document.createElement('span');
    nameCaption.className = 'eyebrow';
    nameCaption.textContent = 'Playing as';
    this.nameInput.type = 'text';
    this.nameInput.maxLength = 24;
    this.nameInput.placeholder = 'Your name';
    this.nameInput.value = this.shownName = this.account.name;
    this.nameInput.className = 'text-input';
    this.nameField.append(nameCaption, this.nameInput);
    hero.append(title, tagline, this.nameField);

    // --- solo ---
    this.difficultyGroup.className = 'segmented';
    const legend = document.createElement('legend');
    legend.className = 'visually-hidden';
    legend.textContent = 'Bot difficulty';
    this.difficultyGroup.append(legend);
    for (const level of DIFFICULTIES) {
      const option = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'difficulty';
      radio.value = level;
      radio.checked = level === 'normal';
      const text = document.createElement('span');
      text.textContent = level[0].toUpperCase() + level.slice(1);
      option.append(radio, text);
      this.difficultyGroup.append(option);
    }

    const soloButton = button('Play solo', 'primary-button', () => {
      this.rememberName();
      this.onChoose({
        mode: 'solo',
        name: this.playerName,
        botCount: 3,
        difficulty: this.difficulty,
      });
    });

    const soloCard = modeCard(
      this.soloArt,
      'Solo',
      'A four-pen table: you against three bots.',
      this.difficultyGroup,
      soloButton,
    );

    // --- online ---
    const createButton = button('Create a table', 'primary-button', () => {
      this.rememberName();
      this.onChoose({ mode: 'create', name: this.playerName });
    });

    this.codeInput.type = 'text';
    this.codeInput.maxLength = 5;
    this.codeInput.placeholder = 'Code';
    this.codeInput.className = 'text-input code-input';
    this.codeInput.autocapitalize = 'characters';
    this.codeInput.spellcheck = false;
    this.codeInput.setAttribute('aria-label', 'Table code');
    this.codeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') joinButton.click();
    });

    const joinButton = button('Join', 'secondary-button', () => {
      const code = normaliseCode(this.codeInput.value);
      if (!code) {
        this.setError('That code does not look right — it is five characters.');
        return;
      }
      this.rememberName();
      this.onChoose({ mode: 'join', name: this.playerName, code });
    });

    const joinRow = document.createElement('div');
    joinRow.className = 'row';
    joinRow.append(this.codeInput, joinButton);

    const onlineCard = modeCard(
      this.onlineArt,
      'Online',
      'Up to ten pens on one table. Share the code to invite people.',
      joinRow,
      createButton,
    );

    const modes = document.createElement('div');
    modes.className = 'lobby-modes';
    modes.append(soloCard, onlineCard);

    this.errorLine.className = 'error';
    this.errorLine.setAttribute('role', 'alert');

    // --- rules ---
    const howTo = document.createElement('details');
    howTo.className = 'how-to';
    const summary = document.createElement('summary');
    summary.textContent = 'How it plays';
    const rules = document.createElement('ul');
    for (const line of [
      'Take it in turns. On yours, grab your own pen anywhere along its length.',
      'Pull away from where you want it to go, then let go — a longer pull hits harder.',
      'Grab the middle and it slides straight. Grab a tip and it spins, sweeping a much wider path.',
      'A pen is out when its centre passes the edge of the table. Its owner is out with it.',
    ]) {
      const item = document.createElement('li');
      item.textContent = line;
      rules.append(item);
    }
    howTo.append(summary, rules);

    page.append(top, hero, modes, this.errorLine, howTo);
    this.root.append(page);
  }
}

/** A glass card: its little scene on top, then what it is and how to start it. */
function modeCard(
  art: CardArt,
  title: string,
  description: string,
  options: HTMLElement,
  action: HTMLElement,
): HTMLElement {
  const card = document.createElement('article');
  card.className = 'mode-card';
  const body = document.createElement('div');
  body.className = 'mode-body';
  const heading = document.createElement('h2');
  heading.className = 'mode-title';
  heading.textContent = title;
  const text = document.createElement('p');
  text.className = 'section-body';
  text.textContent = description;
  body.append(heading, text, options, action);
  card.append(art.canvas, body);
  return card;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}
