// ctf-flag.js — the two team flags and the lit disc each one stands on.
//
// Same split as weapon-pickup.js, for the same reason: the SERVER owns flag
// state (who has it, where it fell, whether a touch counts as a take, a return
// or a capture). This file renders that state and asks. If the client decided,
// two players reaching a dropped flag on the same frame would both run off with
// it, and a capture would be whatever the fastest machine claimed.
//
// The flow is: `ctf-init` (from `hello`, and again after `match-reset`) rebuilds
// both flags wholesale -> the system's own per-frame proximity sweep emits
// `request-flag-touch` when the local player stands on one -> the server answers with a
// `flag` broadcast, relayed here as `flag-update`, which is the only thing that ever
// moves a flag between home / carried / dropped.
//
// No new art: a stand, a pole, a finial and a 16x8 plane for the cloth, waved in
// the vertex shader so the wave costs nothing on the CPU.
import * as THREE from "three";
import { GAME_CONFIG } from "../config/game-config.js";
import { FLAG_HOMES } from "../../shared/map-actors.js";
import { makeLight } from "../scene/lights.js";

// Defaults live here as well as in game-config.js so this module renders
// correctly even if GAME_CONFIG.CTF has not landed yet. The config wins.
const DEFAULTS = {
  RADIUS: 7.01, // x world scale — client-side touch reach; the server's is larger (RADIUS + slack)
  CLAIM_INTERVAL: 400, // ms between requests, so we do not shout at the server
  RED: "#ff3a22",
  BLUE: "#2f86ff",
  RED_GLOW: "#ff6b56",
  BLUE_GLOW: "#7cb6ff",
  POLE_HEIGHT: 2.4,
  CLOTH_W: 1.1,
  CLOTH_H: 0.7,
  WAVE_SPEED: 4.5,
  WAVE_AMP: 0.09,
  CARRY_OFFSET: { x: 0, y: 1.15, z: 0.32 },
  CARRY_TILT_DEG: -35,
  DROP_TILT_DEG: 12,
};

const CFG = { ...DEFAULTS, ...(GAME_CONFIG.CTF || {}) };
const BOB = GAME_CONFIG.PICKUP;

// Prop dimensions below (pole, finial, cloth, stand disc) are sized against the PLAYER
// who carries the flag, not against the map, so none of them moved with the x2.33552
// world scale. The two things here that did are the touch RADIUS above and the glow
// light's `distance` below — both are reaches measured across map geometry.
const POLE_RADIUS = 0.035;
export const TEAMS = ["red", "blue"];

const teamColor = (team) => (team === "red" ? CFG.RED : CFG.BLUE);
const teamGlow = (team) => (team === "red" ? CFG.RED_GLOW : CFG.BLUE_GLOW);

/**
 * The client-side touch predicate, as a pure function.
 *
 * It is a FILTER, not a decision: it stops us asking for things that could never be
 * granted (touching a flag someone is already carrying, standing on our own flag with
 * nothing to capture). The server re-checks all of it, plus distance, plus whether we
 * are even alive.
 */
export function flagTouchIsMeaningful(myTeam, carrying, team, state) {
  if (!myTeam) return false;
  if (state === "carried") return false;
  if (team !== myTeam) {
    // Enemy flag: worth taking unless we already have one.
    return !carrying;
  }
  // Own flag: dropped means return it; home means capture, if we are holding
  // theirs. Standing on our own flag empty-handed is not an event.
  if (state === "dropped") return true;
  return state === "home" && !!carrying;
}

/**
 * The cloth wave. Both flags share one compiled program (see
 * customProgramCacheKey below) — the team colour is a uniform, not a define, so
 * there is no reason for two.
 *
 * `edge` is 0 at the pole and 1 at the free edge, so the cloth stays pinned to
 * the pole and flaps at the far side, which is what a flag actually does.
 * Normals are deliberately NOT recomputed: at this size the emissive carries the
 * read, and recomputing them would put the vertex work back on the CPU.
 */
function makeClothMaterial(team, uTime) {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(teamColor(team)),
    emissive: new THREE.Color(teamColor(team)).multiplyScalar(0.35),
    roughness: 0.9,
    metalness: 0.0,
    side: THREE.DoubleSide,
    vertexColors: true, // carries the darker horizontal band, see makeClothGeometry()
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader =
      "uniform float uTime;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         float edge = (position.x + ${(CFG.CLOTH_W / 2).toFixed(3)}) / ${CFG.CLOTH_W.toFixed(3)};
         float w = sin(position.x * 5.5 - uTime * ${CFG.WAVE_SPEED.toFixed(2)}) * ${CFG.WAVE_AMP.toFixed(3)} * edge
                 + sin(position.y * 9.0 + uTime * 3.1) * 0.03 * edge;
         transformed.z += w;`
      );
  };
  mat.customProgramCacheKey = () => "ctf-cloth";
  return mat;
}

/**
 * The cloth geometry, with a darker horizontal band written into vertex colours.
 * UT99's flag is a texture; this is the cheapest honest stand-in — it breaks the
 * flat colour without a second draw call, a second plane to z-fight, or any art.
 */
function makeClothGeometry() {
  const geo = new THREE.PlaneGeometry(CFG.CLOTH_W, CFG.CLOTH_H, 16, 8);
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const y = geo.attributes.position.array;
  for (let i = 0; i < count; i++) {
    // Rows run top (+h/2) to bottom (-h/2); darken the middle one and feather it.
    const t = Math.abs(y[i * 3 + 1]) / (CFG.CLOTH_H / 2); // 0 at the middle row
    const shade = t < 0.13 ? 0.55 : t < 0.38 ? 0.55 + (t - 0.13) * 1.8 : 1.0;
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = Math.min(1, shade);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geo;
}

// ---------------------------------------------------------------------------
// Item: one flag's visual and its three states.
// ---------------------------------------------------------------------------

export class FlagItem {
  constructor(game, node, opts = {}) {
    this.game = game;
    this.node = node;
    this.sys = opts.system || null;
    this.team = opts.team || "red";
    this.state = opts.state || "home";
    this.carrier = opts.carrier || "";

    this.uTime = { value: 0 };
    this.phase = Math.random() * Math.PI * 2;
    this.baseY = node.position.y;
    // The server's own idea of where this flag is. The NODE bobs when the flag is
    // dropped and rides the carrier when it is held; the sweep below must measure
    // against the authoritative point, which is what the old system kept in its
    // per-flag `pos` and is what the server will re-check the touch against.
    this.pos = node.position.clone();

    this._carrierId = null;
    this._carrierNode = null;
    this._carrierPos = new THREE.Vector3();
    this._carrierQuat = new THREE.Quaternion();
    this._euler = new THREE.Euler(0, 0, 0, "YXZ");
    this._offset = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._disposables = [];

    // Yaw first, then the lean, so a carried flag tips over the carrier's own
    // shoulder rather than over a world axis.
    node.rotation.order = "YXZ";

    this.buildVisual();
    this.applyState();
  }

  buildVisual() {
    const team = this.team;
    const group = new THREE.Group();

    // Pole. Origin at its base so the whole flag leans from the ground.
    const poleGeo = new THREE.CylinderGeometry(POLE_RADIUS, POLE_RADIUS, CFG.POLE_HEIGHT, 10);
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0xcfd3da,
      metalness: 0.9,
      roughness: 0.35,
    });
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.y = CFG.POLE_HEIGHT / 2;
    group.add(pole);

    // Finial.
    const finGeo = new THREE.SphereGeometry(0.07, 10, 8);
    const finMat = new THREE.MeshStandardMaterial({
      color: 0xd8b25a,
      metalness: 0.8,
      roughness: 0.3,
    });
    const finial = new THREE.Mesh(finGeo, finMat);
    finial.position.y = CFG.POLE_HEIGHT;
    group.add(finial);

    // Cloth, hung from the top of the pole on the +x side. The geometry stays
    // centred on its own origin because the wave shader reads position.x in that
    // space; the mesh is offset instead.
    const clothGeo = makeClothGeometry();
    const clothMat = makeClothMaterial(team, this.uTime);
    const cloth = new THREE.Mesh(clothGeo, clothMat);
    cloth.position.set(CFG.CLOTH_W / 2 + POLE_RADIUS, CFG.POLE_HEIGHT - 0.05 - CFG.CLOTH_H / 2, 0);
    group.add(cloth);

    this.node.add(group);
    this.node.userData.mesh = group;
    this.group = group;
    this._disposables.push(poleGeo, poleMat, finGeo, finMat, clothGeo, clothMat);

    // A real light rather than a glowing shell: the scene is bloom-composited,
    // so this bleeds into the bloom pass and reads as a glow for free — the same
    // trick weapon-pickup.js uses for the pedestals.
    //
    // The light lives on the FLAG, not on the stand, and it never toggles. Two
    // reasons: a dropped flag out on the bridge is only findable because it
    // glows, and three.js recompiles every material in the scene when the number
    // of visible lights changes — so a light that switched off when the flag left
    // home would cost a hitch on every take and every return.
    this.glow = makeLight({
      type: "point",
      color: teamGlow(team),
      // x world scale, both of them: `distance` is a reach across the map (8 -> 18.68) and
      // A-Frame's light component defaulted decay to 1 — which is what scene/lights.js'
      // makeLight keeps — so illumination falls off as 1/d and holding the lit result
      // steady needs intensity x k too (2.2 -> 5.14).
      intensity: 5.14,
      distance: 18.68,
      castShadow: false,
      position: [0, CFG.POLE_HEIGHT * 0.75, 0],
    });
    this.node.add(this.glow);
  }

  /** What A-Frame's `update(oldData)` did when the system rewrote the attribute. */
  setData({ team, state, carrier }) {
    if (team !== undefined) this.team = team;
    if (carrier !== undefined && (carrier || "") !== this.carrier) {
      this.carrier = carrier || "";
      this._carrierId = null;
      this._carrierNode = null;
    }
    if (state !== undefined) this.state = state;
    if (this.group) this.applyState();
  }

  applyState() {
    const node = this.node;
    const state = this.state;
    const mine = !!this.carrier && this.carrier === (this.sys ? this.sys.localId() : null);

    // The local player is invisible to themselves (invisible-to-player), so a
    // carried flag would be a pole hanging in mid-air in front of the camera.
    // The HUD says YOU HAVE THE FLAG instead.
    //
    // Hide the MESH only, never the node: the glow light is a child of this node,
    // and hiding the node would take the light out of the render list — which is
    // exactly the light-count change three.js answers with a full material
    // recompile, on every take and every drop. Toggling group.visible touches
    // nothing but what is drawn.
    if (this.group) this.group.visible = !(state === "carried" && mine);

    if (state === "home") {
      // Fully upright and square to the world — a returned flag must look
      // identical to one that never left, however the carrier was facing.
      node.rotation.set(0, 0, 0);
      this.baseY = node.position.y;
    } else if (state === "dropped") {
      // Keep the yaw the carrier died with; it just falls over.
      node.rotation.x = THREE.MathUtils.degToRad(CFG.DROP_TILT_DEG);
      node.rotation.z = 0;
      this.baseY = node.position.y;
    }
    // carried: update() writes the whole transform every frame.
  }

  /** The rig the flag rides on, resolved lazily — a remote avatar may arrive late. */
  carrierRig() {
    const id = this.carrier;
    if (!id || !this.sys) return null;
    if (this._carrierId === id && this._carrierNode && this._carrierNode.parent) {
      return this._carrierNode;
    }
    const node = id === this.sys.localId() ? this.game.rig : this.sys.remoteNode(id);
    if (!node) return null;
    this._carrierId = id;
    this._carrierNode = node;
    return node;
  }

  update(dt, now) {
    const node = this.node;

    // The wave. One uniform write; the GPU does the rest.
    this.uTime.value = now / 1000;

    if (this.state === "carried") {
      const rig = this.carrierRig();
      if (rig) {
        rig.getWorldPosition(this._carrierPos);
        rig.getWorldQuaternion(this._carrierQuat);
        this._euler.setFromQuaternion(this._carrierQuat);
        const yaw = this._euler.y;

        const off = CFG.CARRY_OFFSET;
        this._offset.set(off.x, off.y, off.z).applyAxisAngle(this._up, yaw);
        node.position.copy(this._carrierPos).add(this._offset);
        node.rotation.y = yaw;
        // CARRY_TILT_DEG is signed the UT way (negative = leaning back). A
        // positive rotation about x tips the pole toward +z, which — with the
        // yaw applied first — is behind the carrier.
        node.rotation.x = THREE.MathUtils.degToRad(-CFG.CARRY_TILT_DEG);
        node.rotation.z = 0;
      }
    } else if (this.state === "dropped") {
      // A dropped flag is not inert scenery; a small bob is what makes it read
      // as "come and get this" from across the bridge.
      this.phase += BOB.BOB_SPEED * 0.6 * dt;
      node.position.y = this.baseY + Math.sin(this.phase) * BOB.BOB_HEIGHT * 0.5;
    }
  }

  dispose() {
    this.node.removeFromParent();
    for (const d of this._disposables) {
      if (d && typeof d.dispose === "function") d.dispose();
    }
    this._disposables.length = 0;
    this.group = null;
    this.glow = null;
  }
}

// ---------------------------------------------------------------------------
// Stand: the lit disc each flag lives on. It was two <a-entity ctf-flag-stand>
// nodes in the A-Frame markup; the system builds both now, and they are always visible —
// in UT99 the base stays lit whether or not the flag is on it, and it is how you
// find the thing from across the bridge.
//
// The markup carried deliberately NO position attribute, and this does not take one
// either: the stand places itself from FLAG_HOMES in src/shared/map-actors.js — the
// generated table the server reads its own copy of — so the two points exist once, in
// the level data, rather than being typed out in a scene description and drifting from
// the server the first time anyone moves them. A stand a metre from the flag it is
// supposed to be under is the exact bug this removes.
//
// The FLAGS themselves are not built here either. The server owns them (state,
// position, carrier), so CtfFlags below spawns one node per flag from the `ctf-init`
// payload and rebuilds both wholesale on reconnect and on match reset. Building them
// with the stands would mean a flag standing here before the server had said so.
//
// GROUND-LEVEL. The stands were on the tower roofs until the placements were rebuilt
// from CTF-Face's own actor table; they are on the plinth at each tower's FOOT now,
// which is where FlagBase0/FlagBase1 actually sit. Nothing about the disc itself had to
// change for that — it is a flat base and a ring, and it lies on whatever surface it is
// put on. (In the original the roofs are sniper decks and the flags stand at ground
// level.)
// ---------------------------------------------------------------------------

export class FlagStand {
  constructor(game, node, opts = {}) {
    this.game = game;
    this.node = node;
    this.team = opts.team || "red";
    this._disposables = [];

    const home = FLAG_HOMES[this.team];
    if (home) node.position.set(home.x, home.y, home.z);
    else console.warn(`[ctf-flag-stand] no flag home for team "${this.team}"`);

    const group = new THREE.Group();

    const baseGeo = new THREE.CylinderGeometry(0.75, 0.85, 0.14, 24);
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x3a3f4a,
      metalness: 0.6,
      roughness: 0.5,
    });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.y = 0.07;
    group.add(base);

    // Unlit so bloom lifts it: this is the ring you see from the other tower.
    const ringGeo = new THREE.RingGeometry(0.55, 0.72, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(teamColor(this.team)),
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.145;
    group.add(ring);

    node.add(group);
    node.userData.mesh = group;
    this.group = group;
    this._disposables.push(baseGeo, baseMat, ringGeo, ringMat);

    // Deliberately no light here. The plan put one on the stand, but the flag
    // carries its own (see FlagItem.buildVisual) and two overlapping point
    // lights at the same spot buy nothing while costing a light slot in every
    // material in the scene. The ring is MeshBasic with toneMapped false, so
    // bloom lifts it on its own — an empty base still reads as an empty base
    // from the opposite tower.
  }

  dispose() {
    this.node.removeFromParent();
    for (const d of this._disposables) {
      if (d && typeof d.dispose === "function") d.dispose();
    }
    this._disposables.length = 0;
    this.group = null;
  }
}

// ---------------------------------------------------------------------------
// System: owns the pair of flags, the two stands, and one proximity sweep.
// ---------------------------------------------------------------------------

export class CtfFlags {
  constructor(game) {
    this.game = game;
    this.flags = new Map(); // team -> FlagItem
    this.stands = new Map(); // team -> FlagStand
    this.myTeam = null;
    this.myId = null;
    this.carrying = null; // the team COLOUR of the flag I am carrying, or null
    this.lastClaim = 0;
    this._rigPos = new THREE.Vector3();

    // The stands are static scenery and go up once, with or without a server.
    for (const team of TEAMS) {
      const node = new THREE.Group();
      node.name = `flag-stand-${team}`;
      game.world.add(node);
      const stand = new FlagStand(game, node, { team });
      game.attach(node, "ctf-flag-stand", stand);
      this.stands.set(team, stand);
    }

    this._off = [
      // `player-join` with isLocal is the first message that carries our id; the
      // rig's own record is the fallback for anyone who joins after us.
      game.events.on("player-join", (e) => {
        if (e.detail && e.detail.isLocal) this.myId = e.detail.id;
      }),
      game.events.on("local-team", (e) => {
        const team = (e.detail && e.detail.team) || null;
        this.myTeam = team;
        // No team means no match: network.js clears it on disconnect. The flags standing
        // in the world are a snapshot of a game we are no longer in — and their carriers
        // are remote rigs that clearRemotes() has just deleted — so take them down. The
        // next `hello` sends `ctf-init`, which rebuilds both from scratch. The STANDS
        // stay: they are the map, not the match.
        if (!team) this.clearFlags();
      }),
      // Wholesale replace, exactly like pickups-init: after a reconnect or a match
      // reset the teams are the same but the states are not.
      game.events.on("ctf-init", (e) => this.reset(e.detail)),
      game.events.on("flag-update", (e) => this.apply(e.detail)),
    ];
  }

  localId() {
    if (this.myId) return this.myId;
    // What `#rig`'s dataset.playerId was. Task 13's network.js writes the id here the
    // moment `hello` lands, which is before the first `player-join` reaches us.
    const rig = this.game.rig;
    this.myId = (rig && rig.userData && rig.userData.playerId) || null;
    return this.myId;
  }

  /**
   * The scene node a remote player's flag rides on. Task 12 owns the avatars and Task
   * 13 hands them to network.js, so this asks the registry rather than reaching into
   * either — the flag only ever needs an Object3D to read a world pose off.
   *
   * `.rig` and not `.body`: the rig is the node the wire pose is written onto — what
   * `#remote-rig-<id>` was — while the body is its ground-corrected child, which
   * would slide the flag down by the avatar's floor offset.
   */
  remoteNode(id) {
    const avatar = this.game.systems.get("remote-avatars")?.get(id);
    return avatar ? avatar.rig : null;
  }

  /** Take both flags out of the scene. Shared by `ctf-init` and by losing our team. */
  clearFlags() {
    for (const item of this.flags.values()) item.dispose();
    this.flags.clear();
    this.carrying = null;
  }

  reset(detail) {
    if (!detail) return;
    if (detail.myTeam !== undefined) this.myTeam = detail.myTeam || null;

    this.clearFlags();

    const list = Array.isArray(detail.flags) ? detail.flags : [];
    for (const f of list) this.spawn(f);
  }

  spawn(f) {
    if (!f || !f.team) return null;
    const node = new THREE.Group();
    node.name = `flag-${f.team}`;
    node.position.set(f.x, f.y, f.z);
    this.game.world.add(node);

    const item = new FlagItem(this.game, node, {
      system: this,
      team: f.team,
      state: f.state || "home",
      carrier: f.carrier || "",
    });
    this.game.attach(node, "ctf-flag-item", item);
    this.flags.set(f.team, item);
    if (f.carrier && f.carrier === this.localId()) this.carrying = f.team;
    return item;
  }

  /** The only path that changes a flag. Everything here came from the server. */
  apply(d) {
    if (!d || !d.team) return;
    if (d.myTeam !== undefined) this.myTeam = d.myTeam || null;

    const item = this.flags.get(d.team);
    if (!item) return;

    // Home and dropped positions are authoritative; a carried flag's position is
    // read off the carrier's rig every frame instead, so we ignore the snapshot.
    if (d.state !== "carried") {
      item.node.position.set(d.x, d.y, d.z);
      item.pos.set(d.x, d.y, d.z);
    }

    if (d.isMine) this.carrying = d.team;
    else if (this.carrying === d.team) this.carrying = null;

    item.setData({ team: d.team, state: d.state, carrier: d.carrier || "" });
  }

  /**
   * One sweep per frame for both flags, run by the system itself. It used to be
   * driven by whichever flag item happened to init first, which meant the sweep
   * stopped the moment that one item was removed — and `ctf-init` removes every
   * item wholesale on each reconnect and match reset. A system update cannot be
   * orphaned that way, and it keeps running while there are no items at all.
   */
  update(dt, now) {
    for (const item of this.flags.values()) item.update(dt, now);

    if (!this.flags.size || !this.myTeam) return;
    // The player controller registers after the world is built, so the rig is null for
    // the first frames of a page load — and stays null on a page with no player at all.
    if (!this.game.rig) return;
    if (now - this.lastClaim < CFG.CLAIM_INTERVAL) return;

    this.game.rig.getWorldPosition(this._rigPos);
    for (const [team, item] of this.flags) {
      // Positional, not an options object: this runs for every flag on every frame
      // that passes the CLAIM_INTERVAL gate, and a literal there is an allocation.
      if (!flagTouchIsMeaningful(this.myTeam, this.carrying, team, item.state)) continue;
      if (this._rigPos.distanceTo(item.pos) > CFG.RADIUS) continue;

      this.lastClaim = now;
      this.game.events.emit("request-flag-touch", { team });
      return;
    }
  }

  dispose() {
    for (const off of this._off) off();
    this._off.length = 0;
    this.clearFlags();
    for (const stand of this.stands.values()) stand.dispose();
    this.stands.clear();
  }
}
