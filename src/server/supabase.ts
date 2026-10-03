/**
 * The server's two conversations with Supabase:
 *
 *   - "Who is this?" — check a signed-in player's access token.
 *   - "Here is how the match went." — save a match a signed-in player was in.
 *
 * Both are plain HTTP calls to Supabase's REST endpoints; nothing here needs
 * the client library. If the Supabase settings are missing (a local run
 * without `.dev.vars`, say) everything still works — nobody is recognised as
 * signed in and no results are saved.
 */

import { toDatabase, type MatchRecord } from '../shared/game/results';
import { SIGNED_IN_SUBPROTOCOL } from '../shared/net/protocol';

export interface SupabaseEnv {
  SUPABASE_URL?: string;
  /** Public. Identifies the project when checking a token. */
  SUPABASE_PUBLISHABLE_KEY?: string;
  /** Secret. Lets the server write online results, which players cannot. */
  SUPABASE_SECRET_KEY?: string;
}

/** Player ids for signed-in players. Only the Worker hands these out, after checking a token. */
const ACCOUNT_PREFIX = 'acct:';
/** Player ids for everyone else: whatever id the browser made up for itself. */
const GUEST_PREFIX = 'guest:';

export function accountPlayerId(accountId: string): string {
  return ACCOUNT_PREFIX + accountId;
}

export function guestPlayerId(browserId: string): string {
  return GUEST_PREFIX + browserId;
}

/** The Supabase user id behind a player id, or null for a guest. */
export function accountIdOf(playerId: string): string | null {
  return playerId.startsWith(ACCOUNT_PREFIX) ? playerId.slice(ACCOUNT_PREFIX.length) : null;
}

/** The websocket subprotocols a browser offered. Signed-in browsers put their token here. */
export function offeredSubprotocols(request: Request): string[] {
  return (request.headers.get('Sec-WebSocket-Protocol') ?? '')
    .split(',')
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

/** Echoed back when a browser offered it, or the browser drops the connection. */
export function acceptedSubprotocol(request: Request): string | null {
  return offeredSubprotocols(request).includes(SIGNED_IN_SUBPROTOCOL) ? SIGNED_IN_SUBPROTOCOL : null;
}

/**
 * The Supabase user id this access token belongs to, or null if it is not a
 * live token for this project.
 *
 * Asking Supabase rather than checking the signature here keeps this correct
 * whichever way the project signs its tokens, and catches tokens revoked by a
 * sign-out. It costs one request per connection, not per shot.
 */
export async function verifyAccessToken(env: SupabaseEnv, token: string): Promise<string | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) return null;

  try {
    const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) return null;
    const user = (await response.json()) as { id?: unknown };
    return typeof user.id === 'string' ? user.id : null;
  } catch {
    return null;
  }
}

/**
 * Save a finished online match, every seat included, if anyone at the table
 * was signed in. All-guest games are not saved. Saving twice is harmless.
 */
export async function saveOnlineMatch(env: SupabaseEnv, record: MatchRecord): Promise<void> {
  if (!record.players.some((seat) => seat.kind === 'account')) return;

  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    console.warn('Supabase is not configured; the match was not saved.');
    return;
  }

  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/record_online_match`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_match: toDatabase(record) }),
  });
  if (!response.ok) {
    console.error('Saving the match failed:', response.status, await response.text());
  }
}
