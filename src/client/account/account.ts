/**
 * Who is playing: a guest, or someone signed in with Google.
 *
 * Guests are the default and never touch Supabase — not even to download its
 * library. It is only loaded when this browser already holds a session, is
 * coming back from Google's sign-in page, or the player presses "Sign in".
 *
 * The rest of the client asks this one object for the player's name and
 * colour and hands it finished solo games, without caring which kind of
 * player it is. Guests' data goes to local storage (`local-profile.ts`);
 * signed-in players' goes to their Supabase profile.
 */

import type { Session, SupabaseClient } from '@supabase/supabase-js';
import type { BotDifficulty } from '../../shared/game/bots';
import { toDatabase, type MatchRecord } from '../../shared/game/results';
import {
  appendSoloRecord,
  clearSoloHistory,
  loadAvatar,
  loadName,
  loadSoloHistory,
  parseColour,
  saveAvatar,
  saveName,
} from './local-profile';

/** Where supabase-js keeps the session. Named so we can spot one without loading the library. */
const AUTH_STORAGE_KEY = 'penfight.auth';
/** Query parameters Supabase adds on the way back from Google. Removed once read. */
const AUTH_RETURN_PARAMS = ['code', 'error', 'error_code', 'error_description'];

export interface Profile {
  id: string;
  displayName: string;
  penColour: number;
}

export type AccountState =
  | { status: 'guest' }
  /** Finishing a sign-in, or checking a saved session. */
  | { status: 'loading' }
  | { status: 'signedIn'; email: string | null; profile: Profile };

export interface OnlineTotals {
  games: number;
  wins: number;
  knockouts: number;
  selfFalls: number;
}

export interface ProfileSummary {
  online: OnlineTotals;
  bestStreak: number;
  currentStreak: number;
  solo: Partial<Record<BotDifficulty, { games: number; wins: number }>>;
}

/** As `my_recent_matches()` returns it. */
export interface RecentMatch {
  id: string;
  mode: 'online' | 'solo';
  difficulty: BotDifficulty | null;
  tableCode: string | null;
  playerCount: number;
  turns: number;
  endedAt: string;
  you: { seat: number; place: number; won: boolean; knockouts: number; selfFell: boolean };
  players: {
    seat: number;
    name: string;
    kind: 'account' | 'guest' | 'bot';
    penColour: number;
    place: number;
    won: boolean;
  }[];
}

export class Account {
  state: AccountState = { status: 'guest' };
  /** Set when a sign-in came back with an error, for the lobby to show once. */
  signInError: string | null = null;

  private client: SupabaseClient | null = null;
  private readonly listeners = new Set<() => void>();

  /**
   * Pick up where this browser left off. Cheap for guests: if there is no
   * saved session and we are not returning from Google, it does nothing.
   */
  async init(): Promise<void> {
    const params = new URLSearchParams(location.search);
    const returning = AUTH_RETURN_PARAMS.some((name) => params.has(name));
    if (!returning && !hasStoredSession()) return;

    this.signInError = params.get('error_description') ?? params.get('error');
    this.setState({ status: 'loading' });

    try {
      const client = await this.supabase();
      // With a `code` in the address bar, this is where it is swapped for a session.
      const { data } = await client.auth.getSession();
      await this.adoptSession(data.session);
    } catch (error) {
      console.error('Could not restore the sign-in:', error);
      this.signInError ??= 'Could not sign you in. Try again.';
      this.setState({ status: 'guest' });
    } finally {
      if (returning) removeAuthParams();
    }
  }

  /** Off to Google. The page comes back to the same address, table code and all. */
  async signIn(): Promise<void> {
    const client = await this.supabase();
    const back = new URL(location.href);
    for (const name of AUTH_RETURN_PARAMS) back.searchParams.delete(name);
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: back.toString() },
    });
    if (error) throw error;
  }

  async signOut(): Promise<void> {
    if (!this.client) return;
    await this.client.auth.signOut();
    this.setState({ status: 'guest' });
  }

  get signedIn(): boolean {
    return this.state.status === 'signedIn';
  }

  /** The name to play under. */
  get name(): string {
    return this.state.status === 'signedIn' ? this.state.profile.displayName : loadName();
  }

  /**
   * The pen colour to ask for at a table, or null to take whatever is free.
   * Choosing a colour is part of having a profile, so guests never have one.
   */
  get colour(): number | null {
    return this.state.status === 'signedIn' ? this.state.profile.penColour : null;
  }

  /**
   * The avatar to show next to your name. Kept in this browser for everyone,
   * signed in or not — it is a matter of taste, not of record.
   */
  get avatar(): number {
    return loadAvatar();
  }

  setAvatar(avatar: number): void {
    if (avatar === this.avatar) return;
    saveAvatar(avatar);
    this.emit();
  }

  async setName(name: string): Promise<void> {
    const clean = name.trim().slice(0, 24);
    if (!clean) return;
    if (this.state.status !== 'signedIn') {
      saveName(clean);
      return;
    }
    if (clean === this.state.profile.displayName) return;
    await this.updateProfile({ display_name: clean });
  }

  async setColour(colour: number): Promise<void> {
    if (this.state.status !== 'signedIn') return;
    await this.updateProfile({ pen_colour: colour });
  }

  /**
   * A fresh access token for the game server, or null for a guest.
   * `getSession` refreshes it first if it has expired.
   */
  async accessToken(): Promise<string | null> {
    if (!this.client || this.state.status !== 'signedIn') return null;
    const { data } = await this.client.auth.getSession();
    return data.session?.access_token ?? null;
  }

  /** File a finished game against the bots. */
  async recordSolo(record: MatchRecord): Promise<void> {
    if (this.state.status !== 'signedIn' || !this.client) {
      appendSoloRecord(record);
      return;
    }
    await this.saveSoloGames([record]);
  }

  /** The numbers for the profile screen. Signed-in players only. */
  async summary(): Promise<ProfileSummary | null> {
    if (!this.client || this.state.status !== 'signedIn') return null;
    const { data, error } = await this.client.rpc('my_profile_summary');
    if (error) throw error;
    return data as ProfileSummary;
  }

  async recentMatches(limit = 10): Promise<RecentMatch[]> {
    if (!this.client || this.state.status !== 'signedIn') return [];
    const { data, error } = await this.client.rpc('my_recent_matches', { p_limit: limit });
    if (error) throw error;
    return (data ?? []) as RecentMatch[];
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -------------------------------------------------------------------------

  private async supabase(): Promise<SupabaseClient> {
    if (this.client) return this.client;

    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
    if (!url || !key) throw new Error('Sign-in is not set up on this build.');

    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(url, key, {
      auth: {
        flowType: 'pkce',
        storageKey: AUTH_STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });

    client.auth.onAuthStateChange((event) => {
      // Signed out elsewhere, or the session could not be refreshed.
      if (event === 'SIGNED_OUT') this.setState({ status: 'guest' });
    });

    this.client = client;
    return client;
  }

  private async adoptSession(session: Session | null): Promise<void> {
    if (!session || !this.client) {
      this.setState({ status: 'guest' });
      return;
    }

    const { data, error } = await this.client
      .from('profiles')
      .select('id, display_name, pen_colour, imported_local')
      .eq('id', session.user.id)
      .single();
    if (error) throw error;

    this.setState({
      status: 'signedIn',
      email: session.user.email ?? null,
      profile: { id: data.id, displayName: data.display_name, penColour: data.pen_colour },
    });

    if (!data.imported_local) await this.importGuestData();
  }

  /**
   * The first time someone signs in, bring their guest self along: the name
   * they have been playing under and their games against the bots. Done once per account, then the local copy of those games is
   * cleared so they cannot be imported into a second account.
   */
  private async importGuestData(): Promise<void> {
    if (!this.client || this.state.status !== 'signedIn') return;

    const history = loadSoloHistory();
    // On failure, leave the flag unset so the next visit tries again.
    if (history.length > 0 && !(await this.saveSoloGames(history))) return;

    const changes: Record<string, unknown> = { imported_local: true };
    const localName = loadName().trim();
    if (localName) changes.display_name = localName.slice(0, 24);

    await this.updateProfile(changes);
    clearSoloHistory();
  }

  /**
   * Hand solo games to the database. It files them under the signed-in
   * account whatever they say, and ignores any it already has.
   */
  private async saveSoloGames(records: MatchRecord[]): Promise<boolean> {
    if (!this.client) return false;
    const { error } = await this.client.rpc('record_solo_matches', {
      p_matches: records.map(toDatabase),
    });
    if (error) {
      console.error('Could not save solo games:', error.message);
      return false;
    }
    return true;
  }

  private async updateProfile(changes: Record<string, unknown>): Promise<void> {
    if (!this.client || this.state.status !== 'signedIn') return;
    const { data, error } = await this.client
      .from('profiles')
      .update(changes)
      .eq('id', this.state.profile.id)
      .select('id, display_name, pen_colour')
      .single();
    if (error) throw error;
    this.setState({
      ...this.state,
      profile: {
        id: data.id,
        displayName: data.display_name,
        penColour: parseColour(data.pen_colour) ?? 0,
      },
    });
  }

  private setState(state: AccountState): void {
    this.state = state;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function hasStoredSession(): boolean {
  try {
    return localStorage.getItem(AUTH_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function removeAuthParams(): void {
  const url = new URL(location.href);
  for (const name of AUTH_RETURN_PARAMS) url.searchParams.delete(name);
  history.replaceState(history.state, '', url);
}
