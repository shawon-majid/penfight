/**
 * A random UUID, even where `crypto.randomUUID` is missing.
 *
 * Browsers only offer `randomUUID` on secure pages. The live game is served
 * over https, but a phone testing against a laptop on the same Wi-Fi opens a
 * plain `http://192.168…` address, and without this the game would break
 * there. `getRandomValues` works everywhere, so build the same thing from it.
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // Version 4, variant 1 — the same shape `randomUUID` returns.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
