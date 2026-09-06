// kill-notification.js — the top-left message rail's death lines.
//
// ChallengeHUD has no separate "kill feed": deaths, chat and pickups all share
// ONE four-line message area at the top left (SetPos(6, 2 + YL*line), 3 s
// lifetime), and the only thing that separates them is the colour —
// DeathMessagePlus / RedSayMessagePlus draw (255,0,0), SayMessagePlus (0,255,0),
// StringMessagePlus white. So this system does not own a container of its own; it
// hands one red line to the HUD's rail and the HUD owns the pixels.
//
// The `local-kill` contract is unchanged; it arrives on game.events now.
import { getHud } from "../components/hud/hud-root.js";

const DEFAULTS = {
  enabled: true,
  // index.html's two markup values, carried across so the registration in main-three.js
  // is not passing numbers this file disagrees with. NOTHING READS EITHER: the rail's
  // four-line cap and its 3 s LocalMessage lifetime are ChallengeHUD's, owned by
  // hud-root.js, and pushMessage() takes no duration. They are kept only because
  // deleting a schema entry that markup sets is a silent behaviour change if the HUD
  // ever grows a knob for it.
  maxEntries: 4,
  displayDuration: 4000,
};

export class KillNotification {
  constructor(game, opts = {}) {
    this.game = game;
    this.data = { ...DEFAULTS, ...opts };
    this.hud = getHud(game);
    this._off = game.events.on("local-kill", (e) => this.onLocalKill(e));
  }

  onLocalKill(event) {
    if (!this.data.enabled) return;
    const victimName = (event.detail && event.detail.victimName) || "Unknown Player";
    // KillerMessagePlus: your own frags are reported to you in the second
    // person, in the death-message red, with no decoration around the name.
    this.hud.pushMessage(`You killed ${victimName}`, "death");
  }

  dispose() {
    if (this._off) this._off();
    this._off = null;
    if (this.hud) {
      this.hud.release();
      this.hud = null;
    }
  }
}
