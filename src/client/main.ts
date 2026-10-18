/**
 * Entry point: put the boot screen up, then load the game behind it and hand
 * it the elements the page provides.
 *
 * The game is a separate download on purpose. Only the boot screen is in this
 * first bundle, so it is on screen while the rest — Supabase included — is
 * still arriving.
 */

import { boot } from './boot/boot-screen';
import './styles.css';

/** Never hold the boot screen up for a slow sign-in; the lobby says "Signing you in…" on its own. */
const BOOT_ACCOUNT_TIMEOUT_MS = 4000;

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`The page is missing #${id}.`);
  return element as T;
}

void import('./app').then(({ App }) => {
  const app = new App({
    lobby: requireElement('lobby'),
    game: requireElement('game'),
    hud: requireElement('hud'),
    canvas: requireElement<HTMLCanvasElement>('table-canvas'),
  });

  boot.reach('game');
  const accountReady = app.start().catch((error: unknown) => {
    console.error('Could not restore the account:', error);
  });
  void Promise.race([
    accountReady,
    new Promise((resolve) => setTimeout(resolve, BOOT_ACCOUNT_TIMEOUT_MS)),
  ]).then(() => {
    boot.reach('account');
    return boot.finish();
  });

  // A handle for tuning and debugging: in `npm run dev` you can reach the live
  // session from the console — read pen positions, step the physics by hand,
  // replay a shot. Stripped from production builds.
  if (import.meta.env.DEV) {
    (window as unknown as { penfight: typeof app }).penfight = app;
  }
});
