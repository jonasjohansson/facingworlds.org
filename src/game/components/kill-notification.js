// kill-notification.js — the top-left message rail's death lines.
//
// ChallengeHUD has no separate "kill feed": deaths, chat and pickups all share
// ONE four-line message area at the top left (SetPos(6, 2 + YL*line), 3 s
// lifetime), and the only thing that separates them is the colour —
// DeathMessagePlus / RedSayMessagePlus draw (255,0,0), SayMessagePlus (0,255,0),
// StringMessagePlus white. So this component no longer owns a container of its
// own; it hands one red line to the HUD's rail and the HUD owns the pixels.
//
// The `local-kill` contract is unchanged.
import { getHud } from "./hud/hud-root.js";

AFRAME.registerComponent("kill-notification", {
  schema: {
    enabled: { type: "boolean", default: true },
    // Kept for compatibility with any scene markup that sets them; the rail's
    // four-line cap and 3 s LocalMessage lifetime are the source's, not ours.
    maxEntries: { type: "number", default: 4 },
    displayDuration: { type: "number", default: 3000 },
  },

  init() {
    this.hud = getHud();

    this._onLocalKill = this.onLocalKill.bind(this);
    this.el.sceneEl.addEventListener("local-kill", this._onLocalKill);
  },

  onLocalKill(event) {
    if (!this.data.enabled) return;
    const victimName = (event.detail && event.detail.victimName) || "Unknown Player";
    // KillerMessagePlus: your own frags are reported to you in the second
    // person, in the death-message red, with no decoration around the name.
    this.hud.pushMessage(`You killed ${victimName}`, "death");
  },

  remove() {
    this.el.sceneEl.removeEventListener("local-kill", this._onLocalKill);
    if (this.hud) {
      this.hud.release();
      this.hud = null;
    }
  },
});
