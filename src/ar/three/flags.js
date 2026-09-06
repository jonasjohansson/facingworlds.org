import * as THREE from "three";
import { AR_CONFIG } from "../config/ar-config.js";

// The two team flags, on the AR table.
//
// A spectator view of Capture the Flag that does not show the flags is a view of
// people running around. This is the other half of the match: where each flag is,
// and therefore what everyone on the rock is doing.
//
// SAME PRIMITIVES AS THE GAME, deliberately rebuilt rather than imported. The
// game's flag (src/game/systems/ctf-flag.js) is a plain three.js system class,
// but one wired to the game's registry, config and network messages, so the
// construction - stand disc and ring, pole, finial, and a 16x8 plane waved in
// the vertex shader by an onBeforeCompile injection - is repeated here in plain
// three. The numbers come from AR_CONFIG.ctf, which
// carries the same proportions.
//
// COORDINATES. Flag positions arrive in game world coordinates, exactly like
// player poses, so they go into exactly the same node: `world`, the one carrying
// the map's measured fit scale and centring offset. Nothing is transformed on the
// way in. See src/ar/three/players.js and scene.js for why that node IS game world
// space.
//
// SIZE is a separate question from position. A life-sized flag on a rock fitted to
// 3.2 marker units is invisible, so the props hang under a scale node set to
// AR_CONFIG.ctf.scale - the same inflation the figures get - while the position
// stays raw. A flag therefore stands exactly where the server says it does, at a
// size you can see.
//
// THE THREE STATES, and where the flag lives in each:
//
//   home     -> parented to `world`, at the stand, upright.
//   dropped  -> parented to `world`, where the carrier fell, tipped over, bobbing.
//   carried  -> parented to the CARRIER'S OWN FIGURE (table.carrierNode(id)), so it
//               rides their interpolated pose for free. No per-frame copying of a
//               position that is already being computed one node away, and no
//               chance of the flag lagging a frame behind the soldier holding it.
//               That node is inside the avatar scale, so the flag's own scale node
//               drops to 1 while carried.
//
// NO POINT LIGHT. The game's flag carries one because a flag dropped out on the
// bridge has to be findable from the opposite tower; here the entire map is in
// frame at once. And three.js recompiles every material in the scene when the
// visible light count changes, which would be a hitch on every take and every
// return - on a phone already running camera capture and image tracking. The cloth
// is emissive instead, which costs nothing.

const TEAMS = ["red", "blue"];

export class CtfFlags {
  /**
   * @param {THREE.Object3D} worldGroup node whose local space is game world space
   * @param {import("./players.js").SpectatorTable} table used to find a carrier's figure
   */
  constructor(worldGroup, table) {
    this.worldGroup = worldGroup;
    this.table = table;
    this.disposed = false;
    this.flags = new Map();

    const cfg = AR_CONFIG.ctf || {};
    this.cfg = cfg;
    this.enabled = cfg.enabled !== false;

    // One clock for both flags. They share a compiled program (see the cache key
    // in makeClothMaterial) and there is no reason for two phases either.
    this.uTime = { value: 0 };
    this.elapsed = 0;

    // Shared geometry, created once and disposed with this object. The two flags
    // differ only in colour, so nothing here is per-team.
    this.geometries = {
      pole: new THREE.CylinderGeometry(cfg.poleRadius, cfg.poleRadius, cfg.poleHeight, 8),
      finial: new THREE.SphereGeometry(cfg.poleRadius * 2, 8, 6),
      cloth: makeClothGeometry(cfg),
      standBase: new THREE.CylinderGeometry(0.75, 0.85, 0.14, 20),
      standRing: new THREE.RingGeometry(0.55, 0.72, 24),
    };
    this.geometries.pole.translate(0, cfg.poleHeight / 2, 0);

    // Shared metal, because a pole is a pole whichever side it belongs to.
    // Lambert for the same reason the figures are: at this size a full
    // metallic-roughness BRDF per pixel buys nothing legible.
    this.poleMaterial = new THREE.MeshLambertMaterial({ color: 0xcfd3da });
    this.finialMaterial = new THREE.MeshLambertMaterial({ color: 0xd8b25a, emissive: 0x3a2c0e });
    this.standMaterial = new THREE.MeshLambertMaterial({ color: 0x3a3f4a });

    this.materials = [this.poleMaterial, this.finialMaterial, this.standMaterial];

    if (this.enabled) {
      for (const team of TEAMS) {
        this._build(team);
      }
    }
  }

  // --- construction -------------------------------------------------------------

  _build(team) {
    const cfg = this.cfg;
    const color = new THREE.Color().setStyle(teamCss(team));

    // The stand. Always in the scene at the flag's home, always visible, exactly
    // like the game's: in UT99 the base stays lit whether or not the flag is on
    // it, and an EMPTY base is information - it means somebody has your flag.
    const stand = new THREE.Group();
    const base = new THREE.Mesh(this.geometries.standBase, this.standMaterial);
    base.position.y = 0.07;
    stand.add(base);

    // Unlit and untonemapped, so the ring stays the team colour under any
    // exposure. This is what you pick out from across the table.
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: color.clone(),
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const ring = new THREE.Mesh(this.geometries.standRing, ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.145;
    stand.add(ring);

    const standRoot = new THREE.Group();
    standRoot.scale.setScalar(cfg.scale);
    standRoot.add(stand);

    const standAnchor = new THREE.Group();
    standAnchor.add(standRoot);
    // Hidden until the server says where home is - which is one message away, in
    // the `hello` that opened the connection.
    standAnchor.visible = false;
    this.worldGroup.add(standAnchor);

    // The flag itself.
    const props = new THREE.Group();

    const pole = new THREE.Mesh(this.geometries.pole, this.poleMaterial);
    props.add(pole);

    const finial = new THREE.Mesh(this.geometries.finial, this.finialMaterial);
    finial.position.y = cfg.poleHeight;
    props.add(finial);

    const clothMaterial = makeClothMaterial(color, cfg, this.uTime);
    const cloth = new THREE.Mesh(this.geometries.cloth, clothMaterial);
    // The geometry stays centred on its own origin because the wave shader reads
    // position.x in that space; the MESH is what gets offset onto the pole.
    cloth.position.set(cfg.clothW / 2 + cfg.poleRadius, cfg.poleHeight - 0.05 - cfg.clothH / 2, 0);
    props.add(cloth);

    // Scale node. ctf.scale while the flag stands in the world; 1 while it is
    // parented to a carrier, because the carrier's figure already applies it.
    const scaleNode = new THREE.Group();
    scaleNode.scale.setScalar(cfg.scale);
    scaleNode.add(props);

    // Yaw, then lean, so a carried flag tips over its carrier's shoulder rather
    // than over a world axis - the same order the game's flag uses.
    const root = new THREE.Group();
    root.rotation.order = "YXZ";
    root.add(scaleNode);
    root.visible = false;
    this.worldGroup.add(root);

    this.materials.push(ringMaterial, clothMaterial);

    this.flags.set(team, {
      team,
      color,
      root,
      scaleNode,
      standAnchor,
      state: "home",
      carrier: null,
      // Where it was told to be, in game world coordinates. A carried flag ignores
      // this and rides its carrier instead.
      pos: new THREE.Vector3(),
      baseY: 0,
      phase: Math.random() * Math.PI * 2,
      // Set while carried and the carrier has no figure yet, so update() keeps
      // trying. A `flag` naming a carrier can beat that carrier's own `join`.
      pendingCarrier: null,
    });
  }

  // --- state --------------------------------------------------------------------

  /**
   * The only thing that ever moves a flag. Takes a publicFlag() straight off the
   * wire - from `hello.ctf.flags`, from a `flag` broadcast, or from the
   * `match-reset` that hands out a whole fresh match. One shape, one code path,
   * so a late message can never disagree with the state already on screen.
   *
   * @param {{team: string, state: string, x: number, y: number, z: number,
   *          carrier: string|null, returnInMs?: number, event?: string}} flag
   */
  apply(flag) {
    if (!flag || this.disposed) return;
    const item = this.flags.get(flag.team);
    if (!item) return;

    item.state = flag.state || "home";
    item.carrier = flag.state === "carried" ? flag.carrier || null : null;

    // Home is also where the stand goes. The server sends the home coordinates
    // every time the flag is there, so the disc is placed from the wire rather
    // than from a table this page would have to keep in sync with the server's.
    if (item.state === "home" && Number.isFinite(flag.x)) {
      item.standAnchor.position.set(flag.x, flag.y, flag.z);
      item.standAnchor.visible = true;
    }

    if (item.state === "carried") {
      item.pendingCarrier = item.carrier;
      this._attachToCarrier(item);
      return;
    }

    // home / dropped: back into world space, at the authoritative position.
    item.pendingCarrier = null;
    this._detachToWorld(item);

    if (Number.isFinite(flag.x)) {
      item.pos.set(flag.x, flag.y, flag.z);
    }
    item.root.position.copy(item.pos);
    item.baseY = item.pos.y;
    item.root.rotation.set(
      item.state === "dropped" ? THREE.MathUtils.degToRad(this.cfg.dropTiltDeg) : 0,
      0,
      0
    );
    item.root.visible = true;
  }

  /** Park the flag back in game world space, keeping its scale honest. */
  _detachToWorld(item) {
    if (item.root.parent !== this.worldGroup) {
      this.worldGroup.add(item.root);
    }
    item.scaleNode.scale.setScalar(this.cfg.scale);
  }

  /**
   * Ride the carrier's figure. Returns true once actually attached; a carrier
   * whose figure does not exist yet leaves the flag hidden and pending, and
   * update() retries every frame until the join lands.
   */
  _attachToCarrier(item) {
    const node = item.carrier && this.table ? this.table.carrierNode(item.carrier) : null;
    if (!node) {
      // Do not leave it standing in the middle of the map looking like a flag
      // anyone could take. It is on somebody's back; we just cannot draw that yet.
      item.root.visible = false;
      return false;
    }

    if (item.root.parent !== node) {
      node.add(item.root);
    }
    // Inside the figure's own scale now, so the flag must not apply it twice.
    item.scaleNode.scale.setScalar(1);
    item.root.position.set(0, 0, 0);
    // CARRY_TILT_DEG is signed the UT way (negative leans back). A positive
    // rotation about x tips the pole toward +z, which - the figure's yaw already
    // being applied by the node above - is behind the carrier.
    item.root.rotation.set(THREE.MathUtils.degToRad(-this.cfg.carryTiltDeg), 0, 0);
    item.root.visible = true;
    item.pendingCarrier = null;
    return true;
  }

  // --- per-frame ----------------------------------------------------------------

  /**
   * One uniform write for the wave, a sine for each dropped flag, and a retry for
   * any flag whose carrier had not been drawn yet. Everything else - a carried
   * flag following its carrier across the bridge - is the scene graph's job,
   * because the flag is parented to the figure that is already being moved.
   *
   * @param {number} deltaMs
   */
  update(deltaMs) {
    if (this.disposed || !this.enabled) return;

    this.elapsed += deltaMs / 1000;
    this.uTime.value = this.elapsed;

    for (const item of this.flags.values()) {
      if (item.state === "carried") {
        // Either the carrier's figure arrived late, or the figure this flag was
        // parented to has been torn down (a leaver). Both are one retry away.
        const node = item.carrier && this.table ? this.table.carrierNode(item.carrier) : null;
        if (item.pendingCarrier || (node && item.root.parent !== node) || !node) {
          this._attachToCarrier(item);
        }
      } else if (item.state === "dropped") {
        // A dropped flag is not scenery. The bob is what says "come and get this"
        // from across the table; it is in game units, so it rides the same scale
        // the props do or it would be under a millimetre on the print.
        item.phase += (this.cfg.bobSpeed || 2.2) * (deltaMs / 1000);
        item.root.position.y =
          item.baseY + Math.sin(item.phase) * (this.cfg.bobHeight || 0.18) * this.cfg.scale;
      }
    }
  }

  // --- teardown -----------------------------------------------------------------

  dispose() {
    this.disposed = true;
    for (const item of this.flags.values()) {
      item.root.removeFromParent();
      item.standAnchor.removeFromParent();
      item.root.clear();
      item.standAnchor.clear();
    }
    this.flags.clear();
    for (const geo of Object.values(this.geometries)) {
      geo.dispose();
    }
    for (const mat of this.materials) {
      mat.dispose();
    }
    this.materials.length = 0;
  }
}

const teamCss = (team) => {
  const colors = (AR_CONFIG.avatar && AR_CONFIG.avatar.teamColors) || {};
  return colors[team] || (team === "red" ? "rgb(239, 0, 0)" : "rgb(0, 120, 239)");
};

/**
 * The cloth wave, lifted from the game's flag: `edge` is 0 at the pole and 1 at
 * the free edge, so the cloth stays pinned and flaps at the far side, which is
 * what a flag actually does. Normals are deliberately NOT recomputed - at this
 * size the emissive carries the read, and recomputing them would put the work
 * back on the CPU, on a phone.
 *
 * Both flags share one compiled program: the team colour is a uniform, not a
 * define, so customProgramCacheKey collapses them to one.
 */
function makeClothMaterial(color, cfg, uTime) {
  const mat = new THREE.MeshLambertMaterial({
    color: color.clone(),
    emissive: color.clone().multiplyScalar(cfg.clothEmissive ?? 0.55),
    side: THREE.DoubleSide,
    vertexColors: true, // carries the darker horizontal band, see makeClothGeometry
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader =
      "uniform float uTime;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         float edge = (position.x + ${(cfg.clothW / 2).toFixed(3)}) / ${cfg.clothW.toFixed(3)};
         float w = sin(position.x * 5.5 - uTime * ${cfg.waveSpeed.toFixed(2)}) * ${cfg.waveAmp.toFixed(3)} * edge
                 + sin(position.y * 9.0 + uTime * 3.1) * 0.03 * edge;
         transformed.z += w;`
      );
  };
  mat.customProgramCacheKey = () => "ar-ctf-cloth";
  return mat;
}

/**
 * The cloth, with a darker horizontal band written into vertex colours. UT99's
 * flag is a texture; this is the cheapest honest stand-in - it breaks the flat
 * colour without a second draw call, a second plane to z-fight, or any art.
 */
function makeClothGeometry(cfg) {
  const geo = new THREE.PlaneGeometry(cfg.clothW, cfg.clothH, 16, 8);
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const pos = geo.attributes.position.array;
  for (let i = 0; i < count; i++) {
    const t = Math.abs(pos[i * 3 + 1]) / (cfg.clothH / 2); // 0 at the middle row
    const shade = t < 0.13 ? 0.55 : t < 0.38 ? 0.55 + (t - 0.13) * 1.8 : 1.0;
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = Math.min(1, shade);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geo;
}
