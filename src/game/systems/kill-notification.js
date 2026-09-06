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
  // Kept for compatibility with anything that sets them; the rail's four-line cap
  // and 3 s LocalMessage lifetime are the source's, not ours.
  maxEntries: 4,
  displayDuration: 3000,
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
