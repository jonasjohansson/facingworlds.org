// interpolation.js — framework-free snapshot interpolation for networked poses.
//
// Remote poses arrive every 50–100ms over the network. Applying them raw makes other
// players teleport, so instead we buffer incoming snapshots and render each entity a
// fixed amount of time IN THE PAST (delayMs). At any render frame there are then two
// snapshots bracketing the render time and we interpolate between them, which turns a
// 10–20Hz packet stream into smooth 60Hz motion.
//
// This module has ZERO dependencies — no A-Frame, no THREE, no DOM. It is plain math
// over plain objects so the A-Frame game and the pure-Three.js AR spectator can share
// one implementation instead of each growing their own (and each re-acquiring the
// teleporting bugs the other already fixed).

// How far in the past to render, in ms. One-and-a-bit packet intervals of slack.
const DEFAULT_DELAY_MS = 100;
// Hard ceiling on how far past the newest snapshot we are willing to extrapolate.
const DEFAULT_MAX_EXTRAPOLATION_MS = 250;
// Hard cap on snapshots per entity so a stalled consumer can never grow this unbounded.
const DEFAULT_MAX_BUFFER = 32;
// How much history to keep behind the render time before pruning, in ms.
const HISTORY_MS = 1000;
// Teleport detection: anything faster than this (u/s), with a floor for tiny gaps,
// is a respawn rather than movement.
const TELEPORT_SPEED = 150;
const TELEPORT_MIN_DISTANCE = 20;
// How fast the clock-offset estimate follows a slower sample (per arrival).
const CLOCK_TRACK = 0.01;

// Monotonic local clock — immune to wall-clock jumps mid-session.
const defaultNow = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

// Shortest-arc yaw interpolation. For a single axis this is identical to a quaternion
// slerp, and far cheaper than building two quaternions per frame.
export function lerpYaw(a, b, alpha) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * alpha;
}

export class SnapshotBuffer {
  // opts: { delayMs = 100, maxExtrapolationMs = 250, maxBuffer = 32, now = performance.now }
  // `now` exists so tests (and any fixed-step consumer) can drive a deterministic clock.
  constructor(opts = {}) {
    this.delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : DEFAULT_DELAY_MS;
    this.maxExtrapolationMs = Number.isFinite(opts.maxExtrapolationMs) ? opts.maxExtrapolationMs : DEFAULT_MAX_EXTRAPOLATION_MS;
    this.maxBuffer = Number.isFinite(opts.maxBuffer) ? opts.maxBuffer : DEFAULT_MAX_BUFFER;
    this.now = typeof opts.now === "function" ? opts.now : defaultNow;

    // serverTime - localTime, estimated from arrivals. One server clock, so one estimate
    // shared by every entity in this buffer — a fast packet from any of them helps all.
    this.clockOffset = null;

    // id -> { snaps: [{t,x,y,z,ry,speed,anim}] sorted ascending by t, anim }
    this.tracks = new Map();
  }

  // Feed one snapshot. `pose` is {x,y,z,ry,speed,animation}; `serverTimeMs` is the
  // server's timestamp for it (falls back to pose.t, then to arrival time).
  //
  // Returns "snap" when the entity was teleported (first pose or a respawn) and the
  // buffer was reset onto this snapshot, "insert" when it went into the buffer normally,
  // "stale" when it arrived too late to matter, "invalid" for unusable input. Consumers
  // that apply their own smoothing on top should hard-set their state on "snap" so a
  // respawn does not slide across the map.
  push(id, pose, serverTimeMs) {
    if (id === undefined || id === null || !pose) return "invalid";

    const x = pose.x,
      y = pose.y,
      z = pose.z;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return "invalid";

    const localNow = this.now();

    // Estimate the offset between the server clock and ours. The largest observed
    // (serverT - localNow) is the sample that travelled fastest, i.e. the least biased
    // one; everything else decays the estimate slowly so it tracks drift instead of
    // sticking to one lucky packet.
    let serverT = Number.isFinite(serverTimeMs) ? serverTimeMs : Number.isFinite(pose.t) ? pose.t : null;
    if (serverT !== null) {
      const est = serverT - localNow;
      if (this.clockOffset === null || est > this.clockOffset) this.clockOffset = est;
      else this.clockOffset += (est - this.clockOffset) * CLOCK_TRACK;
    } else if (this.clockOffset === null) {
      // No timestamp (older server build, or a spawn/respawn message) — treat the
      // arrival time as the sample time.
      this.clockOffset = 0;
    }

    const t = serverT !== null ? serverT : localNow + this.clockOffset;

    const track = this._track(id);

    // The server only ships the animation block when it changes, so carry it forward.
    if (pose.animation) {
      track.anim = {
        idle: pose.animation.idle || 0,
        walk: pose.animation.walk || 0,
        run: pose.animation.run || 0,
      };
    }

    const snaps = track.snaps;
    const last = snaps.length ? snaps[snaps.length - 1] : null;

    const snap = {
      t,
      x,
      y,
      z,
      ry: Number.isFinite(pose.ry) ? pose.ry : last ? last.ry : 0,
      speed: Number.isFinite(pose.speed) ? pose.speed : 0,
      anim: track.anim,
    };

    // First pose: snap, no interpolation from the origin.
    if (!last) {
      this._snapTo(track, snap);
      return "snap";
    }

    // A respawn is a legitimate teleport — interpolating it would drag the avatar across
    // the whole map. Anything faster than could possibly be run/fallen in the elapsed
    // time is treated as a jump and snapped instead. Only newer-than-newest snapshots
    // qualify: a late arrival looks like a huge jump backwards in time and must go
    // through the normal insert path instead of snapping the avatar to it.
    if (snap.t > last.t) {
      const gap = Math.max(0, (snap.t - last.t) / 1000);
      const dx = snap.x - last.x,
        dy = snap.y - last.y,
        dz = snap.z - last.z;
      const limit = Math.max(TELEPORT_MIN_DISTANCE, TELEPORT_SPEED * gap);
      if (dx * dx + dy * dy + dz * dz > limit * limit) {
        this._snapTo(track, snap);
        return "snap";
      }
    }

    return this._insert(track, snap) ? "insert" : "stale";
  }

  // Blend the two snapshots bracketing the render time.
  // Returns {x,y,z,ry,speed,animation} or null when nothing is known about `id`.
  // `nowMs` is a local timestamp in the same base as the `now` option (default
  // performance.now()); omit it to read the clock here.
  sample(id, nowMs) {
    const track = this.tracks.get(id);
    if (!track || !track.snaps.length) return null;

    const buf = track.snaps;
    const renderT = this._renderTime(nowMs);

    // Still waiting for the buffer to fill, or the render time is behind everything we
    // hold (a long stall) — pin to the oldest snapshot we have.
    if (buf.length === 1 || renderT <= buf[0].t) return out(buf[0]);

    const newest = buf[buf.length - 1];

    if (renderT >= newest.t) {
      // Gap: no newer snapshot yet. Extrapolate briefly along the last known segment to
      // cover ordinary packet jitter, then ease the extrapolated lead back to zero.
      //
      // The server drops a pose broadcast entirely when nothing meaningfully moved
      // (server.js quantizes and compares against the last broadcast), so a gap longer
      // than the extrapolation window means "this player stopped", and the last KNOWN
      // position is the truth. Freezing at the extrapolated point instead would leave an
      // idle avatar standing permanently metres from where it really is — at 12 u/s with
      // 80ms packets and a 250ms cap that is a ~3 unit error that never resolves.
      const ahead = renderT - newest.t;
      const prev = buf[buf.length - 2];
      const span = prev ? newest.t - prev.t : 0;
      const lead = Math.min(ahead, this.maxExtrapolationMs);
      // 1 while inside the window, ramping to 0 over a second window of the same length.
      const settle = ahead - this.maxExtrapolationMs;
      const decay = settle > 0 ? Math.max(0, 1 - settle / this.maxExtrapolationMs) : 1;
      const maxAhead = lead * decay;

      if (prev && span > 0 && maxAhead > 0) {
        const k = maxAhead / span;
        return {
          x: newest.x + (newest.x - prev.x) * k,
          y: newest.y + (newest.y - prev.y) * k,
          z: newest.z + (newest.z - prev.z) * k,
          ry: lerpYaw(prev.ry, newest.ry, 1 + k),
          speed: newest.speed,
          animation: newest.anim,
        };
      }
      return out(newest);
    }

    // Normal case: find the bracketing pair and lerp between them.
    let i = buf.length - 2;
    while (i > 0 && buf[i].t > renderT) i--;
    const a = buf[i];
    const b = buf[i + 1];
    const span = b.t - a.t;
    const alpha = span > 0 ? Math.min(1, Math.max(0, (renderT - a.t) / span)) : 1;

    return {
      x: a.x + (b.x - a.x) * alpha,
      y: a.y + (b.y - a.y) * alpha,
      z: a.z + (b.z - a.z) * alpha,
      ry: lerpYaw(a.ry, b.ry, alpha),
      speed: a.speed + (b.speed - a.speed) * alpha,
      // Animation state comes from the snapshot we are leaving, so the legs match the
      // motion we are actually rendering rather than a state 100ms in the future.
      animation: a.anim,
    };
  }

  remove(id) {
    this.tracks.delete(id);
  }

  clear() {
    this.tracks.clear();
  }

  ids() {
    return [...this.tracks.keys()];
  }

  // ---- internals ----

  _track(id) {
    let track = this.tracks.get(id);
    if (!track) {
      track = { snaps: [], anim: null };
      this.tracks.set(id, track);
    }
    return track;
  }

  _renderTime(nowMs) {
    const local = Number.isFinite(nowMs) ? nowMs : this.now();
    return local + (this.clockOffset || 0) - this.delayMs;
  }

  // Discard this entity's history and place it exactly on this snapshot.
  _snapTo(track, snap) {
    track.snaps.length = 0;
    track.snaps.push(snap);
  }

  // Insert keeping the buffer sorted; handles duplicate and out-of-order arrivals.
  // Returns false when the snapshot arrived too late to be worth holding.
  _insert(track, snap) {
    const buf = track.snaps;
    const last = buf.length ? buf[buf.length - 1] : null;

    if (!last || snap.t > last.t) {
      buf.push(snap);
    } else if (snap.t === last.t) {
      buf[buf.length - 1] = snap; // same instant, newer data wins
    } else if (snap.t <= buf[0].t) {
      return false; // arrived so late it is already behind everything we hold — drop it
    } else {
      // Out of order: walk back to the insertion point (buffers are tiny, this is cheap)
      let i = buf.length - 1;
      while (i >= 0 && buf[i].t > snap.t) i--;
      if (i >= 0 && buf[i].t === snap.t) buf[i] = snap;
      else buf.splice(i + 1, 0, snap);
    }

    // Prune: keep the two snapshots that bracket the render time plus a little history
    const cutoff = this._renderTime() - HISTORY_MS;
    while (buf.length > 2 && buf[1].t < cutoff) buf.shift();
    while (buf.length > this.maxBuffer) buf.shift();
    return true;
  }
}

function out(s) {
  return { x: s.x, y: s.y, z: s.z, ry: s.ry, speed: s.speed, animation: s.anim };
}

export default SnapshotBuffer;
