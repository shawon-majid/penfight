/**
 * The profile panel: your name, pen colour and record, and signing in or out.
 *
 * Opens over the lobby. Guests see only an offer to sign in; everything else
 * belongs to an account. Signed in, this is the one place the name is changed.
 * Everything shown here that came from a person (names) is set with
 * `textContent`.
 */

import type { BotDifficulty } from '../../shared/game/bots';
import type { Account, ProfileSummary, RecentMatch } from '../account/account';
import { home, SIGN_IN_ON_THIS_PAGE } from '../net/server';
import { PLAYER_COLOURS } from '../render/theme';

const DIFFICULTIES: BotDifficulty[] = ['easy', 'normal', 'hard'];

export class ProfilePanel {
  private readonly root = document.createElement('div');
  private readonly body = document.createElement('div');
  private readonly account: Account;
  /** Bumped on every render so a slow stats request cannot paint over a newer one. */
  private renderId = 0;
  /** Which kind of player the panel was last drawn for. */
  private renderedStatus: string | null = null;
  private readonly onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') this.hide();
  };

  constructor(host: HTMLElement, account: Account) {
    this.account = account;
    this.root.className = 'profile-backdrop hidden';
    this.root.addEventListener('click', (event) => {
      if (event.target === this.root) this.hide();
    });

    const card = document.createElement('div');
    card.className = 'profile-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'profile-title');

    const header = document.createElement('header');
    header.className = 'profile-header';
    const title = document.createElement('h2');
    title.id = 'profile-title';
    title.textContent = 'Profile';
    const close = button('Close', 'ghost-button', () => this.hide());
    header.append(title, close);

    card.append(header, this.body);
    this.root.append(card);
    host.append(this.root);

    account.onChange(() => {
      if (this.root.classList.contains('hidden')) return;
      // Signing in or out redraws everything. A colour or name change only
      // needs the swatches, and redrawing the rest would refetch the record
      // and throw away keyboard focus.
      if (this.account.state.status === this.renderedStatus) this.markColour();
      else void this.render();
    });
  }

  show(): void {
    this.root.classList.remove('hidden');
    document.addEventListener('keydown', this.onKey);
    void this.render();
    this.root.querySelector<HTMLButtonElement>('.profile-header button')?.focus();
  }

  hide(): void {
    this.root.classList.add('hidden');
    document.removeEventListener('keydown', this.onKey);
  }

  private markColour(): void {
    const current = this.account.colour;
    for (const [index, swatch] of this.root.querySelectorAll('.colour-swatch').entries()) {
      swatch.setAttribute('aria-checked', String(index === current));
    }
  }

  private async render(): Promise<void> {
    const id = ++this.renderId;
    const { state } = this.account;
    this.renderedStatus = state.status;

    const accountSection = section('Account');

    if (state.status === 'loading') {
      accountSection.append(paragraph('Signing you in…'));
      this.body.replaceChildren(accountSection);
      return;
    }

    if (state.status !== 'signedIn') {
      accountSection.append(
        paragraph(
          'Sign in to see your stats and save your progress — your name, pen colour, ' +
            'and every game you play, online or against the bots, on any device.',
        ),
        googleButton(this.account),
      );
      this.body.replaceChildren(accountSection);
      return;
    }

    accountSection.append(
      paragraph(state.email ? `Signed in as ${state.email}.` : 'Signed in with Google.'),
      button('Sign out', 'secondary-button', () => void this.account.signOut()),
    );

    const nameSection = section('Name');
    nameSection.append(
      paragraph('What everyone at the table sees.'),
      this.nameEditor(),
    );

    const colourSection = section('Pen colour');
    colourSection.append(
      paragraph('Used whenever you can have it — if someone at the table got there first, you get another.'),
      this.colourPicker(),
    );

    const onlineSection = section('Online games');
    const botsSection = section('Against the bots');
    const recentSection = section('Recent games');

    onlineSection.append(paragraph('Loading…'));
    botsSection.append(paragraph('Loading…'));
    recentSection.append(paragraph('Loading…'));
    this.body.replaceChildren(
      accountSection,
      nameSection,
      colourSection,
      onlineSection,
      botsSection,
      recentSection,
    );

    try {
      const [summary, recent] = await Promise.all([
        this.account.summary(),
        this.account.recentMatches(),
      ]);
      if (id !== this.renderId || !summary) return;
      onlineSection.replaceChildren(onlineSection.firstChild!, onlineStats(summary));
      botsSection.replaceChildren(botsSection.firstChild!, botsTable(summary.solo));
      recentSection.replaceChildren(recentSection.firstChild!, recentList(recent));
    } catch (error) {
      if (id !== this.renderId) return;
      console.error('Could not load the profile:', error);
      const failed = paragraph('Could not load your record. Check your connection and try again.');
      onlineSection.replaceChildren(onlineSection.firstChild!, failed);
      botsSection.remove();
      recentSection.remove();
    }
  }

  private nameEditor(): HTMLElement {
    const wrapper = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'row';

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 24;
    input.className = 'text-input';
    input.value = this.account.name;
    input.setAttribute('aria-label', 'Your name');

    const status = document.createElement('p');
    status.className = 'name-status';
    status.setAttribute('aria-live', 'polite');

    const save = button('Save', 'secondary-button', () => {
      const name = input.value.trim();
      if (!name) {
        status.textContent = 'Your name cannot be empty.';
        return;
      }
      if (name === this.account.name) {
        status.textContent = '';
        return;
      }
      save.disabled = true;
      status.textContent = 'Saving…';
      this.account
        .setName(name)
        .then(() => {
          input.value = this.account.name;
          status.textContent = 'Saved.';
        })
        .catch((error: unknown) => {
          console.error('Could not save the name:', error);
          status.textContent = 'Could not save your name. Try again.';
        })
        .finally(() => {
          save.disabled = false;
        });
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') save.click();
    });
    input.addEventListener('input', () => {
      status.textContent = '';
    });

    row.append(input, save);
    wrapper.append(row, status);
    return wrapper;
  }

  private colourPicker(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'colour-picker';
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', 'Pen colour');

    const current = this.account.colour;
    for (const [index, colour] of PLAYER_COLOURS.entries()) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'colour-swatch';
      swatch.style.background = colour.body;
      swatch.style.borderColor = colour.cap;
      swatch.setAttribute('role', 'radio');
      swatch.setAttribute('aria-checked', String(index === current));
      swatch.setAttribute('aria-label', colour.name);
      swatch.title = colour.name;
      swatch.addEventListener('click', () => {
        this.account.setColour(index).catch((error: unknown) => {
          console.error('Could not save the colour:', error);
        });
      });
      row.append(swatch);
    }
    return row;
  }
}

/** Google's own wording, so people recognise what the button does. */
export function googleButton(account: Account, label = 'Sign in with Google'): HTMLButtonElement {
  // Away from the server's own site (the itch.io build), sign-in cannot work
  // here, so the button opens the game's home page in a new tab instead.
  if (!SIGN_IN_ON_THIS_PAGE) {
    return button(`${label} on ${new URL(home()).host}`, 'google-button', () => {
      window.open(home(), '_blank', 'noopener');
    });
  }

  const element = button(label, 'google-button', () => {
    element.disabled = true;
    account.signIn().catch((error: unknown) => {
      console.error('Could not start the sign-in:', error);
      element.disabled = false;
      element.textContent = 'Sign-in failed — try again';
    });
  });
  const mark = document.createElement('span');
  mark.className = 'google-mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = 'G';
  element.prepend(mark);
  return element;
}

function onlineStats(summary: ProfileSummary): HTMLElement {
  const { games, wins, knockouts, selfFalls } = summary.online;
  if (games === 0) return paragraph('No online games yet. Create a table and invite someone.');

  const grid = document.createElement('dl');
  grid.className = 'stat-grid';
  const tiles: [string, string][] = [
    ['Games', String(games)],
    ['Wins', String(wins)],
    ['Win rate', `${Math.round((wins / games) * 100)}%`],
    ['Knock-outs', String(knockouts)],
    ['Win streak', String(summary.currentStreak)],
    ['Best streak', String(summary.bestStreak)],
    ['Fell off', String(selfFalls)],
  ];
  for (const [label, value] of tiles) {
    const tile = document.createElement('div');
    tile.className = 'stat';
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    tile.append(term, detail);
    grid.append(tile);
  }
  return grid;
}

type BotRecord = ProfileSummary['solo'];

function botsTable(record: BotRecord): HTMLElement {
  if (DIFFICULTIES.every((level) => !record[level]?.games)) {
    return paragraph('No games against the bots yet.');
  }
  const list = document.createElement('ul');
  list.className = 'bot-record';
  for (const level of DIFFICULTIES) {
    const entry = record[level] ?? { games: 0, wins: 0 };
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = level[0].toUpperCase() + level.slice(1);
    const value = document.createElement('span');
    value.textContent =
      entry.games === 0 ? '—' : `${entry.wins} ${entry.wins === 1 ? 'win' : 'wins'} from ${entry.games}`;
    item.append(name, value);
    list.append(item);
  }
  return list;
}

function recentList(matches: RecentMatch[]): HTMLElement {
  if (matches.length === 0) return paragraph('Nothing yet.');
  const list = document.createElement('ol');
  list.className = 'recent-games';
  const dates = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

  for (const match of matches) {
    const { you } = match;
    const item = document.createElement('li');
    if (you.won) item.classList.add('is-win');

    const place = document.createElement('span');
    place.className = 'recent-place';
    place.textContent = you.won ? 'Won' : `${ordinal(you.place)} of ${match.playerCount}`;

    const detail = document.createElement('span');
    detail.className = 'recent-detail';
    const opponents = match.players.filter((seat) => seat.seat !== you.seat).map((seat) => seat.name);
    const who =
      match.mode === 'solo'
        ? `${capitalise(match.difficulty ?? 'normal')} bots`
        : `vs ${opponents.join(', ')}`;
    const extras = [
      you.knockouts > 0 ? `${you.knockouts} KO${you.knockouts === 1 ? '' : 's'}` : '',
      you.selfFell ? 'fell off' : '',
    ].filter(Boolean);
    detail.textContent = [who, ...extras].join(' · ');

    const when = document.createElement('time');
    when.className = 'recent-date';
    when.dateTime = match.endedAt;
    when.textContent = dates.format(new Date(match.endedAt));

    item.append(place, detail, when);
    list.append(item);
  }
  return list;
}

function section(title: string): HTMLElement {
  const element = document.createElement('section');
  element.className = 'profile-section';
  const heading = document.createElement('h3');
  heading.textContent = title;
  element.append(heading);
  return element;
}

function paragraph(text: string): HTMLParagraphElement {
  const element = document.createElement('p');
  element.className = 'section-body';
  element.textContent = text;
  return element;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

function capitalise(text: string): string {
  return text[0].toUpperCase() + text.slice(1);
}

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th". */
function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}
