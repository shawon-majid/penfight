/**
 * Where the server is.
 *
 * On penfight.shawonmajid.com the game and the server are the same site, so
 * every address is relative to the page. A build hosted somewhere else — the
 * itch.io build, which runs in a frame on itch's own domain — is told the
 * server's address at build time through `VITE_SERVER_ORIGIN`, and talks to it
 * across sites instead.
 *
 * The functions take the page's address as an argument so they can be tested
 * without a browser; the exports at the bottom bind them to the real page.
 */

export interface PageAddress {
  origin: string;
}

/** The configured server, without a trailing slash, or null to mean "this page's own site". */
export function parseServerOrigin(configured: string | undefined): string | null {
  const trimmed = configured?.trim().replace(/\/+$/, '');
  return trimmed ? trimmed : null;
}

/** An `/api/...` address for `fetch`. */
export function apiAddress(server: string | null, path: string): string {
  return server ? `${server}${path}` : path;
}

/** The websocket address for an `/api/...` path. */
export function socketAddress(server: string | null, page: PageAddress, path: string): string {
  const base = server ?? page.origin;
  const url = new URL(path, base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/**
 * The game's home page, for invite links. A hosted build sends friends to the
 * server's own site, because an itch.io frame cannot be linked to directly.
 */
export function homeAddress(server: string | null, page: PageAddress): string {
  return server ?? page.origin;
}

/** Set for builds that are hosted away from the server. */
export const SERVER_ORIGIN = parseServerOrigin(
  import.meta.env.VITE_SERVER_ORIGIN as string | undefined,
);

/**
 * Google sign-in only works on the server's own site: Supabase sends people
 * back to an address it has been told to trust, and Google refuses to show its
 * sign-in page inside another site's frame.
 */
export const SIGN_IN_ON_THIS_PAGE = SERVER_ORIGIN === null;

export const api = (path: string): string => apiAddress(SERVER_ORIGIN, path);
export const socket = (path: string): string => socketAddress(SERVER_ORIGIN, location, path);
export const home = (): string => homeAddress(SERVER_ORIGIN, location);
