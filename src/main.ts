import './ui/style.css';
import { App } from './ui/app';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;

// Block the double-tap zoom and rubber banding that make a canvas game unusable
// in a Safari tab (PRD 6.7, R7: the tab has to be fully playable).
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener(
  'touchmove',
  (e) => {
    if (e.touches.length > 1) e.preventDefault();
  },
  { passive: false },
);

new App(canvas, ui);
