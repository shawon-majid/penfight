/**
 * The front door.
 *
 * Three jobs, and nothing else:
 *
 *   - hand out a free table code
 *   - decide who a websocket belongs to
 *   - route it to the one table object that owns that code
 *
 * Everything else is the static site. All the game logic lives in
 * `table-room.ts`; this file just does the addressing.
 */

import { generateCodeWithCrypto, normaliseCode } from '../shared/game/codes';
import { TOKEN_SUBPROTOCOL_PREFIX } from '../shared/net/protocol';
import {
  accountPlayerId,
  guestPlayerId,
  offeredSubprotocols,
  verifyAccessToken,
} from './supabase';
import type { Env } from './table-room';

export { TableRoom } from './table-room';

/** A code collision is unlikely; give up rather than loop forever if it isn't. */
const CODE_ATTEMPTS = 8;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/table' && request.method === 'POST') {
      return createTable(env);
    }

    const socketRoute = url.pathname.match(/^\/api\/table\/([^/]+)\/ws$/);
    if (socketRoute) {
      return openTable(request, env, socketRoute[1], url);
    }

    if (url.pathname.startsWith('/api/')) {
      return new Response('Not found', { status: 404 });
    }

    // Anything else is the game itself.
    return env.ASSETS.fetch(request);
  },
};

/** Find a code nobody is using and return it. */
async function createTable(env: Env): Promise<Response> {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const code = generateCodeWithCrypto();
    const room = roomFor(env, code);
    const reservation = await room.fetch(
      new Request(`https://table/reserve?code=${code}`),
    );
    const { taken } = (await reservation.json()) as { taken: boolean };
    if (!taken) return Response.json({ code });
  }

  return Response.json(
    { error: 'Could not find a free table code. Try again.' },
    { status: 503 },
  );
}

/** Pass a websocket through to the table that owns this code. */
async function openTable(request: Request, env: Env, rawCode: string, url: URL): Promise<Response> {
  const code = normaliseCode(rawCode);
  if (!code) return new Response('That is not a table code.', { status: 400 });

  const playerId = await identify(request, env, url);
  if (!playerId) return new Response('Missing player id.', { status: 400 });

  // Rewrite so the room knows its own code without having to store it first,
  // and hands the seat to the player id decided here — never one the browser
  // chose for itself.
  const forwarded = new URL(url);
  forwarded.searchParams.set('code', code);
  forwarded.searchParams.set('player', playerId);

  return roomFor(env, code).fetch(new Request(forwarded, request));
}

/** Browser-made ids are random UUIDs; anything else is turned away. */
const BROWSER_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Who is connecting.
 *
 * A signed-in player's browser sends its Supabase access token, and if
 * Supabase vouches for it they get their account's player id — the same one on
 * every device. Everyone else is a guest, identified by the id their browser
 * made up, which is namespaced so a guest can never pass for an account.
 *
 * A token that does not check out is not an error: the player still gets to
 * play, as a guest, and the table tells them it will not count.
 *
 * Browsers cannot put headers on a websocket request, so the token rides in
 * the subprotocol list rather than the URL, which keeps it out of request logs.
 */
async function identify(request: Request, env: Env, url: URL): Promise<string | null> {
  const token = offeredSubprotocols(request)
    .find((protocol) => protocol.startsWith(TOKEN_SUBPROTOCOL_PREFIX))
    ?.slice(TOKEN_SUBPROTOCOL_PREFIX.length);
  if (token) {
    const accountId = await verifyAccessToken(env, token);
    if (accountId) return accountPlayerId(accountId);
  }

  const browserId = url.searchParams.get('player');
  return browserId && BROWSER_ID.test(browserId) ? guestPlayerId(browserId) : null;
}

/**
 * The same code always resolves to the same object, anywhere in the world.
 * That is what makes "type this code to join my table" work.
 */
function roomFor(env: Env, code: string): DurableObjectStub {
  return env.TABLE_ROOM.get(env.TABLE_ROOM.idFromName(code));
}
