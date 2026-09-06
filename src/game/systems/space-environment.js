/*
  space-environment.js — the CTF-Face backdrop.

  CTF-Face's defining visual is not the towers, it is the SKYBOX: a starfield with
  galaxies and a moon, lifted from the ending sequence of Unreal, turning slowly so the
  asteroid reads as adrift. The important half of that sentence is which thing moves -
  the SKY rotates, the LEVEL is static. So everything here lives under one `skyGroup`
  that is re-pinned to the camera's world position every frame (zero parallax, exactly
  like a real skybox) and turned about a fixed, slightly tilted world axis.

  `earth-sphere` imports SKY_ROTATION_DEG_PER_SEC / SKY_AXIS from this module so the
  planet drifts with the stars rather than against them. One sky, one rotation.

  This file carries `base-coronas` too, as it always did — the two are the same idea
  (UT99 screen candy with no light behind it) and share nothing but the file.
*/
import * as THREE from "three";

/**
 * Degrees per second the whole backdrop turns. The original CTF-Face rotator was slowed
 * down from its first version because players found it nauseating, so this errs slow:
 * a full revolution takes 20 minutes, and the drift only becomes obvious when you hold
 * still and use a tower edge as a reference - which is the effect we want.
 */
export const SKY_ROTATION_DEG_PER_SEC = 0.3;

/**
 * World axis the sky turns about. Deliberately off-vertical: a pure Y spin slides the
 * backdrop sideways in a dead straight line, whereas a tilted axis makes the planet and
 * the galaxies rise and fall a little as they go round.
 */
export const SKY_AXIS = Object.freeze([0.18, 1, 0.09]);

/**
 * Radius the skybox content sits at. Well inside the camera's 10000 far plane, and well
 * outside the map. Deliberately NOT scaled with the world: the sky is re-pinned to the
 * camera every frame, so it has no parallax and its apparent size is scale-invariant —
 * 2100 only has to stay between the map's reach (~260 units after the x2.33552 world
 * scale, up from ~127) and the far plane, and it comfortably does.
 */
const SKY_RADIUS = 2100;

/**
 * Soft round star sprite. PointsMaterial with no map draws hard squares, which is the
 * single most "untextured WebGL demo" tell in the frame.
 */
function makeStarTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,255,255,0.85)");
  g.addColorStop(0.45, "rgba(190,215,255,0.22)");
  g.addColorStop(1.0, "rgba(140,180,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * A galaxy: a bright core, a hazy halo and a couple of smeared spiral arms, all drawn
 * with rotated radial gradients so it stays cheap and stays ours (no downloaded art).
 */
function makeGalaxyTexture(hue) {
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d");
  const c = S / 2;

  // Arms first, so the core burns through them.
  ctx.globalCompositeOperation = "lighter";
  for (let arm = 0; arm < 2; arm++) {
    for (let t = 0.12; t < 1; t += 0.045) {
      const angle = arm * Math.PI + t * 3.4;
      const r = t * c * 0.92;
      const x = c + Math.cos(angle) * r;
      const y = c + Math.sin(angle) * r * 0.42;
      const size = (1 - t) * c * 0.34 + 6;
      const g = ctx.createRadialGradient(x, y, 0, x, y, size);
      const a = 0.1 * (1 - t);
      g.addColorStop(0, `hsla(${hue}, 70%, 78%, ${a})`);
      g.addColorStop(1, `hsla(${hue}, 70%, 60%, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
    }
  }

  // Halo + core.
  const halo = ctx.createRadialGradient(c, c, 0, c, c, c);
  halo.addColorStop(0.0, `hsla(${hue}, 55%, 88%, 0.55)`);
  halo.addColorStop(0.12, `hsla(${hue}, 60%, 72%, 0.28)`);
  halo.addColorStop(0.4, `hsla(${hue}, 65%, 55%, 0.08)`);
  halo.addColorStop(1.0, `hsla(${hue}, 65%, 45%, 0)`);
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, S, S);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A small cratered moon disc, lit from one side. */
function makeMoonTexture() {
  const S = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d");
  const c = S / 2;

  // Terminator: bright on the upper-left limb, falling to nothing on the lower-right.
  const lit = ctx.createRadialGradient(c * 0.62, c * 0.6, 2, c, c, c * 0.98);
  lit.addColorStop(0.0, "rgba(232,232,224,1)");
  lit.addColorStop(0.55, "rgba(150,150,146,1)");
  lit.addColorStop(0.9, "rgba(38,38,42,1)");
  lit.addColorStop(1.0, "rgba(20,20,24,0)");

  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, c * 0.94, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = lit;
  ctx.fillRect(0, 0, S, S);

  // Craters.
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.sqrt(Math.random()) * c * 0.85;
    const x = c + Math.cos(a) * d;
    const y = c + Math.sin(a) * d;
    const r = 2 + Math.random() * 7;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(0,0,0,0.28)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const DEFAULTS = {
  enabled: true,
  starCount: 1400,
  /** Fraction of stars pulled into a Milky-Way-like band rather than spread evenly. */
  bandFraction: 0.45,
  /** Star diameter in CSS pixels. three converts to device pixels - see buildStarLayer. */
  starSize: 3.4,
  /** Fraction of stars promoted to the brighter, larger second layer. */
  brightFraction: 0.09,
  galaxyCount: 4,
  moonEnabled: true,
  /** Degrees/second. Defaults to the shared backdrop rate; see SKY_ROTATION_DEG_PER_SEC. */
  rotationSpeed: SKY_ROTATION_DEG_PER_SEC,
  asteroidCount: 0,
  asteroidSpeed: 0.3,
  nebulaEnabled: false,
  backgroundColor: "#000006",
};

export class SpaceEnvironment {
  constructor(game, opts = {}) {
    this.game = game;
    this.data = { ...DEFAULTS, ...opts };

    this.skyGroup = null;
    this.stars = null;
    this.brightStars = null;
    this.asteroids = [];
    this.disposables = [];
    this.starTexture = null;
    this._bandNormal = null;
    // Allocated once. getWorldPosition() into this every frame; never per frame.
    this._camPos = new THREE.Vector3();
    this._tmpVec = new THREE.Vector3();
    this._axis = new THREE.Vector3(...SKY_AXIS).normalize();

    if (!this.data.enabled) return;

    // What `sceneEl.setAttribute("background", …)` did. scene/world.js paints the same
    // colour as a fallback so the page is never white before this system exists; this is
    // the owner of the value.
    game.scene.background = new THREE.Color(this.data.backgroundColor);

    // Everything that belongs to the sky rides in here. It hangs straight off the scene
    // now — in A-Frame it hung off the component's <a-entity>, which sat at the scene
    // origin at identity, so the worldToLocal() round trip in tick() was a no-op.
    this.skyGroup = new THREE.Group();
    this.skyGroup.name = "sky";
    game.scene.add(this.skyGroup);

    this.createStars();
    this.createGalaxies();
    if (this.data.moonEnabled) this.createMoon();
    this.createAsteroids();
  }

  /**
   * Returns a random unit vector, optionally squashed toward the galactic band plane.
   */
  randomSkyDirection(inBand) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const d = new THREE.Vector3(Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi));

    if (inBand) {
      if (!this._bandNormal) this._bandNormal = new THREE.Vector3(0.42, 0.78, -0.46).normalize();
      // Collapse most of the component along the band normal, leaving a little scatter
      // so the band has soft edges instead of reading as a drawn line.
      const along = d.dot(this._bandNormal);
      const keep = 0.1 + Math.random() * 0.12;
      d.addScaledVector(this._bandNormal, -along * (1 - keep)).normalize();
    }
    return d;
  }

  /**
   * Two Points layers, not one: PointsMaterial has a single `size` for the whole draw
   * call, so the only way to get a sky with both dust and real stars in it is to build
   * the faint majority and the bright minority separately.
   */
  createStars() {
    const bright = Math.floor(this.data.starCount * this.data.brightFraction);
    this.stars = this.buildStarLayer(this.data.starCount - bright, this.data.starSize, 0.8, true);
    this.brightStars = this.buildStarLayer(bright, this.data.starSize * 2.1, 1.0, false);
  }

  buildStarLayer(count, cssSize, opacity, banded) {
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const bandCount = banded ? Math.floor(count * this.data.bandFraction) : 0;

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const d = this.randomSkyDirection(i < bandCount);
      // A little radial jitter keeps the points from landing on one exact shell, which
      // matters because they are additive - a perfect shell moires against itself.
      const radius = SKY_RADIUS * (0.92 + Math.random() * 0.16);
      positions[i3] = d.x * radius;
      positions[i3 + 1] = d.y * radius;
      positions[i3 + 2] = d.z * radius;

      // Star colour: mostly white with blue-white and amber outliers, band stars dimmer.
      const t = Math.random();
      const dim = i < bandCount ? 0.45 + Math.random() * 0.3 : 0.55 + Math.random() * 0.45;
      let r = 1;
      let g = 1;
      let b = 1;
      if (t < 0.16) {
        r = 0.72;
        g = 0.82;
        b = 1.0;
      } else if (t > 0.9) {
        r = 1.0;
        g = 0.83;
        b = 0.62;
      }
      colors[i3] = r * dim;
      colors[i3 + 1] = g * dim;
      colors[i3 + 2] = b * dim;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    if (!this.starTexture) {
      this.starTexture = makeStarTexture();
      this.disposables.push(this.starTexture);
    }

    // `size` is ALREADY in CSS pixels: three uploads the points uniform as
    // `size.value = material.size * renderer.getPixelRatio()`, so multiplying by the
    // pixel ratio here applies it twice and the stars come out DPR-times too big (and
    // a different size on every display, which is the opposite of what we want).
    // It also bakes in whatever pixel ratio happened to be set at init, which
    // quality-tier changes afterwards. Leave the conversion to three.

    const material = new THREE.PointsMaterial({
      map: this.starTexture,
      // sizeAttenuation OFF: these points sit 2100 units out, so perspective scaling
      // would collapse every one of them to a sub-pixel.
      sizeAttenuation: false,
      size: cssSize,
      vertexColors: true,
      transparent: true,
      opacity,
      // Additive + no depth writes: stars must never occlude anything, and two stars
      // overlapping should get brighter rather than z-fight.
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const points = new THREE.Points(geometry, material);
    this.skyGroup.add(points);
    this.disposables.push(geometry, material);
    return points;
  }

  createGalaxies() {
    // Hues chosen to stay in the cold half of the wheel apart from one warm one, so the
    // sky has colour without competing with the red/blue team coding on the towers.
    const hues = [212, 268, 190, 32, 232];
    for (let i = 0; i < this.data.galaxyCount; i++) {
      const texture = makeGalaxyTexture(hues[i % hues.length]);
      const material = new THREE.SpriteMaterial({
        map: texture,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0.55 + Math.random() * 0.3,
      });
      const sprite = new THREE.Sprite(material);
      const d = this.randomSkyDirection(i % 2 === 0);
      sprite.position.copy(d).multiplyScalar(SKY_RADIUS);
      const size = 260 + Math.random() * 420;
      sprite.scale.set(size, size * (0.6 + Math.random() * 0.5), 1);
      // Sprites always face the camera, so a rotation just spins the artwork - which is
      // what stops four galaxies from looking like four copies of one galaxy.
      material.rotation = Math.random() * Math.PI * 2;
      this.skyGroup.add(sprite);
      this.disposables.push(material, texture);
    }
  }

  createMoon() {
    const texture = makeMoonTexture();
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    // Parked away from the band and away from the Earth's side of the sky.
    sprite.position.set(-0.55, 0.42, 0.72).normalize().multiplyScalar(SKY_RADIUS);
    sprite.scale.set(110, 110, 1);
    this.skyGroup.add(sprite);
    this.disposables.push(material, texture);
  }

  createAsteroids() {
    for (let i = 0; i < this.data.asteroidCount; i++) {
      const asteroid = this.createAsteroid();
      this.asteroids.push(asteroid);
      // NOT in skyGroup: the belt is world-anchored, so it keeps its parallax.
      this.game.scene.add(asteroid);
    }
  }

  createAsteroid() {
    const geometry = new THREE.DodecahedronGeometry(1.5, 0);
    const vertices = geometry.attributes.position.array;

    for (let i = 0; i < vertices.length; i += 3) {
      const noise = 0.3 + Math.random() * 0.4;
      vertices[i] *= noise;
      vertices[i + 1] *= noise;
      vertices[i + 2] *= noise;
    }

    geometry.attributes.position.needsUpdate = true;
    geometry.computeVertexNormals();

    const material = new THREE.MeshLambertMaterial({
      color: new THREE.Color().setHSL(0.1, 0.1, 0.2 + Math.random() * 0.3),
      transparent: true,
      opacity: 0.8,
    });

    const asteroid = new THREE.Mesh(geometry, material);

    // World-anchored orbit, x2.33552 with the world scale (src/shared/map-transform.js):
    // the belt has to sit outside the 259-unit map, not inside it. Inert while
    // play.html passes asteroidCount:0, but wrong is wrong.
    const radius = 70.07 + Math.random() * 116.78;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);

    asteroid.position.set(radius * Math.sin(phi) * Math.cos(theta), radius * Math.sin(phi) * Math.sin(theta), radius * Math.cos(phi));

    asteroid.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2);

    asteroid.userData = {
      speed: 0.05 + Math.random() * this.data.asteroidSpeed,
      direction: new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2).normalize(),
      rotationSpeed: new THREE.Vector3((Math.random() - 0.5) * 0.01, (Math.random() - 0.5) * 0.01, (Math.random() - 0.5) * 0.01),
    };

    this.disposables.push(geometry, material);
    return asteroid;
  }

  update(dt) {
    if (!this.data.enabled) return;

    if (this.skyGroup) {
      // Pin to the camera so the backdrop has no parallax, then turn it. Both halves
      // matter: without the pin, walking the bridge slides the "infinite" stars past you.
      // The camera is (or will be) a child of the rig, so its WORLD position is the one
      // that matters; skyGroup is a child of the scene, so no further conversion is
      // needed. The old `Math.min(deltaTime, 100)` clamp is gone: engine/game.js already
      // clamps dt to 1/20 s for every system, which is tighter.
      this.game.camera.getWorldPosition(this._camPos);
      this.skyGroup.position.copy(this._camPos);
      this.skyGroup.rotateOnWorldAxis(this._axis, THREE.MathUtils.degToRad(this.data.rotationSpeed) * dt);
    }

    if (this.asteroids.length === 0) return;
    this.asteroids.forEach((asteroid) => {
      const userData = asteroid.userData;
      this._tmpVec.copy(userData.direction).multiplyScalar(userData.speed);
      asteroid.position.add(this._tmpVec);
      asteroid.rotation.x += userData.rotationSpeed.x;
      asteroid.rotation.y += userData.rotationSpeed.y;
      asteroid.rotation.z += userData.rotationSpeed.z;

      if (asteroid.position.length() > 350.33) {
        const radius = 70.07 + Math.random() * 116.78;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        asteroid.position.set(radius * Math.sin(phi) * Math.cos(theta), radius * Math.sin(phi) * Math.sin(theta), radius * Math.cos(phi));
      }
    });
  }

  dispose() {
    if (this.skyGroup) this.game.scene.remove(this.skyGroup);
    this.asteroids.forEach((asteroid) => this.game.scene.remove(asteroid));
    this.asteroids.length = 0;
    this.disposables.forEach((resource) => resource && resource.dispose && resource.dispose());
    this.disposables.length = 0;
  }
}

/*
  base-coronas — the other UT99 signature: glow sprites bolted to the outside midsections
  of each base, with NO light source behind them. In UT99 a Corona actor is pure screen
  candy; it does not illuminate anything, it just sits there flaring. Doing it with real
  lights would cost six shadowless point lights and still not look like this.

  Default positions were measured off the loaded map (raycasts into #world, back when the
  map was a DOM entity), not guessed — they are baked-in numbers, so nothing here has to
  wait for or query the map at run time. Before the x2.33552 world scale
  (src/shared/map-transform.js) the blue tower's outer face sat at x -37.8 at midsection
  height with a buttress reaching z +/-6.3, and the red tower mirrored that at x +47.4 with
  its footprint centred near z -4.9; sprites were pushed ~2 units clear of those surfaces so
  grazing angles did not slice them against the stonework. At world scale those faces are
  x -88.3 and x +110.7, the buttress reaches z +/-14.7, and the clearance is ~4.7 units.

  The two CROWN coronas (the y=70.07 entries) used to sit INSIDE those outer faces, buried
  in the tower. depthTest is on, so a buried sprite is simply never drawn, and the crown of
  each tower had no corona at all however bright the sprite was. They are now on the same
  side of the wall as the midsection ones, and they show up. If you move a corona, check it
  against the outer-face numbers above first: a corona a few units the wrong way does not
  look dim, it disappears — and every one of these numbers scales with the map, so if the
  world scale is ever revised these have to be re-derived, not eyeballed.
*/

/** Bright core, coloured falloff, faint outer ring - the classic corona/lens-flare read. */
function makeCoronaTexture() {
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d");
  const c = S / 2;

  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.06, "rgba(255,255,255,0.95)");
  g.addColorStop(0.14, "rgba(255,255,255,0.5)");
  g.addColorStop(0.3, "rgba(255,255,255,0.16)");
  g.addColorStop(0.62, "rgba(255,255,255,0.045)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  // Faint halo ring, the giveaway that this is a lens artefact and not a lamp.
  ctx.globalCompositeOperation = "lighter";
  const ring = ctx.createRadialGradient(c, c, c * 0.52, c, c, c * 0.78);
  ring.addColorStop(0.0, "rgba(255,255,255,0)");
  ring.addColorStop(0.5, "rgba(255,255,255,0.07)");
  ring.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = ring;
  ctx.fillRect(0, 0, S, S);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * The A-Frame schema could only carry these as one comma-separated string, so they were
 * written as one and parsed back. Kept in that form — the numbers above are quoted in
 * that layout everywhere they are discussed, and a nested array would break the match.
 */
function parsePositionList(value) {
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(/\s+/).map(Number);
      return new THREE.Vector3(parts[0] || 0, parts[1] || 0, parts[2] || 0);
    });
}

const CORONA_DEFAULTS = {
  enabled: true,
  bluePositions: "-93.89 42.04 -0.7, -79.41 42.04 20.09, -79.41 42.04 -20.79, -92.49 70.07 -0.7",
  redPositions: "116.54 42.04 -11.44, 100.43 42.04 8.64, 100.43 42.04 -31.53, 114.91 70.07 -11.44",
  blueColor: "#4aa6ff",
  redColor: "#ff4530",
  /** World-space diameter of the glow at point-blank range. x world scale. */
  size: 11.68,
  /** How much the sprite is allowed to grow with distance to stay readable across the map. */
  distanceGrowth: 1.1,
  /* Every fade distance below is measured across the map, so all four are x world scale. */
  fadeNear: 16.35,
  fadeFull: 70.07,
  fadeOutStart: 397.04,
  fadeOutEnd: 794.08,
};

export class BaseCoronas {
  constructor(game, opts = {}) {
    this.game = game;
    this.data = { ...CORONA_DEFAULTS, ...opts };

    this.coronas = [];
    this.texture = null;
    this._camPos = new THREE.Vector3();
    this._worldPos = new THREE.Vector3();
    if (!this.data.enabled) return;

    this.texture = makeCoronaTexture();
    this.addTeam(parsePositionList(this.data.bluePositions), this.data.blueColor);
    this.addTeam(parsePositionList(this.data.redPositions), this.data.redColor);
  }

  addTeam(positions, color) {
    positions.forEach((position) => {
      const material = new THREE.SpriteMaterial({
        map: this.texture,
        color: new THREE.Color(color),
        blending: THREE.AdditiveBlending,
        // Additive glows must not write depth, or they punch a hole in everything drawn
        // behind them in the transparent pass.
        depthWrite: false,
        // depthTest stays ON: a corona on the far side of a tower should be hidden by it.
        depthTest: true,
        transparent: true,
      });
      const sprite = new THREE.Sprite(material);
      sprite.position.copy(position);
      sprite.scale.set(this.data.size, this.data.size, 1);
      this.game.scene.add(sprite);
      this.coronas.push({ sprite, material, phase: Math.random() * Math.PI * 2 });
    });
  }

  update(dt, now) {
    if (!this.data.enabled || this.coronas.length === 0) return;
    // Camera world position: it is (or will be) a child of the rig, so its local position
    // is not the one to measure distances from.
    this.game.camera.getWorldPosition(this._camPos);

    const d = this.data;
    this.coronas.forEach((corona) => {
      corona.sprite.getWorldPosition(this._worldPos);
      const dist = this._camPos.distanceTo(this._worldPos);

      // Fade in as you back away (you are inside the glow up close), fade out at the
      // far end of the map so the enemy base reads as a point of light, not a blob.
      let opacity;
      if (dist <= d.fadeNear) opacity = 0;
      else if (dist < d.fadeFull) opacity = (dist - d.fadeNear) / (d.fadeFull - d.fadeNear);
      else if (dist <= d.fadeOutStart) opacity = 1;
      else if (dist < d.fadeOutEnd) opacity = 1 - (dist - d.fadeOutStart) / (d.fadeOutEnd - d.fadeOutStart);
      else opacity = 0;

      // Slow unsynchronised breathe. Small on purpose - a hard flicker reads as a bug.
      // `now` is performance.now() where A-Frame passed time-since-scene-start; only the
      // phase origin differs, and each corona's phase is random anyway.
      opacity *= 0.86 + 0.14 * Math.sin(now * 0.0013 + corona.phase);
      corona.material.opacity = opacity;
      corona.sprite.visible = opacity > 0.004;

      // Perspective alone would shrink a 6-unit sprite to nothing across a 111m map, so
      // let it grow with range. Not a full billboard lock - it still recedes, just less.
      const growth = 1 + (Math.min(dist, d.fadeOutEnd) / d.fadeOutEnd) * d.distanceGrowth;
      const size = d.size * growth;
      corona.sprite.scale.set(size, size, 1);
    });
  }

  dispose() {
    this.coronas.forEach(({ sprite, material }) => {
      this.game.scene.remove(sprite);
      material.dispose();
    });
    this.coronas.length = 0;
    if (this.texture) this.texture.dispose();
  }
}
