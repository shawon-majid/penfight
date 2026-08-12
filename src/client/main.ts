/** Entry point: find the elements the page provides and hand them to the app. */

import { App } from './app';
import './styles.css';

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`The page is missing #${id}.`);
  return element as T;
}

const app = new App({
  lobby: requireElement('lobby'),
  game: requireElement('game'),
  hud: requireElement('hud'),
  canvas: requireElement<HTMLCanvasElement>('table-canvas'),
});

app.start();

// A handle for tuning and debugging: in `npm run dev` you can reach the live
// session from the console — read pen positions, step the physics by hand,
// replay a shot. Stripped from production builds.
if (import.meta.env.DEV) {
  (window as unknown as { penfight: App }).penfight = app;
}
