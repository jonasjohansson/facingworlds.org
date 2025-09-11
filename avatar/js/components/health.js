// health.js — server-authoritative HP with floating text + screen flash
AFRAME.registerComponent("health", {
  schema: {
    max: { type: "int", default: 100 },
    current: { type: "int", default: 100 },
  },

  init() {
    this.hp = this.data.current;

    // floating text label above head
    this.label = document.createElement("a-entity");
    this.label.setAttribute("text", {
      value: `HP: ${this.hp}/${this.data.max}`,
      align: "center",
      color: "red",
      width: 2,
    });
    this.label.object3D.position.set(0, 2.2, 0);
    this.el.appendChild(this.label);

    // global damage screen overlay (for local player only)
    if (this.el.id === "soldier" && this.el.closest("#rig")) {
      this.flashOverlay = document.createElement("div");
      Object.assign(this.flashOverlay.style, {
        position: "fixed",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        backgroundColor: "rgba(255,0,0,0.4)",
        opacity: "0",
        transition: "opacity 0.3s ease-out",
        pointerEvents: "none",
        zIndex: 9999,
      });
      document.body.appendChild(this.flashOverlay);
    }

    // listen for server authoritative hp
    this.el.addEventListener("sethp", (e) => {
      const newHp = e.detail.hp;
      const tookDamage = newHp < this.hp;
      this.hp = newHp;
      if (this.hp < 0) this.hp = 0;

      this.updateLabel();

      if (tookDamage && this.el.id === "soldier" && this.el.closest("#rig")) {
        this.flashScreen();
      }

      if (this.hp <= 0) {
        this.onDeath();
      } else {
        this.resetColor();
      }
    });
  },

  updateLabel() {
    this.label.setAttribute("text", "value", `HP: ${this.hp}/${this.data.max}`);
  },

  onDeath() {
    this.label.setAttribute("text", "color", "gray");
  },

  resetColor() {
    this.label.setAttribute("text", "color", "red");
  },

  flashScreen() {
    if (!this.flashOverlay) return;
    this.flashOverlay.style.opacity = "1";
    setTimeout(() => {
      this.flashOverlay.style.opacity = "0";
    }, 150); // quick flash
  },
});
