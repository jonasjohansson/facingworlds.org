// input.js — every input source the rig and the gun read, snapshotted once per frame.
//
// Replaces aframe-extras' keyboard-controls and touch-controls, look-controls' pointer-lock
// plumbing, and the key/mouse listeners first-person-weapon used to own. It does NOT
// interpret the input: the player controller turns move() into velocity and the weapon
// turns fireHeld into shots, so touch, keyboard and mouse share one path each.

/** A-Frame look-controls' mouse rate; the controller applies it to the look accumulator. */
export const MOUSE_RAD_PER_PX = 0.002;

/**
 * Pure: keys map + active touch count -> {x, z} in rig space, length <= 1.
 *
 * Writes into `out` and returns it. Called once per frame, so the caller passes a scratch
 * object rather than letting this mint one; `out` defaults to a fresh object for tests and
 * one-off callers.
 */
export function moveVectorFrom(keys, touchCount, out = { x: 0, z: 0 }) {
  let x = 0;
  let z = 0;
  if (keys.KeyW || keys.ArrowUp) z -= 1;
  if (keys.KeyS || keys.ArrowDown) z += 1;
  if (keys.KeyA || keys.ArrowLeft) x -= 1;
  if (keys.KeyD || keys.ArrowRight) x += 1;
  // One finger forward, two back — what the credits panel promises.
  if (touchCount === 1) z -= 1;
  else if (touchCount === 2) z += 1;
  // Diagonals normalised: UT99 has one ground speed, whereas the stock controls scaled by
  // the raw key vector length and so ran 1.41x faster on a diagonal.
  const len = Math.hypot(x, z);
  if (len > 1) {
    x /= len;
    z /= len;
  }
  out.x = x;
  out.z = z;
  return out;
}

export function createInput(canvas) {
  const keys = {};
  let touchCount = 0;
  // Look deltas accumulate between frames and are drained by the controller.
  let lookDx = 0;
  let lookDy = 0;
  let jumpPressed = false; // edge, consumed once by the controller
  let jumpHeld = false;
  let fireHeld = false; // level; the weapon detects its own rising edge (burst reset)
  const drag = { active: false, x: 0, y: 0 };
  // move() fills this rather than allocating a vector every frame, the way look() fills
  // the object the controller hands it.
  const moveOut = { x: 0, z: 0 };
  const edges = new Map(); // code -> pressed-since-last-consume, for Tab/N style keys

  const locked = () => document.pointerLockElement === canvas;

  const onKeyDown = (e) => {
    // Never swallow typing in the name box or any other input.
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (!e.repeat) {
      keys[e.code] = true;
      edges.set(e.code, true);
      if (e.code === "Space") {
        jumpPressed = true;
        jumpHeld = true;
      }
      if (e.code === "KeyX") fireHeld = true;
    }
    if (e.code === "Space" || e.code === "KeyX" || e.code === "Tab") e.preventDefault();
  };
  const onKeyUp = (e) => {
    keys[e.code] = false;
    if (e.code === "Space") jumpHeld = false;
    if (e.code === "KeyX") fireHeld = false;
  };
  const onMouseMove = (e) => {
    if (!locked()) return;
    lookDx += e.movementX;
    lookDy += e.movementY;
  };
  // Left button fires, but only while locked: the click that TAKES the lock must not
  // also put a shot into the floor (the old look-controls / first-person-weapon pair
  // agreed on exactly this).
  const onMouseDown = (e) => {
    if (e.button !== 0) return;
    if (!locked()) {
      if (e.target === canvas) canvas.requestPointerLock();
      return;
    }
    fireHeld = true;
  };
  const onMouseUp = (e) => {
    if (e.button === 0) fireHeld = false;
  };
  // Release on pointer-lock exit too, or holding the button while pressing Escape leaves
  // the trigger stuck with no mouseup ever arriving.
  const onPointerLockChange = () => {
    if (!locked()) fireHeld = false;
  };
  // Touch on the canvas: the finger count is movement, a single-finger drag also looks.
  // The HUD's fire button is a separate DOM element and reports through pressFire().
  const onTouchStart = (e) => {
    touchCount = e.touches.length;
    if (touchCount === 1) {
      drag.active = true;
      drag.x = e.touches[0].clientX;
      drag.y = e.touches[0].clientY;
    } else {
      drag.active = false;
    }
  };
  // A-Frame's look-controls turned a touch drag by PI radians per canvas WIDTH (yaw only,
  // and with the opposite sign to its own mouse path). The controller applies one rate
  // to whatever lands in the accumulator — the mouse's 0.002 rad/px — so a touch delta
  // is pre-scaled here to A-Frame's per-width rate: on a 400 px phone that is 0.45°/px,
  // a half-screen swipe turns 90°, where the raw mouse rate would give 23°. Pitch gets
  // the same factor (touch pitch is new; A-Frame had none) and the mouse's sign.
  const touchScale = () => Math.PI / Math.max(1, canvas.clientWidth) / MOUSE_RAD_PER_PX;
  const onTouchMove = (e) => {
    if (!drag.active || e.touches.length !== 1) return;
    const k = touchScale();
    lookDx += (e.touches[0].clientX - drag.x) * k;
    lookDy += (e.touches[0].clientY - drag.y) * k;
    drag.x = e.touches[0].clientX;
    drag.y = e.touches[0].clientY;
  };
  const onTouchEnd = (e) => {
    touchCount = e.touches.length;
    if (touchCount === 0) drag.active = false;
  };
  const onBlur = () => {
    for (const k in keys) keys[k] = false;
    fireHeld = false;
    jumpHeld = false;
  };

  window.addEventListener("keydown", onKeyDown, { passive: false });
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  document.addEventListener("pointerlockchange", onPointerLockChange);
  canvas.addEventListener("touchstart", onTouchStart, { passive: true });
  canvas.addEventListener("touchmove", onTouchMove, { passive: true });
  canvas.addEventListener("touchend", onTouchEnd);
  canvas.addEventListener("touchcancel", onTouchEnd);

  return {
    keys,
    get pointerLocked() {
      return locked();
    },
    requestPointerLock() {
      if (!locked()) canvas.requestPointerLock();
    },
    /**
     * This frame's movement vector. Written into `out`, or into a scratch object owned by
     * this input — valid until the next move() call, which is all the controller needs.
     */
    move(out = moveOut) {
      return moveVectorFrom(keys, touchCount, out);
    },
    /** Drains the look delta: pixels since the last call. */
    look(out) {
      out.x = lookDx;
      out.y = lookDy;
      lookDx = 0;
      lookDy = 0;
      return out;
    },
    consumeJump() {
      const j = jumpPressed;
      jumpPressed = false;
      return j;
    },
    get jumpHeld() {
      return jumpHeld;
    },
    /** True once per press of `code` (KeyboardEvent.code), for Tab/N style toggles. */
    consumePress(code) {
      const p = edges.get(code) === true;
      if (p) edges.set(code, false);
      return p;
    },
    get fireHeld() {
      return fireHeld;
    },
    /** For the touch fire button the weapon draws: down = true on touchstart. */
    pressFire(down) {
      fireHeld = !!down;
    },
    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("touchcancel", onTouchEnd);
    },
  };
}
