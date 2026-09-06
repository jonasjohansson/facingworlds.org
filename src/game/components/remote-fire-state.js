// remote-fire-state.js — MOVED to src/game/systems/remote-fire-state.js.
//
// The module is pure (no A-Frame, no THREE, no DOM), so the three.js port took it over
// wholesale rather than copying it. This one line stays behind only so the A-Frame
// components still served by index.html — remote-avatar.js — keep resolving their import
// while both entries exist. It goes at the swap (Task 16), with the rest of
// src/game/components/.
export * from "../systems/remote-fire-state.js";
