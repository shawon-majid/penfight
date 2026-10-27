/**
 * Letting copies of the game hosted on other sites ask for a table.
 *
 * The itch.io build runs on itch's domain and opens tables here. Asking for a
 * table code needs no sign-in and hands out nothing private, so any site may
 * ask. Websockets are not covered by these rules; they connect regardless.
 */

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

/** The same response, readable from any site. */
export function allowAnyOrigin(response: Response): Response {
  const opened = new Response(response.body, response);
  for (const [name, value] of Object.entries(CORS_HEADERS)) opened.headers.set(name, value);
  return opened;
}

/** The answer to a browser checking first whether it may make the request. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
