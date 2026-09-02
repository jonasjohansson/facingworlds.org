// bullet.js — instant tracer for a single shot
// The Enforcer is hitscan, so this is no longer a travelling projectile: the component
// resolves the whole shot in init() via the shared trace, draws a tracer plus an impact,
// and removes itself on the next tick. The schema is unchanged so the network layer can
// keep spawning shots the same way — vx/vy/vz are read as a direction, and radius/lifeSec
// are accepted but no longer meaningful.
import { hitscan } from "./hitscan.js";
import { spawnTracer, spawnImpact } from "./impact-effects.js";
import { GAME_CONFIG } from "../config/game-config.js";
import { createVector3 } from "../utils/three-helpers.js";

// ---- shared audio pool (module-level, shared across all bullet instances) ----
const AUDIO_POOL_SIZE = 4;
let audioPool = null;
let audioPoolIndex = 0;
const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

// A pool per sound, so somebody else's Sniper Rifle sounds like a Sniper Rifle rather
// than like your Enforcer. The sound arrives with the shot: the network layer knows which
// weapon each player is holding, from the loadout broadcasts it already receives.
const audioPools = new Map();

function poolFor(src) {
  if (isMobile) return null;
  let pool = audioPools.get(src);
  if (pool) return pool;
  pool = [];
  for (let i = 0; i < AUDIO_POOL_SIZE; i++) {
    const a = new Audio(src);
    a.volume = 0.01;
    a.preload = "auto";
    pool.push(a);
  }
  audioPools.set(src, pool);
  return pool;
}

function playPooledAudio(src) {
  const pool = poolFor(src || "assets/audio/fire.wav");
  if (!pool) return;
  const a = pool[audioPoolIndex % AUDIO_POOL_SIZE];
  audioPoolIndex++;
  a.currentTime = 0;
  a.play().catch(() => {});
}

AFRAME.registerComponent("bullet", {
  schema: {
    vx: { type: "number", default: 0 },
    vy: { type: "number", default: 0 },
    vz: { type: "number", default: 0 },
    radius: { type: "number", default: 0.05 }, // legacy, kept for schema compatibility
    lifeSec: { type: "number", default: 2.0 }, // legacy, kept for schema compatibility
    ownerId: { type: "string", default: "" },
    sound: { type: "string", default: "" },
    reportHits: { type: "boolean", default: false },
  },

  init() {
    const origin = createVector3();
    const dir = createVector3(this.data.vx, this.data.vy, this.data.vz);

    // A zero velocity carries no direction — nothing to trace. tick() cleans the
    // entity up on the next frame; removing it from inside init() is not safe.
    if (dir.lengthSq() < 1e-8) return;
    dir.normalize();

    this.el.object3D.getWorldPosition(origin);
    this.resolveShot(origin, dir);

    // Play shot sound from shared pool
    playPooledAudio(this.data.sound);

    // Emit bullet-fired event for background music
    this.el.sceneEl.emit("bullet-fired");
  },

  resolveShot(origin, dir) {
    const scene = this.el.sceneEl;

    // Nearest of world geometry and player capsules wins, so remote tracers stop at walls
    const result = hitscan(scene, origin, dir, {
      maxDistance: GAME_CONFIG.WEAPON.MAX_RANGE,
      excludeId: this.data.ownerId,
    });

    spawnTracer(scene, origin, result.point);

    if (result.type === "player") {
      spawnImpact(scene, result.point, result.normal, true);
      if (this.data.reportHits) {
        // Only report the victim; the server decides the damage
        scene.emit("local-hit", { victimId: result.playerId, point: result.point });
      }
    } else if (result.type === "world") {
      spawnImpact(scene, result.point, result.normal, false);
    }
  },

  tick() {
    // The shot resolved in init(); the entity exists for one frame only.
    this._despawn();
  },

  _despawn() {
    // No geometry or materials are owned by this component any more — tracers and
    // impacts come from the shared pools in impact-effects.js — so there is nothing
    // per-shot left to dispose.
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  },
});
