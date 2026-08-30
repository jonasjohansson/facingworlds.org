// ctf-flag.js — the two team flags, built from primitives.
//
// Same split as weapon-pickup.js, for the same reason: the SERVER owns flag
// state (who has it, where it fell, whether a touch counts as a take, a return
// or a capture). This file renders that state and asks. If the client decided,
// two players reaching a dropped flag on the same frame would both run off with
// it, and a capture would be whatever the fastest machine claimed.
//
// The flow is: `ctf-init` (from `hello`, and again after `match-reset`) rebuilds
// both flags wholesale -> the system's own per-frame proximity sweep emits
// `request-flag-touch` when the local player stands on one -> the server answers with a `flag` broadcast,
// relayed here as `flag-update`, which is the only thing that ever moves a flag
// between home / carried / dropped.
//
// No new art: a stand, a pole, a finial and a 16x8 plane for the cloth, waved in
// the vertex shader so the wave costs nothing on the CPU.

import { GAME_CONFIG } from "../config/game-config.js";

// Defaults live here as well as in game-config.js so this module renders
// correctly even if GAME_CONFIG.CTF has not landed yet. The config wins.
const DEFAULTS = {
  RADIUS: 2.0, // client-side touch reach; the server's is larger (RADIUS + slack)
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

const POLE_RADIUS = 0.035;
const TEAMS = ["red", "blue"];

const teamColor = (team) => (team === "red" ? CFG.RED : CFG.BLUE);
const teamGlow = (team) => (team === "red" ? CFG.RED_GLOW : CFG.BLUE_GLOW);

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
    vertexColors: true, // carries the darker horizontal band, see makeCloth()
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
// System: owns the pair of flags and the one proximity sweep per frame.
// ---------------------------------------------------------------------------

AFRAME.registerSystem("ctf-flag", {
  init() {
    this.flags = new Map(); // team -> { el, state, carrier, pos }
    this.myTeam = null;
    this.myId = null;
    this.carrying = null; // the team COLOUR of the flag I am carrying, or null
    this.lastClaim = 0;
    this.rigEl = null;
    this._rigPos = new THREE.Vector3();

    const scene = this.el;

    // `player-join` with isLocal is the first message that carries our id; the
    // rig's dataset is the fallback for anyone who joins after us.
    scene.addEventListener("player-join", (e) => {
      if (e.detail && e.detail.isLocal) this.myId = e.detail.id;
    });
    scene.addEventListener("local-team", (e) => {
      const team = (e.detail && e.detail.team) || null;
      this.myTeam = team;
      // No team means no match: network.js clears it on disconnect. The flags standing
      // in the world are a snapshot of a game we are no longer in — and their carriers
      // are remote rigs that clearRemotes() has just deleted — so take them down. The
      // next `hello` sends `ctf-init`, which rebuilds both from scratch.
      if (!team) this.clearFlags();
    });
    // Wholesale replace, exactly like pickups-init: after a reconnect or a match
    // reset the teams are the same but the states are not.
    scene.addEventListener("ctf-init", (e) => this.reset(e.detail));
    scene.addEventListener("flag-update", (e) => this.apply(e.detail));
  },

  localId() {
    if (this.myId) return this.myId;
    const rig = document.querySelector("#rig");
    this.myId = (rig && rig.dataset.playerId) || null;
    return this.myId;
  },

  /** Take both flags out of the scene. Shared by `ctf-init` and by losing our team. */
  clearFlags() {
    for (const item of this.flags.values()) {
      if (item.el && item.el.parentNode) item.el.parentNode.removeChild(item.el);
    }
    this.flags.clear();
    this.carrying = null;
  },

  reset(detail) {
    if (!detail) return;
    if (detail.myTeam !== undefined) this.myTeam = detail.myTeam || null;

    this.clearFlags();

    const list = Array.isArray(detail.flags) ? detail.flags : [];
    for (const f of list) this.spawn(f);
  },

  spawn(f) {
    if (!f || !f.team) return;
    const el = document.createElement("a-entity");
    el.setAttribute("position", `${f.x} ${f.y} ${f.z}`);
    el.setAttribute("ctf-flag-item", {
      team: f.team,
      state: f.state || "home",
      carrier: f.carrier || "",
    });
    this.el.appendChild(el);
    this.flags.set(f.team, {
      el,
      state: f.state || "home",
      carrier: f.carrier || null,
      pos: new THREE.Vector3(f.x, f.y, f.z),
    });
    if (f.carrier && f.carrier === this.localId()) this.carrying = f.team;
  },

  /** The only path that changes a flag. Everything here came from the server. */
  apply(d) {
    if (!d || !d.team) return;
    if (d.myTeam !== undefined) this.myTeam = d.myTeam || null;

    const item = this.flags.get(d.team);
    if (!item) return;

    item.state = d.state;
    item.carrier = d.carrier || null;

    // Home and dropped positions are authoritative; a carried flag's position is
    // read off the carrier's rig every frame instead, so we ignore the snapshot.
    if (d.state !== "carried") {
      item.pos.set(d.x, d.y, d.z);
      item.el.setAttribute("position", `${d.x} ${d.y} ${d.z}`);
    }

    if (d.isMine) this.carrying = d.team;
    else if (this.carrying === d.team) this.carrying = null;

    item.el.setAttribute("ctf-flag-item", {
      team: d.team,
      state: d.state,
      carrier: d.carrier || "",
    });
  },

  /**
   * One sweep per frame for both flags, run by the system itself. It used to be
   * driven by whichever flag item happened to init first, which meant the sweep
   * stopped the moment that one item was removed — and `ctf-init` removes every
   * item wholesale on each reconnect and match reset. A system tick cannot be
   * orphaned that way, and it keeps running while there are no items at all.
   */
  tick(time) {
    if (!this.flags.size || !this.myTeam) return;
    // Resolved lazily and re-resolved if the rig is ever swapped out.
    if (!this.rigEl || !this.rigEl.isConnected) this.rigEl = document.querySelector("#rig");
    this.checkLocalPlayer(this.rigEl, time);
  },

  /**
   * The client-side predicate is a filter, not a decision: it stops us asking
   * for things that could never be granted (touching a flag someone is already
   * carrying, standing on our own flag with nothing to capture). The server
   * re-checks all of it, plus distance, plus whether we are even alive.
   */
  checkLocalPlayer(rigEl, time) {
    if (!rigEl || time - this.lastClaim < CFG.CLAIM_INTERVAL) return;

    rigEl.object3D.getWorldPosition(this._rigPos);
    for (const [team, item] of this.flags) {
      if (item.state === "carried") continue;
      if (!this.meaningful(team, item)) continue;
      if (this._rigPos.distanceTo(item.pos) > CFG.RADIUS) continue;

      this.lastClaim = time;
      this.el.emit("request-flag-touch", { team });
      return;
    }
  },

  meaningful(team, item) {
    if (!this.myTeam) return false;
    if (team !== this.myTeam) {
      // Enemy flag: worth taking unless we already have one.
      return !this.carrying;
    }
    // Own flag: dropped means return it; home means capture, if we are holding
    // theirs. Standing on our own flag empty-handed is not an event.
    if (item.state === "dropped") return true;
    return item.state === "home" && !!this.carrying;
  },
});

// ---------------------------------------------------------------------------
// Item: one flag's visual and its three states.
// ---------------------------------------------------------------------------

AFRAME.registerComponent("ctf-flag-item", {
  schema: {
    team: { type: "string", default: "red" },
    state: { type: "string", default: "home" },
    carrier: { type: "string", default: "" },
  },

  init() {
    this.uTime = { value: 0 };
    this.phase = Math.random() * Math.PI * 2;
    this.baseY = this.el.object3D.position.y;
    this.sys = this.el.sceneEl.systems["ctf-flag"];

    this._carrierId = null;
    this._carrierEl = null;
    this._carrierPos = new THREE.Vector3();
    this._carrierQuat = new THREE.Quaternion();
    this._euler = new THREE.Euler(0, 0, 0, "YXZ");
    this._offset = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._disposables = [];

    // Yaw first, then the lean, so a carried flag tips over the carrier's own
    // shoulder rather than over a world axis.
    this.el.object3D.rotation.order = "YXZ";

    this.buildVisual();
    this.applyState();
  },

  buildVisual() {
    const team = this.data.team;
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

    this.el.setObject3D("flag", group);
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
    const glow = document.createElement("a-entity");
    glow.setAttribute("position", `0 ${(CFG.POLE_HEIGHT * 0.75).toFixed(2)} 0`);
    glow.setAttribute("light", {
      type: "point",
      color: teamGlow(team),
      intensity: 2.2,
      distance: 8,
      castShadow: false,
    });
    this.el.appendChild(glow);
    this.glow = glow;
  },

  update(oldData) {
    if (oldData && oldData.carrier !== this.data.carrier) {
      this._carrierId = null;
      this._carrierEl = null;
    }
    if (this.group) this.applyState();
  },

  applyState() {
    const obj = this.el.object3D;
    const state = this.data.state;
    const mine = !!this.data.carrier && this.data.carrier === this.sys.localId();

    // The local player is invisible to themselves (invisible-to-player), so a
    // carried flag would be a pole hanging in mid-air in front of the camera.
    // The HUD says YOU HAVE THE FLAG instead.
    //
    // Hide the MESH only, never the entity: the glow light is a child of this
    // entity, and hiding the entity would take the light out of the scene —
    // which is exactly the light-count change three.js answers with a full
    // material recompile, on every take and every drop. Toggling
    // group.visible touches nothing but the render list.
    const mesh = this.el.getObject3D("flag");
    if (mesh) mesh.visible = !(state === "carried" && mine);

    if (state === "home") {
      // Fully upright and square to the world — a returned flag must look
      // identical to one that never left, however the carrier was facing.
      obj.rotation.set(0, 0, 0);
      this.baseY = obj.position.y;
    } else if (state === "dropped") {
      // Keep the yaw the carrier died with; it just falls over.
      obj.rotation.x = THREE.MathUtils.degToRad(CFG.DROP_TILT_DEG);
      obj.rotation.z = 0;
      this.baseY = obj.position.y;
    }
    // carried: tick() writes the whole transform every frame.
  },

  /** The rig the flag rides on, resolved lazily — a remote rig may arrive late. */
  carrierRig() {
    const id = this.data.carrier;
    if (!id) return null;
    if (this._carrierId === id && this._carrierEl && this._carrierEl.isConnected) {
      return this._carrierEl;
    }
    const el =
      id === this.sys.localId()
        ? document.querySelector("#rig")
        : document.getElementById(`remote-rig-${id}`);
    if (!el) return null;
    this._carrierId = id;
    this._carrierEl = el;
    return el;
  },

  tick(time, dtMs) {
    const dt = dtMs / 1000;
    const obj = this.el.object3D;

    // The wave. One uniform write; the GPU does the rest.
    this.uTime.value = time / 1000;

    if (this.data.state === "carried") {
      const rig = this.carrierRig();
      if (rig) {
        rig.object3D.getWorldPosition(this._carrierPos);
        rig.object3D.getWorldQuaternion(this._carrierQuat);
        this._euler.setFromQuaternion(this._carrierQuat);
        const yaw = this._euler.y;

        const off = CFG.CARRY_OFFSET;
        this._offset.set(off.x, off.y, off.z).applyAxisAngle(this._up, yaw);
        obj.position.copy(this._carrierPos).add(this._offset);
        obj.rotation.y = yaw;
        // CARRY_TILT_DEG is signed the UT way (negative = leaning back). A
        // positive rotation about x tips the pole toward +z, which — with the
        // yaw applied first — is behind the carrier.
        obj.rotation.x = THREE.MathUtils.degToRad(-CFG.CARRY_TILT_DEG);
        obj.rotation.z = 0;
      }
    } else if (this.data.state === "dropped") {
      // A dropped flag is not inert scenery; a small bob is what makes it read
      // as "come and get this" from across the bridge.
      this.phase += BOB.BOB_SPEED * 0.6 * dt;
      obj.position.y = this.baseY + Math.sin(this.phase) * BOB.BOB_HEIGHT * 0.5;
    }
  },

  remove() {
    this.el.removeObject3D("flag");
    for (const d of this._disposables) {
      if (d && typeof d.dispose === "function") d.dispose();
    }
    this._disposables.length = 0;
    if (this.glow && this.glow.parentNode) this.glow.parentNode.removeChild(this.glow);
  },
});

// ---------------------------------------------------------------------------
// Stand: the lit disc each flag lives on. Static in index.html, and always
// visible — in UT99 the base stays lit whether or not the flag is on it, and it
// is how you find the thing from the far tower.
// ---------------------------------------------------------------------------

AFRAME.registerComponent("ctf-flag-stand", {
  schema: {
    team: { type: "string", default: "red" },
  },

  init() {
    const team = this.data.team;
    const group = new THREE.Group();
    this._disposables = [];

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
      color: new THREE.Color(teamColor(team)),
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.145;
    group.add(ring);

    this.el.setObject3D("stand", group);
    this._disposables.push(baseGeo, baseMat, ringGeo, ringMat);

    // Deliberately no light here. The plan put one on the stand, but the flag
    // carries its own (see ctf-flag-item.buildVisual) and two overlapping point
    // lights at the same spot buy nothing while costing a light slot in every
    // material in the scene. The ring is MeshBasic with toneMapped false, so
    // bloom lifts it on its own — an empty base still reads as an empty base
    // from the opposite tower.
  },

  remove() {
    this.el.removeObject3D("stand");
    for (const d of this._disposables) {
      if (d && typeof d.dispose === "function") d.dispose();
    }
    this._disposables.length = 0;
  },
});
