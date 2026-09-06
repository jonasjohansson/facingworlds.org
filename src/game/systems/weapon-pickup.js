// weapon-pickup.js — the pedestal items you run over to change your loadout.
//
// The SERVER owns pickups completely: which exist, where they are, whether they
// are available, and who holds what. This system only renders them and asks.
// That split is not ceremony — if the client decided, two players standing on
// the same pedestal would both walk away with the second Enforcer.
//
// The flow is: server announces pickups in `hello` -> this system spawns a
// floating, spinning weapon for each -> when the local player is inside the
// radius it sends `takePickup` -> the server accepts or ignores it -> a
// `pickup-taken` broadcast hides the item for everyone, and `pickup-respawn`
// brings it back. The client never decides it has something.
import * as THREE from "three";
import { GAME_CONFIG } from "../config/game-config.js";
import { ASSETS, attachModel } from "../engine/assets.js";
import { makeLight } from "../scene/lights.js";

const CFG = GAME_CONFIG.PICKUP;

// Every pickup class CTF-Face places, and the model extracted for it. Keys match
// PICKUP_TYPE in server/server.js; `dir` is the Unreal class name, which is how
// assets/3d/pickups is laid out.
//
// These are the ONLY models still loaded out of assets/3d/ rather than
// assets-optimized/: scripts/optimize-assets.mjs does not cover the pickup set (see
// assets-optimized/3d/, which holds the map, the navmesh, the soldier and the
// Enforcer). The URLs are exactly the ones the A-Frame `gltf-model` attribute built.
export const PICKUP_MODELS = {
  armor: { dir: "armor2" },
  udamage: { dir: "UDamage" },
  "health-big": { dir: "HealthPack" },
  "weapon-sniper": { dir: "SniperRifle", tilt: [0, 0, 12] },
  "weapon-shock": { dir: "ShockRifle", tilt: [0, 0, 12] },
  "weapon-rocket": { dir: "UT_Eightball", tilt: [0, 0, 12] },
  "weapon-ripper": { dir: "ripper", tilt: [0, 0, 12] },
  "weapon-redeemer": { dir: "WarheadLauncher", tilt: [0, 0, 12] },
  "ammo-bullet": { dir: "BulletBox" },
  "ammo-rocket": { dir: "RocketPack" },
  "ammo-shock": { dir: "ShockCore" },
};

/** The extracted-UT99 model URL for a pickup type, or null if it is drawn by hand. */
export function pickupModelUrl(type) {
  const spec = PICKUP_MODELS[type];
  return spec ? `assets/3d/pickups/${spec.dir}/${spec.dir}.gltf` : null;
}

const deg = THREE.MathUtils.degToRad;

// ---------------------------------------------------------------------------
// Item: one pickup's node, its visual and its spin/bob.
// ---------------------------------------------------------------------------

export class PickupItem {
  /** `node` is already positioned and parented; `opts` is what the schema defaulted. */
  constructor(game, node, opts = {}) {
    this.game = game;
    this.node = node;
    this.pickupId = opts.pickupId || "";
    this.type = opts.type || "dual-enforcer";
    this.available = opts.available !== false;
    // The server's own row for this pickup, kept as the old system's per-item `data`
    // was — the one place to look when a pedestal is somewhere surprising.
    this.data = opts.data || null;

    this.phase = Math.random() * Math.PI * 2; // so multiple pickups do not bob in lockstep
    this.baseY = node.position.y;
    this.disposed = false;
    this._disposables = [];

    // The model is fetched, so the visual lands a frame or several after the node
    // does. `ready` is what the probes (and reset()) wait on; A-Frame hid the same
    // latency behind gltf-model's own `model-loaded`.
    // A model that will not load must not take the frame down with it, and must not
    // surface as an unhandled rejection: A-Frame's gltf-model logged and carried on,
    // and a pedestal with no mesh on it is still a pedestal the server will hand over.
    this.ready = this.buildVisual().catch((err) => {
      console.warn(`[weapon-pickup] ${this.type} (${this.pickupId}) failed to load`, err);
      return null;
    });
  }

  /**
   * An extracted UT99 pickup. The models in assets/3d/pickups are already sized in
   * metres against a 1.83 m player, so they go in at scale 1 with no per-item tuning.
   *
   * Weapons are tilted for the same reason the Enforcer is: flat on the horizontal a
   * long thin object spins through a moment, twice a turn, where it is edge-on to the
   * camera and reads as a floating stick.
   */
  async buildUtVisual(spec) {
    const model = new THREE.Group();
    if (spec.tilt) model.rotation.set(deg(spec.tilt[0]), deg(spec.tilt[1]), deg(spec.tilt[2]));
    this.node.add(model);
    this.model = model;
    await this.attach(model, pickupModelUrl(this.type));
    // NO point light, for the same reason the MedBoxes have none (see below): three.js
    // recompiles and re-runs the lighting loop in every material in the scene for each
    // light, and there are 48 of these. Two Enforcer pedestals could afford one; the
    // whole of CTF-Face's item set cannot. The items read from their own albedo and the
    // scene's lighting, and the pickup's spin and bob do the rest of the work.
  }

  /**
   * attachModel + the one thing `model-loaded` used to do for free. In A-Frame that
   * event bubbled to the scene, so environment-map caught every model as it streamed
   * in and rebuilt its materials for the newly present IBL. Models are awaited now, so
   * anything spawned mid-match has to say so on the bus itself.
   */
  async attach(node, url) {
    const { root } = await attachModel(node, url);
    if (this.disposed) {
      node.remove(root);
      return null;
    }
    this.game.events.emit("model-loaded", { model: root });
    return root;
  }

  async buildVisual() {
    if (this.type === "health") return this.buildHealthVisual();
    // Everything else CTF-Face actually has, drawn as the item Epic drew.
    const ut = PICKUP_MODELS[this.type];
    if (ut) return this.buildUtVisual(ut);
    return this.buildEnforcerVisual();
  }

  /**
   * The weapon itself, floating. Same model the player carries — this is the
   * whole point of the dual Enforcer: no new art, and what you see on the
   * pedestal is literally what you pick up.
   *
   * Nothing on CTF-Face hands out a `dual-enforcer` any more (server/server.js took
   * the two roof pedestals back to UT99's Body Armor), so this is the fallback branch
   * for any type with no model of its own — put `dual-enforcer` on an actor and it
   * comes straight back.
   *
   * SCALE. The mesh is 21.6 model units long, so the old 0.05 drew a pistol 1.08 m
   * from muzzle to grip — longer than the avatar's arm, and the single loudest
   * reason a pedestal read as "a big object" rather than "a gun". UT99 draws a
   * weapon pickup a touch larger than the held weapon so it is findable across a
   * room, not twice life size; 0.029 gives 0.63 m, about 1.7x the 0.37 m the
   * first-person gun measures at index.html's 0.025.
   *
   * TILT. Muzzle down and canted, so the silhouette is unmistakably a weapon from
   * any angle. Flat on the horizontal it spins through a moment, twice a turn, where
   * it is edge-on to the camera and reads as a floating stick.
   */
  async buildEnforcerVisual() {
    const model = new THREE.Group();
    model.scale.setScalar(0.029);
    model.rotation.set(deg(-24), 0, deg(12));
    this.node.add(model);
    this.model = model;

    // A light rather than a glowing shell: the scene is bloom-composited, so a
    // real light bleeds into the bloom pass and reads as a glow for free.
    this.glow = makeLight({
      type: "point",
      color: CFG.GLOW_COLOR,
      intensity: CFG.GLOW_INTENSITY,
      distance: CFG.GLOW_RANGE,
      castShadow: false,
    });
    this.node.add(this.glow);

    await this.attach(model, ASSETS.enforcerWeapon);
  }

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

    this.node.add(group);
    this.model = group;
    this._disposables.push(boxGeo, boxMat, barGeo, crossMat);
  }

  update(dt) {
    const node = this.node;
    node.rotation.y += CFG.SPIN_SPEED * dt;
    this.phase += CFG.BOB_SPEED * dt;
    node.position.y = this.baseY + Math.sin(this.phase) * CFG.BOB_HEIGHT;
  }

  dispose() {
    this.disposed = true;
    // The glTF pickups go with the node; the MedBox is raw three.js built here, so its
    // geometries and materials are ours to free. reset() tears the whole set down on
    // every reconnect, so leaking here would leak per reconnect.
    this.node.removeFromParent();
    for (const d of this._disposables) {
      if (d && typeof d.dispose === "function") d.dispose();
    }
    this._disposables.length = 0;
  }
}

// ---------------------------------------------------------------------------
// System: owns the set, and the one proximity sweep per frame.
// ---------------------------------------------------------------------------

export class WeaponPickups {
  constructor(game) {
    this.game = game;
    this.items = new Map(); // id -> PickupItem
    this.lastClaim = 0;
    this._rigPos = new THREE.Vector3();
    this._itemPos = new THREE.Vector3();

    // The network layer re-emits the server's pickup messages verbatim.
    this._off = [
      game.events.on("pickups-init", (e) => this.reset(e.detail && e.detail.pickups)),
      game.events.on("pickup-taken", (e) => this.setAvailable(e.detail.id, false)),
      game.events.on("pickup-respawn", (e) => this.setAvailable(e.detail.id, true)),
    ];
  }

  /** Replace the whole set. Called on hello, including after a reconnect. */
  reset(list) {
    for (const item of this.items.values()) item.dispose();
    this.items.clear();
    if (!Array.isArray(list)) return;
    for (const p of list) this.spawn(p);
  }

  spawn(p) {
    if (!p || !p.id) return null;
    const node = new THREE.Group();
    node.name = `pickup-${p.id}`;
    node.position.set(p.x, p.y, p.z);
    // A pickup taken before we joined must not be standing there. Set before the
    // model lands, and never touched by the build, so an item that arrives taken
    // stays invisible however long the glTF takes.
    node.visible = p.available !== false;
    this.game.world.add(node);

    const item = new PickupItem(this.game, node, {
      pickupId: p.id,
      type: p.type,
      available: p.available !== false,
      data: p,
    });
    this.game.attach(node, "weapon-pickup-item", item);
    this.items.set(p.id, item);
    return item;
  }

  setAvailable(id, available) {
    const item = this.items.get(id);
    if (!item) return;
    item.available = !!available;
    item.node.visible = !!available;
  }

  /** Every item's model, once they are all in. The probes wait on this. */
  ready() {
    return Promise.all([...this.items.values()].map((i) => i.ready));
  }

  /**
   * Spin, bob, and one distance sweep for the whole set.
   *
   * The sweep used to be driven by whichever item happened to init first — A-Frame had
   * no system tick to hang it on, so N pickups would otherwise have cost N sweeps a
   * frame. A system update cannot be orphaned by the removal of an item, and it keeps
   * running while there are none at all.
   */
  update(dt, now) {
    for (const item of this.items.values()) item.update(dt, now);
    this.checkLocalPlayer(now);
  }

  checkLocalPlayer(now) {
    // The player controller registers after the world is built, so the rig is null for
    // the first frames of a page load — and stays null on a page with no player at all.
    if (!this.game.rig) return;
    if (now - this.lastClaim < CFG.CLAIM_INTERVAL) return;

    this.game.rig.getWorldPosition(this._rigPos);
    for (const [id, item] of this.items) {
      if (!item.available) continue;
      item.node.getWorldPosition(this._itemPos);
      if (this._rigPos.distanceTo(this._itemPos) > CFG.RADIUS) continue;

      // Ask. The server decides — it may refuse because we already hold this,
      // because someone beat us to it by a frame, or because we are dead.
      this.lastClaim = now;
      this.game.events.emit("request-pickup", { id });
      return;
    }
  }

  dispose() {
    for (const off of this._off) off();
    this._off.length = 0;
    this.reset(null);
  }
}
