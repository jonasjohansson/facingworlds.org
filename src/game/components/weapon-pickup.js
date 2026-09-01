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

// Every pickup class CTF-Face places, and the model extracted for it. Keys match
// PICKUP_TYPE in server/server.js; `dir` is the Unreal class name, which is how
// assets/3d/pickups is laid out.
const PICKUP_MODELS = {
  armor: { dir: "armor2" },
  udamage: { dir: "UDamage" },
  "health-big": { dir: "HealthPack" },
  "weapon-sniper": { dir: "SniperRifle", tilt: "0 0 12" },
  "weapon-shock": { dir: "ShockRifle", tilt: "0 0 12" },
  "weapon-rocket": { dir: "UT_Eightball", tilt: "0 0 12" },
  "weapon-ripper": { dir: "ripper", tilt: "0 0 12" },
  "weapon-redeemer": { dir: "WarheadLauncher", tilt: "0 0 12" },
  "ammo-bullet": { dir: "BulletBox" },
  "ammo-rocket": { dir: "RocketPack" },
  "ammo-shock": { dir: "ShockCore" },
};

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

  /**
   * An extracted UT99 pickup. The models in assets/3d/pickups are already sized in
   * metres against a 1.83 m player, so they go in at scale 1 with no per-item tuning.
   *
   * Weapons are tilted for the same reason the Enforcer is: flat on the horizontal a
   * long thin object spins through a moment, twice a turn, where it is edge-on to the
   * camera and reads as a floating stick.
   */
  buildUtVisual(spec) {
    const model = document.createElement("a-entity");
    model.setAttribute("gltf-model", `url(assets/3d/pickups/${spec.dir}/${spec.dir}.gltf)`);
    if (spec.tilt) model.setAttribute("rotation", spec.tilt);
    this.el.appendChild(model);
    this.model = model;
    // NO point light, for the same reason the MedBoxes have none (see below): three.js
    // recompiles and re-runs the lighting loop in every material in the scene for each
    // light, and there are 48 of these. Two Enforcer pedestals could afford one; the
    // whole of CTF-Face's item set cannot. The items read from their own albedo and the
    // scene's lighting, and the pickup's spin and bob do the rest of the work.
  },

  buildVisual() {
    if (this.data.type === "health") return this.buildHealthVisual();
    // Everything else CTF-Face actually has, drawn as the item Epic drew.
    const ut = PICKUP_MODELS[this.data.type];
    if (ut) return this.buildUtVisual(ut);

    // The weapon itself, floating. Same model the player carries — this is the
    // whole point of the dual Enforcer: no new art, and what you see on the
    // pedestal is literally what you pick up.
    //
    // SCALE. The mesh is 21.6 model units long, so the old 0.05 drew a pistol 1.08 m
    // from muzzle to grip — longer than the avatar's arm, and the single loudest
    // reason a pedestal read as "a big object" rather than "a gun". UT99 draws a
    // weapon pickup a touch larger than the held weapon so it is findable across a
    // room, not twice life size; 0.029 gives 0.63 m, about 1.7x the 0.37 m the
    // first-person gun measures at index.html's 0.025.
    //
    // TILT. Muzzle down and canted, so the silhouette is unmistakably a weapon from
    // any angle. Flat on the horizontal it spins through a moment, twice a turn, where
    // it is edge-on to the camera and reads as a floating stick.
    const model = document.createElement("a-entity");
    model.setAttribute("gltf-model", "#enforcer-weapon");
    model.setAttribute("scale", "0.029 0.029 0.029");
    model.setAttribute("rotation", "-24 0 12");
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

  /**
   * The MedBox: a small white-crossed box, built from primitives.
   *
   * Deliberately NO point light, unlike the Enforcer pedestals. There are eight of
   * these (CTF-Face's own MedBox positions, four in each tower base) against two
   * Enforcers, and a point light is not free — three.js recompiles and re-runs the
   * lighting loop in every material in the scene for each one, so eight more would be
   * paid for by every surface on the map whether or not anyone is near a MedBox. The
   * cross is MeshBasic with toneMapped off instead, which the bloom pass lifts on its
   * own: the same trick the flag stand's ring uses, for the same reason.
   *
   * Prop-sized against the PLAYER who runs into it, so none of these dimensions moved
   * with the world scale.
   */
  buildHealthVisual() {
    const group = new THREE.Group();
    this._disposables = [];

    const boxGeo = new THREE.BoxGeometry(0.36, 0.26, 0.26);
    const boxMat = new THREE.MeshStandardMaterial({ color: 0xdfe4ea, roughness: 0.65, metalness: 0.05 });
    group.add(new THREE.Mesh(boxGeo, boxMat));

    // One cross, two bars, drawn just proud of the lid so it never z-fights it.
    const crossMat = new THREE.MeshBasicMaterial({ color: 0xff2f3a, toneMapped: false });
    const barGeo = new THREE.BoxGeometry(0.2, 0.02, 0.06);
    for (const ry of [0, Math.PI / 2]) {
      const bar = new THREE.Mesh(barGeo, crossMat);
      bar.position.y = 0.135;
      bar.rotation.y = ry;
      group.add(bar);
    }

    this.el.setObject3D("medbox", group);
    this._disposables.push(boxGeo, boxMat, barGeo, crossMat);
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
    // The gltf pickups are entities and go with the node; the MedBox is raw three.js
    // built here, so its geometries and materials are ours to free. reset() tears the
    // whole set down on every reconnect, so leaking here would leak per reconnect.
    // Guarded on _disposables rather than called blind: removeObject3D warns for a key
    // that was never set, and that would be every Enforcer, every rebuild.
    if (!this._disposables) return;
    this.el.removeObject3D("medbox");
    for (const d of this._disposables) {
      if (d && typeof d.dispose === "function") d.dispose();
    }
    this._disposables = null;
  },
});
