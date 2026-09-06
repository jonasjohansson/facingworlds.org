// events.js — the scene bus.
//
// A-Frame gave every component `this.el.sceneEl.emit(name, detail)` and the matching
// addEventListener; network.js, the HUD, CTF and the weapons all talk through it. This is
// the same contract on a plain EventTarget: handlers keep reading `e.detail`, so the
// listeners in the ported systems are copied across unchanged. Runs in Node too (tests).
export function createEvents() {
  const target = new EventTarget();
  return {
    emit(name, detail) {
      target.dispatchEvent(new CustomEvent(name, { detail }));
    },
    /** Returns the unsubscribe function. */
    on(name, handler) {
      target.addEventListener(name, handler);
      return () => target.removeEventListener(name, handler);
    },
    once(name, handler) {
      target.addEventListener(name, handler, { once: true });
    },
    off(name, handler) {
      target.removeEventListener(name, handler);
    },
  };
}
