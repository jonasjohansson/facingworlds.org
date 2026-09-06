// pointer-lock-prompt.js — "CLICK TO PLAY", and nothing else.
//
// The game runs on pointer lock, and pointer lock is the one FPS convention a browser
// cannot do for you: it must be requested from inside a user gesture, so there is always
// a moment on load, and again after every Escape, where the mouse does nothing. Every
// browser shooter puts the same sign up in that moment. Without it the game looks broken
// for the first few seconds — the player moves the mouse, the view does not turn, and
// there is no way to know a click is what is missing.
//
// This owns only the sign. engine/input.js owns the lock itself (its mousedown handler
// calls canvas.requestPointerLock when the click lands on the canvas and the lock is not
// held), so there is nothing here to duplicate and no second code path that could
// disagree with it about when the lock is held. The prompt is `pointer-events: none` in
// styles.css, so the click that dismisses it goes straight through to the canvas. One
// gesture, one lock, one owner.
//
// It hides itself while the player is dead, because the HUD is drawing its own death
// message there and two overlays stacked on the same spot is worse than neither.
//
// It lives beside the player rather than in systems/ because what it reflects is an INPUT
// state (`game.input.pointerLocked`), and because it has no per-frame work at all: the
// player controller owns one and disposes it, and nothing calls it every frame.

export function createPointerLockPrompt(game, { enabled = true } = {}) {
  const el = document.createElement("div");
  el.className = "ut-lock-prompt";
  el.setAttribute("aria-live", "polite");
  el.innerHTML =
    '<b>CLICK TO PLAY</b><span>WASD move &middot; mouse look &middot; click fire &middot; Space jump &middot; Esc release</span>';
  document.body.appendChild(el);

  let dead = false;

  function sync() {
    const show = enabled && !game.input.pointerLocked && !dead;
    el.classList.toggle("is-visible", show);
  }

  const onLockChange = () => sync();
  const onDeath = () => {
    dead = true;
    sync();
  };
  const onRespawn = () => {
    dead = false;
    sync();
  };

  document.addEventListener("pointerlockchange", onLockChange);
  const offDeath = game.events.on("local-death", onDeath);
  const offRespawn = game.events.on("local-respawn", onRespawn);
  sync();

  return {
    sync,
    setEnabled(value) {
      enabled = !!value;
      sync();
    },
    dispose() {
      document.removeEventListener("pointerlockchange", onLockChange);
      offDeath();
      offRespawn();
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}
