// health.js — server-authoritative HP with floating text + HUD readout
//
// The 2D chrome (health plate, damage vignette, death screen) lives in the shared
// HUD module; this component owns the HP state and the world-space label only.
import { getHud } from "./hud/hud-root.js";

AFRAME.registerComponent("health", {
  schema: {
    max: { type: "int", default: 100 },
    current: { type: "int", default: 100 },
  },

  init() {
    this.hp = this.data.current;
    this.isDead = false;

    // Floating overhead readout (billboarded to face camera). Just the number:
    // "HP: 100/100" in green monospace was the last thing on screen that read
    // like a debug print rather than part of the game.
    this.label = document.createElement("a-entity");
    this.label.setAttribute("text", {
      value: String(this.hp),
      align: "center",
      color: "#ffffff",
      width: 1.4,
    });
    this.label.setAttribute("look-at", "[camera]");
    this.label.object3D.position.set(0, 2.2, 0);
    this.el.appendChild(this.label);

    this.isLocalPlayer = this.el.id === "soldier" && this.el.closest("#rig");

    // Only the local player gets screen chrome. Remote avatars carry this component
    // too and must not build (or later tear down) a second HUD.
    if (this.isLocalPlayer) {
      this.hud = getHud();
      this.hud.setHealth(this.hp, this.data.max);
      // No armour exists on the server yet. Showing a real 0 on a dimmed plate is
      // honest; inventing a value that never moves would not be. Wire the pickup
      // and this becomes one hud.setArmor() call.
      this.hud.setArmor(0);
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
    this.label.setAttribute("text", "value", String(Math.max(0, this.hp)));
    // Same three bands the HUD plate uses — white while healthy, amber when
    // hurt, red when nearly dead — so the overhead number and the bar agree.
    const pct = this.data.max > 0 ? this.hp / this.data.max : 0;
    const color = pct > 0.6 ? "#ffffff" : pct > 0.25 ? "#ffa023" : "#ff4436";
    this.label.setAttribute("text", "color", color);

    if (this.isLocalPlayer && this.hud) {
      this.hud.setHealth(this.hp, this.data.max);
    }
  },

  onDeath() {
    this.isDead = true;
    this.label.setAttribute("text", "color", "gray");

    if (this.isLocalPlayer) {
      if (this.hud) this.hud.showDeath();
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
      if (this.hud) this.hud.hideDeath();
      // Re-enable firing
      const cam = document.querySelector("#cam");
      if (cam) cam.setAttribute("first-person-weapon", "enabled", true);
      // The counterpart of local-death above. Anything that got out of the player's
      // way while they were dead needs to know when to come back — pointer-lock-prompt
      // is the first such thing, and there was no event for it to listen to.
      this.el.sceneEl.emit("local-respawn");
    }
  },

  flashScreen() {
    if (this.hud) this.hud.damageFlash();
  },

  remove() {
    if (this.hud) {
      this.hud.release();
      this.hud = null;
    }
    if (this.label && this.label.parentNode) {
      this.label.parentNode.removeChild(this.label);
    }
  },
});
