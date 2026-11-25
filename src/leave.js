// Keeps a back gesture or the Back button from dropping the player out of a game (DECISIONS D78).
// Browsers do not let a page turn the gesture off, so the page keeps one history entry of its own on top: Back
// pops that entry instead of leaving, and we ask. beforeunload covers what gets past it (a second Back while
// the question is up on Chrome, closing the tab, typing a URL). iOS Safari has no beforeunload.
//
// Chrome skips, on Back, an entry the user never interacted with while it was current, so entries are pushed
// only from a tap, click or key (user activation): arming waits for the next one, and Stay pushes a fresh one.
import { CFG } from './config.js';

const CSS = `
#leave { position: fixed; inset: 0; z-index: 40; display: none; align-items: center; justify-content: center; background: rgba(10,14,9,.6); }
#leave .box { width: min(90vw, 380px); background: #1b2418; border-radius: 12px; padding: 18px 20px; text-align: center; box-shadow: 0 6px 30px #000; }
#leave p { margin: 0 0 14px; font-size: 18px; font-weight: 600; } #leave small { display: block; opacity: .7; margin: -8px 0 14px; min-height: 1em; }
#leave button { font: inherit; font-size: 18px; font-weight: 700; padding: 12px 18px; margin: 4px; min-width: 120px; border-radius: 8px; border: 0; cursor: pointer; touch-action: manipulation; }
#leave .stay { background: #e8a23a; color: #201400; } #leave .go { background: #4a5d42; color: #fff; }
#leave button:focus { outline: 3px solid #fff; }
`;

export class LeaveGuard {
  // onAsk(open): the question went up (true) or away (false), so the game can stop or resume taking input
  constructor(onAsk = () => {}) {
    this.onAsk = onAsk;
    this.armed = false;     // in a game: Back asks, unload asks
    this.leaving = false;   // the player chose Leave
    this.depth = 0;         // our entries above the page's own: history.state.arbGuard of the current entry
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    this.el = document.createElement('div'); this.el.id = 'leave';
    this.el.innerHTML = '<div class="box"><p>Leave the game?</p><small></small>' +
      '<button class="stay">Stay</button><button class="go">Leave</button></div>';
    document.body.appendChild(this.el);
    this.note = this.el.querySelector('small');
    this.el.querySelector('.stay').onclick = () => this.stay();
    this.el.querySelector('.go').onclick = () => this.leave();
    this.el.addEventListener('keydown', (e) => { if (e.code === 'Escape') { e.stopPropagation(); this.stay(); } });

    const gesture = () => { if (this.armed && !this.leaving && this.depth === 0 && !this.isOpen()) this.push(); };
    for (const ev of ['keydown', 'mousedown', 'pointerdown', 'pointerup', 'touchend']) addEventListener(ev, gesture, true);
    addEventListener('popstate', (e) => this.onPop(e));
    addEventListener('pageshow', (e) => { if (e.persisted) this.leaving = false; });   // came Forward from the back/forward cache
    addEventListener('beforeunload', (e) => {
      if (!this.armed || this.leaving || !CFG.LEAVE_GUARD) return;
      e.preventDefault(); e.returnValue = '';      // the browser shows its own "Leave site?" question
    });
  }

  isOpen() { return this.el.style.display === 'flex'; }

  // the game started: from now on Back asks; the entry goes on now if this came from a click, else at the next tap
  arm() {
    this.armed = true; this.leaving = false;
    this.depth = history.state?.arbGuard | 0;
    if (this.depth === 0 && navigator.userActivation?.isActive !== false) this.push();
  }

  push() {
    if (!CFG.LEAVE_GUARD) return;
    this.depth++;
    history.pushState({ ...(history.state || {}), arbGuard: this.depth }, '');
  }

  onPop(e) {
    const d = e.state?.arbGuard | 0;
    const popped = d < this.depth;
    this.depth = d;
    if (!this.armed || this.leaving || !popped || !CFG.LEAVE_GUARD) return;
    // one of ours went: if it was the last, put one straight back so a second swipe is caught too (Safari;
    // Chrome may skip it, and then its beforeunload asks); and ask
    if (d === 0) this.push();
    if (!this.isOpen()) this.ask();
  }

  ask() {
    this.note.textContent = '';
    this.el.style.display = 'flex';
    document.exitPointerLock?.();
    this.onAsk(true);
    this.el.querySelector('.stay').focus();
  }

  stay() {
    this.el.style.display = 'none';
    if (this.depth < 2) this.push();     // from a click, so an entry Chrome's Back stops at; at most two of ours
    this.onAsk(false);
  }

  leave() {
    this.leaving = true;
    history.go(-(this.depth + 1));     // past our entries to the page before the game
    // opened in a fresh tab there is nothing before it: say so rather than sit there
    setTimeout(() => {
      if (document.visibilityState !== 'visible') return;
      this.leaving = false;
      this.note.textContent = 'Nothing to go back to: close the tab to leave.';
    }, 700);
  }
}
