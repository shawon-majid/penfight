/**
 * The front door.
 *
 * Two jobs, and nothing else:
 *
 *   - hand out a free table code
 *   - route a websocket to the one table object that owns that code
 *
 * Everything else is the static site. All the game logic lives in
 * `table-room.ts`; this file just does the addressing.
 */

import { generateCodeWithCrypto, normaliseCode } from '../shared/game/codes';
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
function openTable(request: Request, env: Env, rawCode: string, url: URL): Promise<Response> {
  const code = normaliseCode(rawCode);
  if (!code) {
    return Promise.resolve(new Response('That is not a table code.', { status: 400 }));
  }

  // Rewrite so the room knows its own code without having to store it first.
  const forwarded = new URL(url);
  forwarded.searchParams.set('code', code);

  return roomFor(env, code).fetch(new Request(forwarded, request));
}

/**
 * The same code always resolves to the same object, anywhere in the world.
 * That is what makes "type this code to join my table" work.
 */
function roomFor(env: Env, code: string): DurableObjectStub {
  return env.TABLE_ROOM.get(env.TABLE_ROOM.idFromName(code));
}
