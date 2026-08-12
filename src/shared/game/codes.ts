/**
 * Table codes — the five characters someone reads out so their friends can
 * join.
 *
 * The alphabet leaves out the characters people mishear or mistype: no O/0,
 * no I/1, no S/5. Codes are compared case-insensitively, so typing them in
 * lowercase works.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXY2346789';
export const CODE_LENGTH = 5;

/**
 * Generate a table code.
 *
 * `randomInt` is injected so callers can supply a proper source — the server
 * uses `crypto.getRandomValues`, tests use a seeded generator.
 */
export function generateCode(randomInt: (maxExclusive: number) => number): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

/** Uniform codes from the platform's cryptographic RNG. */
export function generateCodeWithCrypto(): string {
  const bound = ALPHABET.length;
  // Reject the tail of the byte range so every character stays equally likely.
  const limit = Math.floor(256 / bound) * bound;
  return generateCode(() => {
    const buffer = new Uint8Array(1);
    do {
      crypto.getRandomValues(buffer);
    } while (buffer[0] >= limit);
    return buffer[0] % bound;
  });
}

/** Fold user input into canonical form, or null if it could never be a code. */
export function normaliseCode(input: string): string | null {
  const cleaned = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const character of cleaned) {
    if (!ALPHABET.includes(character)) return null;
  }
  return cleaned;
}
