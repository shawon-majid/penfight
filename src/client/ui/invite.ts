/**
 * Handing someone the way into a table. On a phone the share sheet is the
 * natural route — one tap into whichever chat the players are already in.
 * Everywhere else, the clipboard. Used by the waiting room and the in-game
 * bar alike, so both invite the same way.
 */

import { home } from '../net/server';

export type InviteResult = 'shared' | 'copied' | 'failed';

export const inviteLabel = typeof navigator.share === 'function' ? 'Invite' : 'Copy invite';

export async function shareInvite(code: string): Promise<InviteResult> {
  const invite = `${home()}/?table=${code}`;

  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: 'Pen Fight', text: `Join my table: ${code}`, url: invite });
      return 'shared';
    } catch {
      // Cancelled, or sharing is not allowed here. Fall through to copying.
    }
  }

  try {
    await navigator.clipboard.writeText(invite);
    return 'copied';
  } catch {
    // Clipboard access can be refused; the code is on screen either way.
    return 'failed';
  }
}

/**
 * Wire a button to invite people, showing "Copied" for a moment after it
 * worked — or "Copy failed", which stays until the next try.
 */
export function inviteButton(button: HTMLButtonElement, code: () => string): void {
  button.textContent = inviteLabel;
  let lastCopied: string | null = null;
  button.addEventListener('click', async () => {
    const current = code();
    const result = await shareInvite(current);
    if (result === 'copied') {
      button.textContent = 'Copied';
      lastCopied = current;
      setTimeout(() => {
        if (lastCopied === current) button.textContent = inviteLabel;
      }, 1800);
    } else if (result === 'failed') {
      button.textContent = 'Copy failed';
    }
  });
}
