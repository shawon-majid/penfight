/**
 * The front screen: pick a name, then play alone or with other people.
 */

import type { BotDifficulty } from '../../shared/game/bots';
import { normaliseCode } from '../../shared/game/codes';
import type { Account } from '../account/account';
import { ProfilePanel, googleButton } from './profile';

export type LobbyChoice =
  | { mode: 'solo'; name: string; botCount: number; difficulty: BotDifficulty }
  | { mode: 'create'; name: string }
  | { mode: 'join'; name: string; code: string };

export class Lobby {
  private readonly root: HTMLElement;
  private readonly onChoose: (choice: LobbyChoice) => void;
  private readonly account: Account;
  private readonly profile: ProfilePanel;
  private readonly accountBar = document.createElement('div');
  /** The account name last put in the name box, to tell it apart from the player's typing. */
  private shownName = '';

  private readonly nameInput = document.createElement('input');
  private readonly codeInput = document.createElement('input');
  private readonly difficultySelect = document.createElement('select');
  private readonly errorLine = document.createElement('p');

  constructor(root: HTMLElement, account: Account, onChoose: (choice: LobbyChoice) => void) {
    this.root = root;
    this.account = account;
    this.onChoose = onChoose;
    this.build();
    this.profile = new ProfilePanel(root, account);
    this.renderAccount();
    account.onChange(() => this.renderAccount());
  }

  show(prefillCode?: string | null): void {
    this.root.classList.remove('hidden');
    this.errorLine.textContent = '';
    if (prefillCode) this.codeInput.value = prefillCode;
    if (!this.account.signedIn) this.nameInput.focus();
  }

  hide(): void {
    this.root.classList.add('hidden');
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

  private rememberName(): void {
    if (this.account.signedIn) return;
    this.account.setName(this.playerName).catch((error: unknown) => {
      console.error('Could not save the name:', error);
    });
  }

  /** Who you are playing as, and the way in or out. */
  private renderAccount(): void {
    const { state } = this.account;
    const label = document.createElement('span');
    label.className = 'account-label';
    const profileButton = button('Profile', 'ghost-button', () => this.profile.show());

    if (state.status === 'signedIn') {
      label.textContent = `Signed in as ${state.profile.displayName}`;
      const signOut = button('Sign out', 'ghost-button', () => {
        this.account.signOut().catch((error: unknown) => {
          console.error('Could not sign out:', error);
        });
      });
      this.accountBar.replaceChildren(label, profileButton, signOut);
    } else if (state.status === 'loading') {
      label.textContent = 'Signing you in…';
      this.accountBar.replaceChildren(label);
    } else {
      label.textContent = 'Playing as a guest';
      this.accountBar.replaceChildren(label, profileButton, googleButton(this.account, 'Sign in'));
    }

    // The name box is for guests. Signed in, the name lives in the profile.
    this.nameInput.classList.toggle('hidden', state.status === 'signedIn');
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

    const card = document.createElement('div');
    card.className = 'lobby-card';

    const title = document.createElement('h1');
    title.textContent = 'Pen Fight';
    const tagline = document.createElement('p');
    tagline.className = 'tagline';
    tagline.textContent =
      'Flick your pen. Knock everyone else off the table. Last pen standing wins.';

    // --- name ---
    this.nameInput.type = 'text';
    this.nameInput.maxLength = 24;
    this.nameInput.placeholder = 'Your name';
    this.nameInput.value = this.shownName = this.account.name;
    this.nameInput.className = 'text-input';

    // --- solo ---
    const soloSection = document.createElement('section');
    const soloTitle = document.createElement('h2');
    soloTitle.textContent = 'Play on your own';
    const soloBody = document.createElement('p');
    soloBody.className = 'section-body';
    soloBody.textContent = 'A four-pen table: you against three bots.';

    for (const level of ['easy', 'normal', 'hard'] as const) {
      const option = document.createElement('option');
      option.value = level;
      option.textContent = level[0].toUpperCase() + level.slice(1);
      this.difficultySelect.append(option);
    }
    this.difficultySelect.value = 'normal';
    this.difficultySelect.className = 'text-input';
    this.difficultySelect.setAttribute('aria-label', 'Bot difficulty');

    const soloButton = button('Play solo', 'primary-button', () => {
      this.rememberName();
      this.onChoose({
        mode: 'solo',
        name: this.playerName,
        botCount: 3,
        difficulty: this.difficultySelect.value as BotDifficulty,
      });
    });

    const soloRow = document.createElement('div');
    soloRow.className = 'row';
    soloRow.append(this.difficultySelect, soloButton);
    soloSection.append(soloTitle, soloBody, soloRow);

    // --- online ---
    const onlineSection = document.createElement('section');
    const onlineTitle = document.createElement('h2');
    onlineTitle.textContent = 'Play with friends';
    const onlineBody = document.createElement('p');
    onlineBody.className = 'section-body';
    onlineBody.textContent = 'Up to ten pens on one table. Share the code to invite people.';

    const createButton = button('Create a table', 'primary-button', () => {
      this.rememberName();
      this.onChoose({ mode: 'create', name: this.playerName });
    });

    this.codeInput.type = 'text';
    this.codeInput.maxLength = 5;
    this.codeInput.placeholder = 'Code';
    this.codeInput.className = 'text-input code-input';
    this.codeInput.autocapitalize = 'characters';
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
    onlineSection.append(onlineTitle, onlineBody, createButton, joinRow);

    this.errorLine.className = 'error';

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

    this.accountBar.className = 'account-bar';

    card.append(
      this.accountBar,
      title,
      tagline,
      this.nameInput,
      soloSection,
      onlineSection,
      this.errorLine,
      howTo,
    );
    this.root.append(card);
  }
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}
