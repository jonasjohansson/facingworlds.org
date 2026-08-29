// kill-notification.js — top-right stacking kill feed
//
// Entries are bevelled mini-plates matching the corner readouts; all presentation
// is in styles.css under `.ut-killfeed`. The `local-kill` contract is unchanged.
import { getHud } from "./hud/hud-root.js";

AFRAME.registerComponent("kill-notification", {
  schema: {
    enabled: { type: "boolean", default: true },
    maxEntries: { type: "number", default: 4 },
    displayDuration: { type: "number", default: 4000 },
  },

  init() {
    this.hud = getHud();

    // Persistent rail, parked under the network status chip
    this.container = document.createElement("div");
    this.container.className = "ut-killfeed";
    this.hud.mount(this.container);

    this.entries = [];

    this._onLocalKill = this.onLocalKill.bind(this);
    this.el.sceneEl.addEventListener("local-kill", this._onLocalKill);
  },

  onLocalKill(event) {
    if (!this.data.enabled) return;
    const victimName = event.detail.victimName || "Unknown Player";
    this.addEntry(victimName);
  },

  addEntry(victimName) {
    const entry = document.createElement("div");
    entry.className = "ut-killfeed__entry";

    const verb = document.createElement("span");
    verb.className = "ut-killfeed__verb";
    verb.textContent = "YOU KILLED";

    const name = document.createElement("span");
    name.className = "ut-killfeed__name";
    name.textContent = victimName;

    entry.appendChild(verb);
    entry.appendChild(name);

    // Insert at top of container
    this.container.prepend(entry);
    this.entries.unshift(entry);

    // Slide in
    requestAnimationFrame(() => {
      entry.classList.add("is-in");
    });

    // Trim excess entries
    while (this.entries.length > this.data.maxEntries) {
      const old = this.entries.pop();
      if (old.parentNode) old.remove();
    }

    // Fade out and remove after duration
    setTimeout(() => {
      entry.classList.remove("is-in");
      setTimeout(() => {
        if (entry.parentNode) entry.remove();
        const idx = this.entries.indexOf(entry);
        if (idx > -1) this.entries.splice(idx, 1);
      }, 500);
    }, this.data.displayDuration);
  },

  remove() {
    this.entries.forEach((e) => { if (e.parentNode) e.remove(); });
    this.entries = [];
    if (this.container && this.container.parentNode) this.container.remove();
    this.el.sceneEl.removeEventListener("local-kill", this._onLocalKill);
    if (this.hud) {
      this.hud.release();
      this.hud = null;
    }
  },
});
