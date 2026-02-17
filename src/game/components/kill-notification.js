// kill-notification.js — Top-right stacking kill feed
AFRAME.registerComponent("kill-notification", {
  schema: {
    enabled: { type: "boolean", default: true },
    maxEntries: { type: "number", default: 4 },
    displayDuration: { type: "number", default: 4000 },
  },

  init() {
    // Persistent container (top-right corner)
    this.container = document.createElement("div");
    Object.assign(this.container.style, {
      position: "fixed",
      top: "20px",
      right: "20px",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      pointerEvents: "none",
      zIndex: "10000",
      fontFamily: "Arial, sans-serif",
    });
    document.body.appendChild(this.container);

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
    Object.assign(entry.style, {
      background: "rgba(0, 0, 0, 0.7)",
      color: "#ff6b6b",
      padding: "6px 14px",
      borderRadius: "4px",
      fontSize: "14px",
      fontWeight: "bold",
      borderLeft: "3px solid #ff6b6b",
      opacity: "0",
      transform: "translateX(30px)",
      transition: "opacity 0.3s ease-out, transform 0.3s ease-out",
      whiteSpace: "nowrap",
    });
    entry.textContent = `You killed ${victimName}`;

    // Insert at top of container
    this.container.prepend(entry);
    this.entries.unshift(entry);

    // Slide in
    requestAnimationFrame(() => {
      entry.style.opacity = "1";
      entry.style.transform = "translateX(0)";
    });

    // Trim excess entries
    while (this.entries.length > this.data.maxEntries) {
      const old = this.entries.pop();
      if (old.parentNode) old.remove();
    }

    // Fade out and remove after duration
    setTimeout(() => {
      entry.style.transition = "opacity 0.5s ease-out";
      entry.style.opacity = "0";
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
  },
});
