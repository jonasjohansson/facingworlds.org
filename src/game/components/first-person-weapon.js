// first-person-weapon.js — First-person weapon view and shooting
// The Enforcer is hitscan: every shot is a single instant trace from the camera against
// world geometry and player capsules, with the tracer drawn from the muzzle to whatever
// the trace hit. Nothing travels.
import { GAME_CONFIG } from "../config/game-config.js";
import { hitscan } from "./hitscan.js";
import { spawnTracer, spawnImpact, getFlashTexture } from "./impact-effects.js";

// Shared audio pool for weapon sounds
const WEAPON_POOL_SIZE = 4;
let weaponAudioPool = null;
let weaponAudioIndex = 0;
const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

function getWeaponAudioPool() {
  if (weaponAudioPool) return weaponAudioPool;
  if (isMobileDevice) return null;
  weaponAudioPool = [];
  for (let i = 0; i < WEAPON_POOL_SIZE; i++) {
    const a = new Audio("assets/audio/fire.wav");
    a.volume = 0.1;
    a.preload = "auto";
    weaponAudioPool.push(a);
  }
  return weaponAudioPool;
}

function playPooledWeaponSound(volume) {
  const pool = getWeaponAudioPool();
  if (!pool) return;
  const a = pool[weaponAudioIndex % WEAPON_POOL_SIZE];
  weaponAudioIndex++;
  a.volume = volume;
  a.currentTime = 0;
  a.play().catch(() => {});
}

AFRAME.registerComponent("first-person-weapon", {
  schema: {
    enabled: { type: "boolean", default: true },
    weaponModel: { type: "string", default: "#enforcer-weapon" },
    weaponScale: { type: "vec3", default: { x: 0.1, y: 0.1, z: 0.1 } },
    weaponPosition: { type: "vec3", default: { x: 0.3, y: -0.2, z: -0.5 } },
    weaponRotation: { type: "vec3", default: { x: 0, y: 0, z: 0 } },
    muzzleOffset: { type: "vec3", default: { x: 0.8, y: 0.1, z: 0 } }, // Position relative to weapon where bullets spawn
    fireRate: { type: "number", default: GAME_CONFIG.WEAPON.FIRE_RATE }, // Shots per second
    maxRange: { type: "number", default: GAME_CONFIG.WEAPON.MAX_RANGE }, // Hitscan range in metres
    spread: { type: "number", default: GAME_CONFIG.WEAPON.SPREAD }, // Cone half-angle tangent
    lastFireTime: { type: "number", default: 0 },
    // Hit feedback
    hitFlashColor: { type: "string", default: "#ff0000" }, // Red flash on hit
    hitFlashDuration: { type: "number", default: 200 }, // Flash duration in ms
    // Multikill tracking
    killStreak: { type: "number", default: 0 },
    lastKillTime: { type: "number", default: 0 },
    multikillTimeout: { type: "number", default: 3000 }, // 3 seconds between kills for multikill
  },

  init() {
    this.weapon = null;
    this.muzzlePosition = new THREE.Vector3();
    this.isFiring = false;
    this.lastFireTime = 0;
    this.killStreak = 0;
    this.lastKillTime = 0;
    this.spreeCount = 0;

    // ---- hitscan scratch vectors (reused, no per-shot allocation) ----
    this._rayOrigin = new THREE.Vector3();
    this._rayDir = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._muzzleLocal = new THREE.Vector3();

    // ---- recoil / feel state ----
    // Camera kick is applied straight to look-controls' pitch/yaw objects, because
    // look-controls rewrites the camera rotation every frame and would eat anything
    // written to the entity's rotation. A fraction of each kick is recovered.
    this.recoilPitchDebt = 0;
    this.recoilYawDebt = 0;
    this.weaponKick = 0; // 1 right after a shot, decays to 0
    this.crosshairBloom = 0;
    this.weaponRestRotation = null;
    this.muzzleFlash = null;
    this.muzzleLight = null;
    this.muzzleFlashLife = 0;

    // Local avatar is excluded from traces so you cannot shoot yourself point blank
    this.localAvatarEl = null;

    // No kill flash. DrawFragCount's only feedback on a frag is the 3 s gold
    // sawtooth on the frag box plus its gold glow blob, both of which the HUD
    // already draws; ChallengeHUD has no screen-edge pulse anywhere.

    // Crosshair — Botpack.CHair1, the stock UT99 default (Engine.HUD Crosshair=0).
    //
    // It is a 64x64 GREYSCALE texture drawn at
    //     XScale  = ClipX < 512 ? 0.5 : max(1, int(0.1 + ClipX/640))
    //     XLength = 64 * XScale, centred at ((W-XLength)/2, (H-XLength)/2)
    // in 15 * CrosshairColor = 15 * (0,16,0) = (0,240,0) GREEN, STY_Translucent.
    // No outline, no glow, no bloom, and it does NOT move when you fire — the
    // only animation on it is a 0.4 s grow-to-2x-and-back after a PICKUP.
    //
    // The art is EXACTLY 16 lit texels, pixel-dumped from the shipped PNG: four
    // ticks per arm, the horizontal arm an exact mirror of the vertical, and NO
    // texel at (32,32) — the centre is hollow, so nothing sits on the point you
    // are aiming at. Drawn here as 1x1 rects in a 64-unit viewBox with
    // crispEdges, so the SVG lands on the same integer grid the
    // nearest-neighbour blit would.
    this.crosshair = document.createElement("div");
    this.crosshair.className = "ut-crosshair";
    this.crosshair.innerHTML =
      '<svg viewBox="0 0 64 64" shape-rendering="crispEdges" aria-hidden="true">' +
      // vertical arm, x = 32: rows 26, 28..30, 34..36, 38
      '<rect x="32" y="26" width="1" height="1"/>' +
      '<rect x="32" y="28" width="1" height="3"/>' +
      '<rect x="32" y="34" width="1" height="3"/>' +
      '<rect x="32" y="38" width="1" height="1"/>' +
      // horizontal arm, y = 32: the mirror of the vertical — cols 26, 28..30,
      // 34..36, 38
      '<rect x="26" y="32" width="1" height="1"/>' +
      '<rect x="28" y="32" width="3" height="1"/>' +
      '<rect x="34" y="32" width="3" height="1"/>' +
      '<rect x="38" y="32" width="1" height="1"/>' +
      "</svg>";
    document.body.appendChild(this.crosshair);
    this.crosshairPulse = 0; // seconds remaining of the 0.4 s pickup pulse
    this._onResize = () => this.updateCrosshair();
    window.addEventListener("resize", this._onResize);
    this.updateCrosshair();

    // Hitmarker — NOT A SOURCE BEHAVIOUR, kept deliberately and annotated the
    // way the reload blink and the TAB hint are. UT99 confirms a hit with the
    // victim's pain sound over a LAN link; this build is a browser peer game
    // where that sound may never arrive, so an 80 ms white X stands in for it.
    // A chunky X with a gold bloom, hidden by default. The two bars are
    // rotated by .ut-hitmarker i:first-child / :last-child in styles.css.
    this.hitmarker = document.createElement("div");
    this.hitmarker.className = "ut-hitmarker";
    this.hitmarker.appendChild(document.createElement("i"));
    this.hitmarker.appendChild(document.createElement("i"));
    document.body.appendChild(this.hitmarker);

    // Wait for camera to be ready
    this.el.addEventListener("loaded", () => {
      this.setupWeapon();
    });

    // Listen for key presses directly (X key for firing, C key for camera)
    this._onKeyDown = (e) => {
      if (e.code === "KeyX") {
        this.isFiring = true;
        e.preventDefault();
      } else if (e.code === "KeyC") {
        // There is no camera-swap implementation in this component (or any other), and
        // the old unconditional this.swapCamera() threw a TypeError on every press.
        // Kept as a guarded hook so wiring one up later is a one-line change.
        if (typeof this.swapCamera === "function") {
          this.swapCamera();
          e.preventDefault();
        }
      }
    };
    this._onKeyUp = (e) => {
      if (e.code === "KeyX") {
        this.isFiring = false;
        e.preventDefault();
      }
    };

    window.addEventListener("keydown", this._onKeyDown, { passive: false });
    window.addEventListener("keyup", this._onKeyUp);

    // Left mouse fires. Only while the pointer is locked: A-Frame's
    // look-controls uses a canvas click to REQUEST pointer lock, so firing on
    // an unlocked click would put a shot into the floor every time the player
    // clicks in to play. Once locked, every click is a shot.
    this._onMouseDown = (e) => {
      if (e.button !== 0 || !document.pointerLockElement) return;
      this.isFiring = true;
    };
    this._onMouseUp = (e) => {
      if (e.button !== 0) return;
      this.isFiring = false;
    };
    // Release on pointer-lock exit too, or holding the button while pressing
    // Escape leaves isFiring stuck true with no mouseup ever arriving.
    this._onPointerLockChange = () => {
      if (!document.pointerLockElement) this.isFiring = false;
    };

    window.addEventListener("mousedown", this._onMouseDown);
    window.addEventListener("mouseup", this._onMouseUp);
    document.addEventListener("pointerlockchange", this._onPointerLockChange);

    // Create touch fire button for mobile devices
    this.createTouchFireButton();

    // Multi-kill announcement element (center screen). Same behaviour as before —
    // only the typography moved to styles.css (.ut-announce), where it now matches
    // the corner plates: heavy condensed caps, saturated glow, and a slam-in.
    this.announceEl = document.createElement("div");
    this.announceEl.className = "ut-announce ut-announce--multikill";
    document.body.appendChild(this.announceEl);

    // Spree announcement element (below multi-kill)
    this.spreeEl = document.createElement("div");
    this.spreeEl.className = "ut-announce ut-announce--spree";
    document.body.appendChild(this.spreeEl);

    // ---- dual Enforcers ----
    // UT99's second-Enforcer pickup: same gun twice, fired alternately, so the
    // rate doubles while each shot is individually worse. The SERVER grants this
    // (see server/server.js takePickup) and the network layer re-emits it; the
    // weapon never decides on its own that it has two guns.
    this.dual = false;
    this.leftWeapon = null;
    this.fireLeft = false; // which hand fires the next shot
    // A loadout change is the only local "you picked something up" signal the
    // network layer emits, so it is what drives the crosshair's pickup pulse.
    this._onLoadout = (e) => {
      this.setDual(!!(e.detail && e.detail.dual));
      this.pulseCrosshair();
    };
    this.el.sceneEl.addEventListener("local-loadout", this._onLoadout);
    // Dying costs you the second gun, so the weapon has to hear about deaths too.
    this.el.sceneEl.addEventListener("local-death", () => this.setDual(false));

    // Listen for hit events
    this.el.sceneEl.addEventListener("local-hit", this.onLocalHit.bind(this));
    this.el.sceneEl.addEventListener("local-kill", this.onLocalKill.bind(this));

    // Listen for death to reset spree
    this._onLocalDeath = () => { this.spreeCount = 0; };
    this.el.sceneEl.addEventListener("local-death", this._onLocalDeath);
  },

  tick(time, dtMs) {
    // Clamp dt so a tab-switch stall doesn't snap the recoil back in one frame
    const dt = Math.min(dtMs || 16, 100) / 1000;

    this.recoverRecoil(dt);
    this.decayMuzzleFlash(dt);
    this.decayCrosshairBloom(dt);

    if (!this.isFiring) return;

    const now = time / 1000;
    const rate = this.dual ? GAME_CONFIG.WEAPON.DUAL_FIRE_RATE : this.data.fireRate;
    const minInterval = 1 / Math.max(1, rate);
    if (now - this.lastFireTime < minInterval) return;

    this.lastFireTime = now;
    this.fireBullet();
  },

  setupWeapon() {
    if (!this.data.enabled || this.weapon) return;

    // Find the weapon entity (should be a child of the camera)
    this.weapon = this.el.querySelector("#player-weapon");

    if (!this.weapon) {
      console.warn("[first-person-weapon] Weapon entity not found, creating fallback");
      this.createFallbackWeapon();
      return;
    }

    // Wait for model to load
    this.weapon.addEventListener("model-loaded", () => {
      this.setupMuzzlePosition();
      this.captureWeaponRest();
      this.setupMuzzleFlash();
      console.log("[first-person-weapon] Enforcer weapon loaded and ready");
    });

    // Add error handling
    this.weapon.addEventListener("error", (e) => {
      console.error("[first-person-weapon] Failed to load weapon model:", e);
      this.createFallbackWeapon();
    });

    // Timeout fallback
    setTimeout(() => {
      if (!this.weapon || !this.weapon.object3D || this.weapon.object3D.children.length === 0) {
        console.warn("[first-person-weapon] Weapon model timeout, creating fallback");
        this.createFallbackWeapon();
      }
    }, 5000);

  },

  setupMuzzlePosition() {
    // Get muzzle position from the weapon-muzzle entity
    const muzzle = this.weapon ? this.weapon.querySelector("#weapon-muzzle") : null;

    if (muzzle && muzzle.object3D) {
      // Get world position of the muzzle entity
      muzzle.object3D.getWorldPosition(this.muzzlePosition);
      // fireBullet() re-reads this every shot, so log it once — a per-shot log both spams
      // the console and prints the same reused, mutated vector for every entry.
      if (!this._loggedMuzzle) {
        this._loggedMuzzle = true;
        console.log("[first-person-weapon] Muzzle position from entity:", this.muzzlePosition.toArray());
      }
    } else {
      // Fallback to camera position + offset
      if (this.el.object3D) {
        const cameraWorldPos = new THREE.Vector3();
        this.el.object3D.getWorldPosition(cameraWorldPos);
        this.muzzlePosition.copy(this.data.muzzleOffset);
        this.muzzlePosition.applyQuaternion(this.el.object3D.quaternion);
        this.muzzlePosition.add(cameraWorldPos);
        if (!this._loggedMuzzleFallback) {
          this._loggedMuzzleFallback = true;
          console.log("[first-person-weapon] Muzzle position fallback:", this.muzzlePosition.toArray());
        }
      }
    }
  },

  handleShoot() {
    if (!this.data.enabled || !this.weapon) return;

    const currentTime = Date.now();
    const timeSinceLastFire = currentTime - this.lastFireTime;
    const fireInterval = 1000 / this.data.fireRate; // Convert to milliseconds

    if (timeSinceLastFire >= fireInterval) {
      this.fireBullet();
      this.lastFireTime = currentTime;
    }
  },

  /**
   * Grant or remove the second Enforcer.
   *
   * Only ever called from a server message (pickup-taken / loadout / death).
   * The second gun is the SAME model mirrored to the other side of the screen,
   * which is the whole appeal of this pickup: a real UT mechanic with no new art.
   */
  setDual(dual) {
    if (dual === this.dual) return;
    this.dual = dual;

    if (dual) {
      if (!this.leftWeapon && this.weapon) {
        const left = document.createElement("a-entity");
        left.setAttribute("gltf-model", this.data.weaponModel);

        // The left gun is the right gun REFLECTED ACROSS THE SCREEN CENTRE, so
        // everything is read off the real thing rather than from constants:
        // index.html owns the position and scale, and weapon-sway owns position
        // at runtime, so any number written here by hand goes stale.
        //
        // Position mirrors x and keeps y/z, which is what puts both guns at the
        // same height and the same distance from the eye. An earlier version used
        // its own offset constant and sat the two guns at different distances
        // from centre.
        const p = this.weapon.object3D.position;
        const sc = this.weapon.object3D.scale;
        const r = this.weapon.object3D.rotation;
        left.setAttribute("position", `${-p.x} ${p.y} ${p.z}`);
        left.setAttribute("scale", `${sc.x} ${sc.y} ${sc.z}`);
        // Same orientation as the right gun. A previous attempt used
        // rotation="0 180 0" thinking it mirrored the model — it does not, it
        // spins the gun to face backwards, which is why it rendered as an
        // unrecognisable slab. A true mirror would need a negative scale, and
        // that inverts the normals and breaks the lighting, so both guns simply
        // point the same way.
        left.setAttribute("rotation", `${THREE.MathUtils.radToDeg(r.x)} ${THREE.MathUtils.radToDeg(r.y)} ${THREE.MathUtils.radToDeg(r.z)}`);

        // Sway, with the same settings as the right gun, or the left one would
        // hang rigid while the right breathes.
        const sway = this.weapon.getAttribute("weapon-sway");
        if (sway) left.setAttribute("weapon-sway", sway);

        this.el.appendChild(left);
        this.leftWeapon = left;
      }
      if (this.leftWeapon) this.leftWeapon.setAttribute("visible", true);
    } else if (this.leftWeapon) {
      this.leftWeapon.setAttribute("visible", false);
    }

    this.el.sceneEl.emit("loadout-changed", { dual });
  },

  fireBullet() {
    if (!this.weapon || !this.weapon.object3D) return;

    const scene = this.el.sceneEl;

    // Update muzzle position (world space) — the tracer starts here
    this.setupMuzzlePosition();

    // The trace itself starts at the eye so it agrees with the crosshair; only the
    // visible tracer starts at the muzzle.
    this.el.object3D.getWorldPosition(this._rayOrigin);

    // Alternate hands when dual-wielding, so shots visibly leave the left gun and
    // the right gun in turn rather than always the right.
    //
    // The mirror is across the CAMERA'S right axis, not world X: the player can be
    // facing any direction, and reflecting world X would send the left muzzle
    // somewhere arbitrary as soon as they turned. The TRACE is untouched — it still
    // runs from the eye down the crosshair — only where the tracer and flash appear
    // moves, which is the part a player actually reads.
    if (this.dual) {
      this.fireLeft = !this.fireLeft;
      if (this.fireLeft && this.leftWeapon) {
        this._right.setFromMatrixColumn(this.el.object3D.matrixWorld, 0).normalize();
        this._muzzleLocal.copy(this.muzzlePosition).sub(this._rayOrigin);
        const along = this._muzzleLocal.dot(this._right);
        this.muzzlePosition.addScaledVector(this._right, -2 * along);
      }
    }

    // Get camera direction (this.el is the camera).
    // getWorldDirection gives +Z, the camera looks down -Z, so negate.
    const dir = this._rayDir;
    this.el.object3D.getWorldDirection(dir);
    dir.negate();
    this.applySpread(dir);

    // Single instant trace: nearest of world geometry and player capsules wins, so
    // shots stop at walls instead of passing through them.
    const result = hitscan(scene, this._rayOrigin, dir, {
      maxDistance: this.data.maxRange,
      excludeEl: this.getLocalAvatar(),
    });

    // Tracer runs muzzle -> impact (or muzzle -> range limit on a miss)
    spawnTracer(scene, this.muzzlePosition, result.point);

    if (result.type === "player") {
      spawnImpact(scene, result.point, result.normal, true);
      // Server decides the damage; keep the payload shape other listeners expect.
      scene.emit("local-hit", { victimId: result.playerId });
    } else if (result.type === "world") {
      spawnImpact(scene, result.point, result.normal, false);
    }

    // Emit to the network layer — unchanged contract (origin, dir).
    // This is the only shot spawn path now; the old local bullet entity was a duplicate.
    scene.emit("local-fire", {
      origin: {
        x: this.muzzlePosition.x,
        y: this.muzzlePosition.y,
        z: this.muzzlePosition.z,
      },
      dir: {
        x: dir.x,
        y: dir.y,
        z: dir.z,
      },
    });

    // Background music ducks on this; it used to come from the bullet component
    scene.emit("bullet-fired");

    // Feel
    this.fireMuzzleFlash();
    this.applyRecoil();
    this.crosshairBloom = GAME_CONFIG.WEAPON.CROSSHAIR_BLOOM;
    this.playWeaponSound();
  },

  // Nudge the shot inside a small cone. Random per shot, applied before the trace so the
  // tracer and the networked direction match exactly what was hit.
  applySpread(dir) {
    // Two guns fire twice as fast and half as well. Without this the pickup would
    // be a pure upgrade, and a pure upgrade is not a choice.
    const spread = this.dual
      ? this.data.spread * GAME_CONFIG.WEAPON.DUAL_SPREAD_MULTIPLIER
      : this.data.spread;
    if (spread <= 0) return;

    // Build a basis around the shot direction
    this._right.set(0, 1, 0).cross(dir);
    if (this._right.lengthSq() < 1e-6) this._right.set(1, 0, 0);
    this._right.normalize();
    this._up.copy(dir).cross(this._right).normalize();

    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * spread;
    dir.addScaledVector(this._right, Math.cos(angle) * radius);
    dir.addScaledVector(this._up, Math.sin(angle) * radius);
    dir.normalize();
  },

  getLocalAvatar() {
    if (this.localAvatarEl && this.localAvatarEl.isConnected) return this.localAvatarEl;
    this.localAvatarEl = this.el.sceneEl.querySelector("#soldier");
    return this.localAvatarEl;
  },

  // ---- muzzle flash ----
  setupMuzzleFlash() {
    if (this.muzzleFlash || !this.el.object3D) return;
    const W = GAME_CONFIG.WEAPON;

    // Parented to the camera rig rather than the weapon so the (0.025) weapon scale
    // doesn't have to be divided back out.
    const mat = new THREE.MeshBasicMaterial({
      map: getFlashTexture(),
      color: 0xffdd88,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    const geo = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;
    this.el.object3D.add(mesh);
    this.muzzleFlash = mesh;
    this.muzzleFlashMat = mat;
    this.muzzleFlashGeo = geo;

    // Created up front so the light-count shader recompile happens now, not on the
    // first shot.
    this.muzzleLight = new THREE.PointLight(0xffcc77, 0, W.MUZZLE_LIGHT_RANGE, 2);
    this.muzzleLight.castShadow = false;
    this.el.object3D.add(this.muzzleLight);
  },

  fireMuzzleFlash() {
    if (!this.muzzleFlash) this.setupMuzzleFlash();
    if (!this.muzzleFlash) return;
    const W = GAME_CONFIG.WEAPON;

    // Muzzle world position -> camera-local, so the flash sits on the barrel tip
    this._muzzleLocal.copy(this.muzzlePosition);
    this.el.object3D.worldToLocal(this._muzzleLocal);

    this.muzzleFlash.position.copy(this._muzzleLocal);
    this.muzzleFlash.rotation.set(0, 0, Math.random() * Math.PI * 2);
    this.muzzleFlash.scale.setScalar(W.MUZZLE_FLASH_SIZE * (0.85 + Math.random() * 0.4));
    this.muzzleFlash.visible = true;
    this.muzzleFlashMat.opacity = 1;

    if (this.muzzleLight) {
      this.muzzleLight.position.copy(this._muzzleLocal);
      this.muzzleLight.intensity = W.MUZZLE_LIGHT_INTENSITY;
    }

    this.muzzleFlashLife = W.MUZZLE_FLASH_LIFE;
  },

  decayMuzzleFlash(dt) {
    if (this.muzzleFlashLife <= 0) return;
    const W = GAME_CONFIG.WEAPON;
    this.muzzleFlashLife -= dt;

    if (this.muzzleFlashLife <= 0) {
      this.muzzleFlashLife = 0;
      if (this.muzzleFlash) {
        this.muzzleFlash.visible = false;
        this.muzzleFlashMat.opacity = 0;
      }
      if (this.muzzleLight) this.muzzleLight.intensity = 0;
      return;
    }

    const k = this.muzzleFlashLife / W.MUZZLE_FLASH_LIFE;
    if (this.muzzleFlashMat) this.muzzleFlashMat.opacity = k;
    if (this.muzzleLight) this.muzzleLight.intensity = W.MUZZLE_LIGHT_INTENSITY * k;
  },

  // ---- recoil ----
  captureWeaponRest() {
    if (!this.weapon || !this.weapon.object3D || this.weaponRestRotation) return;
    const r = this.weapon.object3D.rotation;
    // weapon-sway owns the weapon's position; recoil only touches rotation, so the two
    // compose instead of overwriting each other.
    this.weaponRestRotation = { x: r.x, y: r.y, z: r.z };
  },

  applyRecoil() {
    const W = GAME_CONFIG.WEAPON;

    // Weapon model snaps up, then eases back
    this.weaponKick = 1;
    this._kickRoll = (Math.random() - 0.5) * 2 * W.KICK_ROLL;

    // Camera kick straight into look-controls' pitch/yaw objects
    const look = this.el.components["look-controls"];
    if (!look || !look.pitchObject) return;

    const pitchKick = W.RECOIL_PITCH * (0.8 + Math.random() * 0.4);
    look.pitchObject.rotation.x = Math.min(Math.PI / 2, look.pitchObject.rotation.x + pitchKick);
    this.recoilPitchDebt += pitchKick * W.RECOIL_RECOVER_FRACTION;

    if (look.yawObject) {
      const yawKick = (Math.random() - 0.5) * 2 * W.RECOIL_YAW;
      look.yawObject.rotation.y += yawKick;
      this.recoilYawDebt += yawKick * W.RECOIL_RECOVER_FRACTION;
    }
  },

  recoverRecoil(dt) {
    const W = GAME_CONFIG.WEAPON;

    // Weapon model back to rest
    if (this.weaponKick > 0) {
      this.weaponKick = Math.max(0, this.weaponKick - dt / W.KICK_RECOVER);
      if (this.weapon && this.weapon.object3D && this.weaponRestRotation) {
        const rest = this.weaponRestRotation;
        const k = this.weaponKick;
        const rot = this.weapon.object3D.rotation;
        rot.x = rest.x - W.KICK_PITCH * k;
        rot.y = rest.y;
        rot.z = rest.z + (this._kickRoll || 0) * k;

        // The left gun kicks too. Without this it hangs perfectly still while
        // the right one recoils, which reads as the second gun being a prop
        // rather than a weapon. Its roll is inverted so the pair kick outward
        // from the centre instead of both leaning the same way.
        if (this.dual && this.leftWeapon && this.leftWeapon.object3D) {
          const lrot = this.leftWeapon.object3D.rotation;
          lrot.x = rest.x - W.KICK_PITCH * k;
          lrot.z = rest.z - (this._kickRoll || 0) * k;
        }
      }
    }

    // Camera back toward where it was aimed
    const look = this.el.components["look-controls"];
    if (!look || !look.pitchObject) {
      this.recoilPitchDebt = 0;
      this.recoilYawDebt = 0;
      return;
    }

    const step = W.RECOIL_RECOVER_SPEED * dt;
    if (this.recoilPitchDebt > 0) {
      const d = Math.min(this.recoilPitchDebt, step);
      look.pitchObject.rotation.x -= d;
      this.recoilPitchDebt -= d;
    }
    if (this.recoilYawDebt !== 0 && look.yawObject) {
      const d = Math.sign(this.recoilYawDebt) * Math.min(Math.abs(this.recoilYawDebt), step);
      look.yawObject.rotation.y -= d;
      this.recoilYawDebt -= d;
    }
  },

  // ---- crosshair ----
  // ChallengeHUD.DrawCrossHair does not react to firing at all — the crosshair
  // is nailed to the centre of the screen at a fixed integer scale. The one
  // thing that moves it is a pickup: for 0.4 s afterwards XScale is multiplied
  // by 1+5t while t < 0.2 and by 3-5t after, i.e. it grows to 2x and comes back.
  // `crosshairBloom` is still fed by fireBullet() and still drives the weapon's
  // own spread feel; it just no longer reaches the crosshair.
  decayCrosshairBloom(dt) {
    if (this.crosshairPulse > 0) {
      this.crosshairPulse = Math.max(0, this.crosshairPulse - dt);
      this.updateCrosshair();
    }
    if (this.crosshairBloom <= 0) return;
    this.crosshairBloom = Math.max(0, this.crosshairBloom - dt * GAME_CONFIG.WEAPON.CROSSHAIR_BLOOM_DECAY);
  },

  /** Start the 0.4 s pickup pulse. */
  pulseCrosshair() {
    this.crosshairPulse = 0.4;
    this.updateCrosshair();
  },

  updateCrosshair() {
    if (!this.crosshair) return;
    const w = window.innerWidth || 1280;
    // XScale = ClipX < 512 ? 0.5 : max(1, int(0.1 + ClipX/640)) — 1 @640,
    // 2 @1280, 3 @1920. Integer steps, so the 64x64 art never lands off-grid.
    let scale = w < 512 ? 0.5 : Math.max(1, Math.trunc(0.1 + w / 640));
    // The pickup pulse rides on top as a pure multiplier, 1 -> 2 -> 1 over 0.4 s.
    const t = 0.4 - this.crosshairPulse; // seconds since the pickup
    if (this.crosshairPulse > 0) scale *= t < 0.2 ? 1 + 5 * t : 3 - 5 * t;
    const px = 64 * scale;
    this.crosshair.style.width = px + "px";
    this.crosshair.style.height = px + "px";
    this.crosshair.style.marginLeft = -px / 2 + "px";
    this.crosshair.style.marginTop = -px / 2 + "px";
  },

  playWeaponSound() {
    playPooledWeaponSound(0.1);
  },

  update() {
    if (this.data.enabled && !this.weapon) {
      this.setupWeapon();
    } else if (!this.data.enabled && this.weapon) {
      this.removeWeapon();
    }
  },

  createFallbackWeapon() {
    console.log("[first-person-weapon] Creating weapon");

    // Remove existing weapon
    if (this.weapon) {
      this.el.removeChild(this.weapon);
    }

    // Create weapon group
    this.weapon = document.createElement("a-entity");
    this.weapon.setAttribute("position", this.data.weaponPosition);
    this.weapon.setAttribute("rotation", this.data.weaponRotation);
    this.weapon.setAttribute("scale", this.data.weaponScale);

    // Main weapon body
    const body = document.createElement("a-entity");
    body.setAttribute("geometry", "primitive: box; width: 0.2; height: 0.08; depth: 1.2");
    body.setAttribute("position", "0 0 0");
    body.setAttribute("material", "color: #444444; metalness: 0.9; roughness: 0.1");
    this.weapon.appendChild(body);

    // Barrel
    const barrel = document.createElement("a-entity");
    barrel.setAttribute("geometry", "primitive: cylinder; radius: 0.02; height: 0.8");
    barrel.setAttribute("position", "0 0 0.4");
    barrel.setAttribute("rotation", "90 0 0");
    barrel.setAttribute("material", "color: #333333; metalness: 0.9; roughness: 0.1");
    this.weapon.appendChild(barrel);

    // Handle
    const handle = document.createElement("a-entity");
    handle.setAttribute("geometry", "primitive: box; width: 0.15; height: 0.3; depth: 0.1");
    handle.setAttribute("position", "0 -0.15 -0.3");
    handle.setAttribute("material", "color: #555555; metalness: 0.7; roughness: 0.3");
    this.weapon.appendChild(handle);

    // Trigger guard
    const triggerGuard = document.createElement("a-entity");
    triggerGuard.setAttribute("geometry", "primitive: cylinder; radius: 0.08; height: 0.05");
    triggerGuard.setAttribute("position", "0 -0.05 -0.2");
    triggerGuard.setAttribute("rotation", "90 0 0");
    triggerGuard.setAttribute("material", "color: #444444; metalness: 0.9; roughness: 0.1");
    this.weapon.appendChild(triggerGuard);

    this.el.appendChild(this.weapon);
    this.setupMuzzlePosition();
    this.captureWeaponRest();
    this.setupMuzzleFlash();
    console.log("[first-person-weapon] Weapon created successfully");
  },

  removeWeapon() {
    if (this.weapon) {
      this.el.removeChild(this.weapon);
      this.weapon = null;
      this.weaponRestRotation = null;
      this.weaponKick = 0;
    }
  },

  createTouchFireButton() {
    // Only create on touch devices
    if (!("ontouchstart" in window)) {
      console.log("[first-person-weapon] Not a touch device, skipping fire button");
      return;
    }

    console.log("[first-person-weapon] Creating touch fire button...");

    const fireButton = document.createElement("div");
    fireButton.id = "touch-fire-button";
    fireButton.innerHTML = "FIRE";
    fireButton.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 80px;
      height: 80px;
      background: rgba(60, 60, 60, 0.8);
      border: 3px solid rgba(255, 255, 255, 0.9);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: bold;
      color: white;
      cursor: pointer;
      pointer-events: auto;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
      -webkit-tap-highlight-color: transparent;
      z-index: 1000;
      touch-action: manipulation;
      transition: all 0.1s ease;
    `;

    // Touch events
    fireButton.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        this.isFiring = true;
        fireButton.style.background = "rgba(40, 40, 40, 0.9)";
        fireButton.style.transform = "scale(0.95)";
      },
      { passive: false }
    );

    fireButton.addEventListener(
      "touchend",
      (e) => {
        e.preventDefault();
        this.isFiring = false;
        fireButton.style.background = "rgba(60, 60, 60, 0.8)";
        fireButton.style.transform = "scale(1)";
      },
      { passive: false }
    );

    fireButton.addEventListener(
      "touchcancel",
      (e) => {
        e.preventDefault();
        this.isFiring = false;
        fireButton.style.background = "rgba(60, 60, 60, 0.8)";
        fireButton.style.transform = "scale(1)";
      },
      { passive: false }
    );

    // Mouse events for desktop testing
    fireButton.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.isFiring = true;
      fireButton.style.background = "rgba(40, 40, 40, 0.9)";
      fireButton.style.transform = "scale(0.95)";
    });

    fireButton.addEventListener("mouseup", (e) => {
      e.preventDefault();
      this.isFiring = false;
      fireButton.style.background = "rgba(255, 100, 100, 0.8)";
      fireButton.style.transform = "scale(1)";
    });

    document.body.appendChild(fireButton);
  },

  onLocalHit(event) {
    // Show hitmarker (white X) instead of red flash — only the victim should flash red
    this.showHitmarker();
  },

  showHitmarker() {
    if (!this.hitmarker) return;
    clearTimeout(this._hitmarkerTimer);
    this.hitmarker.style.transition = "none";
    this.hitmarker.style.opacity = "1";
    // Force reflow so the transition kicks in
    void this.hitmarker.offsetWidth;
    this.hitmarker.style.transition = "opacity 150ms ease-out";
    this._hitmarkerTimer = setTimeout(() => {
      this.hitmarker.style.opacity = "0";
    }, 80);
  },

  onLocalKill(event) {
    const now = Date.now();

    // Check if this is part of a multikill streak
    if (now - this.lastKillTime <= this.data.multikillTimeout) {
      this.killStreak++;
    } else {
      this.killStreak = 1; // Reset streak
    }

    this.lastKillTime = now;
    this.spreeCount++;

    // MultiKillMessage.ClientReceive, switch = kills in the streak - 1. These
    // are the exact strings, spacing and punctuation the class ships; stock
    // UT99 never reaches "Triple Kill!" even though the string exists. Switch 1
    // (Double) is drawn in the Big font, 2 and up in the Huge one.
    if (this.killStreak >= 2) {
      const labels = {
        2: "Double Kill!",
        3: "Multi Kill!",
        4: "ULTRA KILL!!",
      };
      const text = labels[this.killStreak] || "M O N S T E R  K I L L !!!";
      this.showAnnouncement(this.announceEl, text, this.killStreak >= 3 ? "huge" : "big");
    }

    // KillingSpreeMessage — third person, WITH the player's name, at exactly
    // 5/10/15/20/25 kills without dying (DeathMatchPlus.NotifySpree).
    const spreeLabels = {
      5: "is on a killing spree!",
      10: "is on a rampage!",
      15: "is dominating!",
      20: "is unstoppable!",
      25: "is Godlike!",
    };
    if (spreeLabels[this.spreeCount]) {
      let name = "You";
      try {
        if (typeof window.getPlayerName === "function") name = window.getPlayerName() || "You";
      } catch {
        /* the name is a nicety; never let it cost the announcement */
      }
      this.showAnnouncement(this.spreeEl, `${name} ${spreeLabels[this.spreeCount]}`, "big");
    }

    // Play multikill sound based on streak
    this.playMultikillSound(this.killStreak);
  },

  /**
   * A LocalMessage at 0.2552 H. bFadeMessage means DrawColor * remaining /
   * Lifetime — a LINEAR ramp to black over the whole 3 s life, with no fade-in
   * and no scale punch: the line is at full strength on the first frame and
   * only ever gets dimmer. All of that is one CSS animation; this only restarts
   * it, which is also how bIsUnique messages replace each other on a line.
   * @param {HTMLElement} el
   * @param {string} text
   * @param {"big"|"huge"} [size] FontSize 1 -> GetBigFont, 2 -> GetHugeFont
   */
  showAnnouncement(el, text, size) {
    if (!el) return;
    clearTimeout(el._hideTimer);
    el.textContent = text;
    el.dataset.size = size === "huge" ? "huge" : "big";
    el.classList.remove("is-on");
    void el.offsetWidth;
    el.classList.add("is-on");
    el._hideTimer = setTimeout(() => {
      el.classList.remove("is-on");
    }, 3000);
  },


  playMultikillSound(streak) {
    // All streaks currently use the same sound — volume increases with streak
    const volume = Math.min(0.05, 0.01 * streak);
    playPooledWeaponSound(volume);
  },

  remove() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    if (this._onResize) window.removeEventListener("resize", this._onResize);
    this.removeWeapon();

    // Dispose muzzle flash GPU resources
    if (this.muzzleFlash && this.muzzleFlash.parent) this.muzzleFlash.parent.remove(this.muzzleFlash);
    if (this.muzzleFlashGeo) this.muzzleFlashGeo.dispose();
    if (this.muzzleFlashMat) this.muzzleFlashMat.dispose();
    if (this.muzzleLight && this.muzzleLight.parent) this.muzzleLight.parent.remove(this.muzzleLight);
    this.muzzleFlash = this.muzzleFlashGeo = this.muzzleFlashMat = this.muzzleLight = null;

    // NOTE: the tracer / spark / decal pools are module-global in impact-effects.js and
    // are shared with bullet.js, which draws every REMOTE player's shot. Disposing them
    // here would tear down another consumer's GPU resources (and re-pay the pre-warm
    // cost on the next remote shot). They live as long as the scene does, which is the
    // correct lifetime, so this component no longer disposes them.

    // Clear any leftover timers
    clearTimeout(this._hitmarkerTimer);

    // Remove touch fire button
    const fireButton = document.getElementById("touch-fire-button");
    if (fireButton) fireButton.remove();

    // Remove HUD overlays
    if (this.crosshair && this.crosshair.parentNode) this.crosshair.remove();
    if (this.hitmarker && this.hitmarker.parentNode) this.hitmarker.remove();
    if (this.announceEl && this.announceEl.parentNode) this.announceEl.remove();
    if (this.spreeEl && this.spreeEl.parentNode) this.spreeEl.remove();

    // Remove death listener
    if (this._onLocalDeath) {
      this.el.sceneEl.removeEventListener("local-death", this._onLocalDeath);
    }
  },
});
