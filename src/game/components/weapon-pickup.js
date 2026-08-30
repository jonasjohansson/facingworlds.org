// weapon-pickup.js — the pedestal items you run over to change your loadout.
//
// The SERVER owns pickups completely: which exist, where they are, whether they
// are available, and who holds what. This component only renders them and asks.
// That split is not ceremony — if the client decided, two players standing on
// the same pedestal would both walk away with the second Enforcer.
//
// The flow is: server announces pickups in `hello` -> this system spawns a
// floating, spinning weapon for each -> when the local player is inside the
// radius it sends `takePickup` -> the server accepts or ignores it -> a
// `pickup-taken` broadcast hides the item for everyone, and `pickup-respawn`
// brings it back. The client never decides it has something.

import { GAME_CONFIG } from "../config/game-config.js";

const CFG = GAME_CONFIG.PICKUP;

AFRAME.registerSystem("weapon-pickup", {
  init() {
    this.items = new Map(); // id -> { el, data, available }
    this.lastClaim = 0;
    this._rigPos = new THREE.Vector3();
    this._itemPos = new THREE.Vector3();

    const scene = this.el;

    // The network layer re-emits the server's pickup messages verbatim.
    scene.addEventListener("pickups-init", (e) => this.reset(e.detail && e.detail.pickups));
    scene.addEventListener("pickup-taken", (e) => this.setAvailable(e.detail.id, false));
    scene.addEventListener("pickup-respawn", (e) => this.setAvailable(e.detail.id, true));
  },

  /** Replace the whole set. Called on hello, including after a reconnect. */
  reset(list) {
    for (const item of this.items.values()) {
      if (item.el && item.el.parentNode) item.el.parentNode.removeChild(item.el);
    }
    this.items.clear();
    if (!Array.isArray(list)) return;
    for (const p of list) this.spawn(p);
  },

  spawn(p) {
    const scene = this.el;
    const el = document.createElement("a-entity");
    el.setAttribute("position", `${p.x} ${p.y} ${p.z}`);
    el.setAttribute("weapon-pickup-item", { pickupId: p.id, type: p.type });
    scene.appendChild(el);
    this.items.set(p.id, { el, data: p, available: p.available !== false });
    // A pickup taken before we joined must not be standing there.
    if (p.available === false) el.setAttribute("visible", false);
  },

  setAvailable(id, available) {
    const item = this.items.get(id);
    if (!item) return;
    item.available = available;
    item.el.setAttribute("visible", available);
  },

  /**
   * Called every frame by the item component (one of them, not all) so the
   * proximity test runs once regardless of how many pickups exist.
   */
  checkLocalPlayer(rigEl, time) {
    if (!rigEl || time - this.lastClaim < CFG.CLAIM_INTERVAL) return;

    rigEl.object3D.getWorldPosition(this._rigPos);
    for (const [id, item] of this.items) {
      if (!item.available) continue;
      item.el.object3D.getWorldPosition(this._itemPos);
      if (this._rigPos.distanceTo(this._itemPos) > CFG.RADIUS) continue;

      // Ask. The server decides — it may refuse because we already hold this,
      // because someone beat us to it by a frame, or because we are dead.
      this.lastClaim = time;
      this.el.emit("request-pickup", { id });
      return;
    }
  },
});

AFRAME.registerComponent("weapon-pickup-item", {
  schema: {
    pickupId: { type: "string", default: "" },
    type: { type: "string", default: "dual-enforcer" },
  },

  init() {
    this.phase = Math.random() * Math.PI * 2; // so multiple pickups do not bob in lockstep
    this.baseY = this.el.object3D.position.y;
    this.rig = document.querySelector("#rig");

    // Only the first item drives the proximity check, so N pickups cost one
    // distance sweep per frame rather than N.
    this.isDriver = !this.el.sceneEl.systems["weapon-pickup"]._driver;
    if (this.isDriver) this.el.sceneEl.systems["weapon-pickup"]._driver = this;

    this.buildVisual();
  },

  buildVisual() {
    // The weapon itself, floating. Same model the player carries — this is the
    // whole point of the dual Enforcer: no new art, and what you see on the
    // pedestal is literally what you pick up.
    const model = document.createElement("a-entity");
    model.setAttribute("gltf-model", "#enforcer-weapon");
    model.setAttribute("scale", "0.05 0.05 0.05");
    model.setAttribute("rotation", "0 0 0");
    this.el.appendChild(model);
    this.model = model;

    // A light rather than a glowing shell: the scene is bloom-composited, so a
    // real light bleeds into the bloom pass and reads as a glow for free.
    const glow = document.createElement("a-entity");
    glow.setAttribute("light", {
      type: "point",
      color: CFG.GLOW_COLOR,
      intensity: CFG.GLOW_INTENSITY,
      distance: CFG.GLOW_RANGE,
      castShadow: false,
    });
    this.el.appendChild(glow);
    this.glow = glow;
  },

  tick(time, dtMs) {
    const dt = dtMs / 1000;
    const obj = this.el.object3D;

    obj.rotation.y += CFG.SPIN_SPEED * dt;
    this.phase += CFG.BOB_SPEED * dt;
    obj.position.y = this.baseY + Math.sin(this.phase) * CFG.BOB_HEIGHT;

    if (this.isDriver) {
      this.el.sceneEl.systems["weapon-pickup"].checkLocalPlayer(this.rig, time);
    }
  },

  remove() {
    const sys = this.el.sceneEl.systems["weapon-pickup"];
    if (sys && sys._driver === this) sys._driver = null;
  },
});
