// interpolation.test.mjs — plain-node tests for SnapshotBuffer. No framework:
//   node src/shared/net/interpolation.test.mjs
//
// This module has two consumers (the A-Frame game and the Three.js AR spectator) and no
// browser test harness, so the pure math is checked here instead.
import { SnapshotBuffer } from "./interpolation.js";

let failures = 0;
let checks = 0;

function ok(label, cond, extra) {
  checks++;
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${extra !== undefined ? ` — ${extra}` : ""}`);
  }
}

function near(label, actual, expected, eps = 1e-9) {
  ok(label, Math.abs(actual - expected) <= eps, `got ${actual}, expected ${expected}`);
}

function group(name) {
  console.log(`\n${name}`);
}

// A deterministic clock, so nothing here depends on wall time.
function makeBuffer(opts = {}) {
  const clock = { t: 0 };
  const buf = new SnapshotBuffer({ now: () => clock.t, ...opts });
  return { buf, clock };
}

// Sample at an explicit RENDER time (server clock, already delay-shifted). sample()
// takes a local timestamp and applies `+ clockOffset - delayMs` itself, so invert that
// here — otherwise every expectation would have to carry the offset estimator's drift.
function at(buf, id, renderT) {
  return buf.sample(id, renderT + buf.delayMs - (buf.clockOffset || 0));
}

const pose = (x, y, z, extra = {}) => ({ x, y, z, ry: 0, speed: 0, ...extra });

// ---------------------------------------------------------------- empty buffer
group("sampling before any data exists");
{
  const { buf } = makeBuffer();
  ok("sample() on an unknown id returns null", buf.sample("nobody", 0) === null);
  ok("ids() is empty", buf.ids().length === 0);
  ok("remove() on an unknown id is a no-op", (buf.remove("nobody"), true));
  ok("push() rejects a pose with no position", buf.push("a", { ry: 1 }) === "invalid");
  ok("push() rejects a null pose", buf.push("a", null) === "invalid");
  ok("a rejected push creates no track", buf.sample("a", 0) === null);
}

// ---------------------------------------------------------------- ordered pushes
group("ordered pushes interpolate between bracketing snapshots");
{
  const { buf, clock } = makeBuffer({ delayMs: 100 });
  for (const [t, x] of [
    [0, 0],
    [100, 10],
    [200, 20],
  ]) {
    clock.t = t;
    buf.push("p1", pose(x, 0, 0, { speed: x / 10 }), t);
  }
  ok("one track exists", buf.ids().join() === "p1");
  near("clock offset estimated as zero", buf.clockOffset, 0);
  ok("three snapshots retained", buf.tracks.get("p1").snaps.length === 3);

  const s = at(buf, "p1", 150);
  near("x lerps to the midpoint", s.x, 15);
  near("y stays at 0", s.y, 0);
  near("speed lerps too", s.speed, 1.5);

  near("sampling exactly on a snapshot", at(buf, "p1", 100).x, 10);
  near("sampling at the oldest snapshot", at(buf, "p1", 0).x, 0);
  near("sampling behind the buffer pins to the oldest", at(buf, "p1", -50).x, 0);
  near("sampling exactly on the newest holds it", at(buf, "p1", 200).x, 20);
}

group("shortest-arc yaw never spins the long way round");
{
  const { buf, clock } = makeBuffer({ delayMs: 100 });
  clock.t = 0;
  buf.push("p1", pose(0, 0, 0, { ry: 3.0 }), 0);
  clock.t = 100;
  buf.push("p1", pose(0, 0, 0, { ry: -3.0 }), 100);
  const s = at(buf, "p1", 50);
  near("yaw crosses the ±PI seam the short way", s.ry, 3.0 + (-3.0 - 3.0 + 2 * Math.PI) / 2);
  ok("and does not pass through 0", Math.abs(s.ry) > 3.0, `got ${s.ry}`);
}

// ---------------------------------------------------------------- out of order
group("out-of-order and duplicate arrivals");
{
  const { buf, clock } = makeBuffer({ delayMs: 100 });
  clock.t = 0;
  buf.push("p1", pose(0, 0, 0), 0);
  clock.t = 200;
  ok("a t=200 packet inserts", buf.push("p1", pose(20, 0, 0), 200) === "insert");
  clock.t = 210;
  // The t=100 packet took the scenic route and arrives after t=200.
  ok("a late t=100 packet still inserts", buf.push("p1", pose(10, 0, 0), 100) === "insert");
  ok("the buffer holds three snapshots", buf.tracks.get("p1").snaps.length === 3);
  ok(
    "sorted ascending by t",
    buf.tracks
      .get("p1")
      .snaps.map((s) => s.t)
      .join() === "0,100,200"
  );
  near("so the late packet is what renderT=150 blends", at(buf, "p1", 150).x, 15);

  // A duplicate timestamp: newer data wins, no second entry.
  clock.t = 220;
  ok("a duplicate t=200 packet is accepted", buf.push("p1", pose(21, 0, 0), 200) === "insert");
  ok("without growing the buffer", buf.tracks.get("p1").snaps.length === 3);
  near("duplicate replaced the old t=200 value", at(buf, "p1", 200).x, 21);
  near("and the bracketing pair is still 100/200", at(buf, "p1", 150).x, 15.5);

  // Older than everything we hold → dropped.
  clock.t = 230;
  ok("a packet older than the whole buffer is stale", buf.push("p1", pose(-99, 0, 0), -50) === "stale");
  ok("and was not stored", buf.tracks.get("p1").snaps.length === 3);
  near("so sampling is unchanged", at(buf, "p1", 150).x, 15.5);
}

// ---------------------------------------------------------------- extrapolation
group("a gap forces bounded extrapolation");
{
  const { buf, clock } = makeBuffer({ delayMs: 100, maxExtrapolationMs: 250 });
  clock.t = 0;
  buf.push("p1", pose(0, 0, 0), 0);
  clock.t = 100;
  buf.push("p1", pose(10, 0, 0), 100);

  // 150ms past the newest snapshot, under the 250ms ceiling: k = 150/100
  near("extrapolates along the last segment", at(buf, "p1", 250).x, 25);
  // 250ms past the newest — the cap, still fully extrapolated: k = 2.5
  near("extrapolation is capped by maxExtrapolationMs", at(buf, "p1", 350).x, 35);
  // Past the cap the lead eases back: at 375ms the settle window is half spent
  near("past the cap the lead decays back toward the last known pose", at(buf, "p1", 475).x, 22.5);
  // A gap this long means the player stopped moving — the server stops broadcasting a
  // pose that did not change — so the truth is the newest snapshot, not the overshoot.
  near("a long gap settles exactly on the last known position", at(buf, "p1", 1100).x, 10);
  near("and stays there no matter how long the gap runs", at(buf, "p1", 60000).x, 10);
  ok("so an idle avatar never slides off the map", at(buf, "p1", 60000).x === at(buf, "p1", 1100).x);
}

group("extrapolation cap is configurable (the game uses delay + 20)");
{
  const { buf, clock } = makeBuffer({ delayMs: 100, maxExtrapolationMs: 120 });
  clock.t = 0;
  buf.push("p1", pose(0, 0, 0), 0);
  clock.t = 100;
  buf.push("p1", pose(10, 0, 0), 100);
  near("held at the tighter cap: k = 1.2", at(buf, "p1", 220).x, 22);
  near("and settles on the last known pose once the gap outlives the cap", at(buf, "p1", 1100).x, 10);
}

group("a single snapshot holds instead of extrapolating");
{
  const { buf, clock } = makeBuffer({ delayMs: 100 });
  clock.t = 0;
  buf.push("p1", pose(7, 8, 9), 0);
  const s = at(buf, "p1", 10000);
  ok("pinned to the only snapshot", s.x === 7 && s.y === 8 && s.z === 9);
}

// ---------------------------------------------------------------- teleport
group("a teleport snaps instead of sliding across the map");
{
  const { buf, clock } = makeBuffer({ delayMs: 100 });
  clock.t = 0;
  ok("the first pose is always a snap", buf.push("p1", pose(0, 0, 0), 0) === "snap");
  clock.t = 100;
  ok("normal movement is not a snap", buf.push("p1", pose(2, 0, 0), 100) === "insert");

  // 500 units in 100ms is ~5000 u/s — a respawn, not a sprint.
  clock.t = 200;
  ok("a respawn-sized jump reports snap", buf.push("p1", pose(502, 0, 0), 200) === "snap");
  ok("history was discarded", buf.tracks.get("p1").snaps.length === 1);
  near("the buffer sits on the teleport", at(buf, "p1", 150).x, 502);
  near("nothing lerps back towards the old position", at(buf, "p1", 100000).x, 502);
}

group("fast-but-legal movement is not mistaken for a teleport");
{
  const { buf, clock } = makeBuffer({ delayMs: 100 });
  clock.t = 0;
  buf.push("p1", pose(0, 0, 0), 0);
  // 14 units in 100ms = 140 u/s, under the 150 u/s ceiling (a tower fall).
  clock.t = 100;
  ok("a 140 u/s move inserts", buf.push("p1", pose(0, -14, 0), 100) === "insert");
  // 3 units in 10ms = 300 u/s, but under the 20-unit floor for tiny gaps.
  clock.t = 110;
  ok("a small hop inside the distance floor inserts", buf.push("p1", pose(3, -14, 0), 110) === "insert");
  ok("both were kept", buf.tracks.get("p1").snaps.length === 3);
}

group("a late packet that looks like a jump backwards does not snap");
{
  const { buf, clock } = makeBuffer({ delayMs: 100 });
  clock.t = 0;
  buf.push("p1", pose(0, 0, 0), 0);
  clock.t = 100;
  buf.push("p1", pose(5, 0, 0), 100);
  clock.t = 200;
  buf.push("p1", pose(10, 0, 0), 200);
  // A far-away but OLD packet: goes through the insert path, the buffer survives.
  clock.t = 210;
  ok("an old distant packet is not a teleport", buf.push("p1", pose(400, 0, 0), 150) === "insert");
  ok("history was not discarded", buf.tracks.get("p1").snaps.length === 4);
  near("and the newest snapshot still reads true", at(buf, "p1", 200).x, 10);
}

// ---------------------------------------------------------------- animation carry
group("the animation block is carried forward between packets");
{
  const { buf, clock } = makeBuffer({ delayMs: 100 });
  clock.t = 0;
  buf.push("p1", pose(0, 0, 0, { animation: { idle: 0, walk: 0, run: 1 } }), 0);
  clock.t = 100;
  buf.push("p1", pose(10, 0, 0), 100); // server omits the block when it has not changed
  clock.t = 200;
  buf.push("p1", pose(20, 0, 0), 200);
  const s = at(buf, "p1", 150);
  ok("run weight survives packets without an animation block", s.animation && s.animation.run === 1);
  ok("and idle/walk default to 0", s.animation.idle === 0 && s.animation.walk === 0);

  const { buf: b2 } = makeBuffer();
  b2.push("p2", pose(0, 0, 0), 0);
  ok("animation is null when the server never sent one", b2.sample("p2", 0).animation === null);
}

// ---------------------------------------------------------------- clock offset
group("clock offset tracks the server clock");
{
  const { buf, clock } = makeBuffer({ delayMs: 100 });
  // Server clock runs ~5000ms ahead of ours; the first packet takes 30ms to arrive.
  clock.t = 0;
  buf.push("p1", pose(0, 0, 0), 4970);
  near("offset takes the fastest observed sample", buf.clockOffset, 4970);
  clock.t = 100;
  buf.push("p1", pose(1, 0, 0), 5090); // 10ms of latency — a faster sample
  near("a faster sample raises the estimate immediately", buf.clockOffset, 4990);
  clock.t = 200;
  buf.push("p1", pose(2, 0, 0), 5100); // 100ms of latency — slower, so it only decays
  near("a slower sample only nudges the estimate", buf.clockOffset, 4990 + (4900 - 4990) * 0.01, 1e-9);

  // renderT = localNow + offset - delay, so a local clock 100ms on from the last
  // arrival renders the t=5100 snapshot's own instant.
  near("render time lands on the server clock", at(buf, "p1", 5100).x, 2);
}

group("a pose with no timestamp anywhere falls back to arrival time");
{
  const { buf, clock } = makeBuffer({ delayMs: 100 });
  clock.t = 1000;
  ok("untimestamped first pose snaps", buf.push("p1", pose(1, 2, 3)) === "snap");
  near("offset defaults to zero", buf.clockOffset, 0);
  const s = buf.sample("p1", 1000);
  ok("and the pose is readable", s.x === 1 && s.y === 2 && s.z === 3);
}

// ---------------------------------------------------------------- bookkeeping
group("multiple entities, pruning and teardown");
{
  const { buf, clock } = makeBuffer({ delayMs: 100, maxBuffer: 8 });
  for (let i = 0; i <= 40; i++) {
    clock.t = i * 50;
    buf.push("p1", pose(i, 0, 0), i * 50);
    buf.push("p2", pose(-i, 0, 0), i * 50);
  }
  ok("two ids are tracked", buf.ids().sort().join() === "p1,p2");
  ok("p1 is capped at maxBuffer", buf.tracks.get("p1").snaps.length <= 8, buf.tracks.get("p1").snaps.length);
  ok("p1 and p2 stay independent", at(buf, "p1", 1900).x === -at(buf, "p2", 1900).x);

  buf.remove("p2");
  ok("remove() drops the id", buf.sample("p2", 2100) === null && buf.ids().join() === "p1");
  buf.clear();
  ok("clear() empties everything", buf.ids().length === 0 && buf.sample("p1", 2100) === null);
}

group("stale history is pruned but the bracketing pair survives");
{
  const { buf, clock } = makeBuffer({ delayMs: 100 });
  for (let i = 0; i <= 60; i++) {
    clock.t = i * 100;
    buf.push("p1", pose(i, 0, 0), i * 100);
  }
  const snaps = buf.tracks.get("p1").snaps;
  ok("history is trimmed to ~1s behind the render time", snaps.length < 20, snaps.length);
  near("and interpolation is still exact after pruning", at(buf, "p1", 5950).x, 59.5);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
