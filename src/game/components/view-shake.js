// view-shake.js — MOVED to src/game/player/view-shake.js.
//
// The shake is the player controller's now (src/game/player/controller.js writes the roll
// and the eye lift straight onto the camera and the gun root), so the module moved with
// it. This one line stays only so the A-Frame page keeps loading: index.html's
// first-person-weapon.js imports "./view-shake.js" from this directory and is not to be
// touched before the swap. One module either way — there is no second copy to drift.
// Deleted with the rest of src/game/components/ at Task 16.
export * from "../player/view-shake.js";
