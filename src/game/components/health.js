// health.js — server-authoritative HP with floating text + screen flash
AFRAME.registerComponent("health", {
  schema: {
    max: { type: "int", default: 100 },
    current: { type: "int", default: 100 },
  },

  init() {
    this.hp = this.data.current;
    this.isDead = false;

    // floating text label above head (billboarded to face camera)
    this.label = document.createElement("a-entity");
    this.label.setAttribute("text", {
      value: `HP: ${this.hp}/${this.data.max}`,
      align: "center",
      color: "#4caf50",
      width: 2,
    });
    this.label.setAttribute("look-at", "[camera]");
    this.label.object3D.position.set(0, 2.2, 0);
    this.el.appendChild(this.label);

    this.isLocalPlayer = this.el.id === "soldier" && this.el.closest("#rig");

    // global damage screen overlay (for local player only)
    if (this.isLocalPlayer) {
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

      // HUD health bar (bottom-left)
      this.hudContainer = document.createElement("div");
      Object.assign(this.hudContainer.style, {
        position: "fixed",
        bottom: "20px",
        left: "20px",
        background: "rgba(0, 0, 0, 0.6)",
        borderRadius: "6px",
        padding: "8px 12px",
        pointerEvents: "none",
        zIndex: "9998",
        display: "flex",
        alignItems: "center",
        gap: "10px",
        fontFamily: "Arial, sans-serif",
        backdropFilter: "blur(4px)",
      });
      // HP number
      this.hudNumber = document.createElement("div");
      Object.assign(this.hudNumber.style, {
        color: "#4caf50",
        fontSize: "28px",
        fontWeight: "bold",
        minWidth: "50px",
        textAlign: "right",
        textShadow: "0 0 8px rgba(76, 175, 80, 0.5)",
      });
      this.hudNumber.textContent = this.hp;
      // Bar track
      this.hudBarTrack = document.createElement("div");
      Object.assign(this.hudBarTrack.style, {
        width: "120px",
        height: "10px",
        background: "rgba(255, 255, 255, 0.15)",
        borderRadius: "5px",
        overflow: "hidden",
      });
      // Bar fill
      this.hudBarFill = document.createElement("div");
      Object.assign(this.hudBarFill.style, {
        width: "100%",
        height: "100%",
        background: "#4caf50",
        borderRadius: "5px",
        transition: "width 0.2s ease-out, background 0.2s ease-out",
      });
      this.hudBarTrack.appendChild(this.hudBarFill);
      this.hudContainer.appendChild(this.hudNumber);
      this.hudContainer.appendChild(this.hudBarTrack);
      document.body.appendChild(this.hudContainer);

      // Death overlay
      this.deathOverlay = document.createElement("div");
      Object.assign(this.deathOverlay.style, {
        position: "fixed",
        top: "0",
        left: "0",
        width: "100%",
        height: "100%",
        background: "rgba(0,0,0,0.6)",
        display: "none",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        pointerEvents: "none",
        zIndex: "10000",
      });
      const deathText = document.createElement("div");
      Object.assign(deathText.style, {
        color: "#ff4444",
        fontSize: "48px",
        fontWeight: "bold",
        fontFamily: "Arial, sans-serif",
        textShadow: "0 0 20px rgba(255,0,0,0.5)",
        marginBottom: "12px",
      });
      deathText.textContent = "YOU DIED";
      this.deathOverlay.appendChild(deathText);

      this.respawnText = document.createElement("div");
      Object.assign(this.respawnText.style, {
        color: "#ccc",
        fontSize: "18px",
        fontFamily: "Arial, sans-serif",
      });
      this.respawnText.textContent = "Respawning...";
      this.deathOverlay.appendChild(this.respawnText);

      document.body.appendChild(this.deathOverlay);
    }

    // listen for server authoritative hp
    this.el.addEventListener("sethp", (e) => {
      const newHp = e.detail.hp;
      const tookDamage = newHp < this.hp;
      const wasRevived = this.isDead && newHp > 0;
      this.hp = newHp;
      if (this.hp < 0) this.hp = 0;

      this.updateLabel();

      if (tookDamage && this.isLocalPlayer) {
        this.flashScreen();
      }

      if (this.hp <= 0 && !this.isDead) {
        this.onDeath();
      } else if (wasRevived) {
        this.onRespawn();
      }
    });
  },

  updateLabel() {
    this.label.setAttribute("text", "value", `HP: ${this.hp}/${this.data.max}`);
    // Color from green to red based on HP
    const pct = this.hp / this.data.max;
    const r = Math.round(255 * (1 - pct));
    const g = Math.round(200 * pct);
    const color = `rgb(${r},${g},50)`;
    this.label.setAttribute("text", "color", color);

    // Update HUD health bar
    if (this.isLocalPlayer && this.hudContainer) {
      this.hudNumber.textContent = this.hp;
      this.hudNumber.style.color = color;
      this.hudNumber.style.textShadow = `0 0 8px ${color}`;
      this.hudBarFill.style.width = `${Math.max(0, pct * 100)}%`;
      this.hudBarFill.style.background = color;
    }
  },

  onDeath() {
    this.isDead = true;
    this.label.setAttribute("text", "color", "gray");

    if (this.isLocalPlayer) {
      // Show death overlay
      if (this.deathOverlay) {
        this.deathOverlay.style.display = "flex";
      }
      // Disable firing
      const cam = document.querySelector("#cam");
      if (cam) cam.setAttribute("first-person-weapon", "enabled", false);
      // Emit local-death for spree tracking
      this.el.sceneEl.emit("local-death");
    }
  },

  onRespawn() {
    this.isDead = false;

    if (this.isLocalPlayer) {
      // Hide death overlay
      if (this.deathOverlay) {
        this.deathOverlay.style.display = "none";
      }
      // Re-enable firing
      const cam = document.querySelector("#cam");
      if (cam) cam.setAttribute("first-person-weapon", "enabled", true);
    }
  },

  flashScreen() {
    if (!this.flashOverlay) return;
    this.flashOverlay.style.opacity = "1";
    setTimeout(() => {
      this.flashOverlay.style.opacity = "0";
    }, 150);
  },

  remove() {
    if (this.flashOverlay && this.flashOverlay.parentNode) {
      this.flashOverlay.remove();
    }
    if (this.deathOverlay && this.deathOverlay.parentNode) {
      this.deathOverlay.remove();
    }
    if (this.hudContainer && this.hudContainer.parentNode) {
      this.hudContainer.remove();
    }
    if (this.label && this.label.parentNode) {
      this.label.parentNode.removeChild(this.label);
    }
  },
});
