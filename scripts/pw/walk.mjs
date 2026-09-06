// walk.mjs — does the ported player move like the A-Frame one?
//
// Runs the same measurements on BOTH pages, from the same spawn point, and prints them
// side by side:
//
//   1. WALK   hold W for 3 s at a fixed yaw, sampling the rig ON EVERY FRAME from inside
//             the page (a page.evaluate per sample would add its own round-trip to the
//             clock and read as speed noise). Reported as the mean over the steady window
//             AND as the best 500 ms window.
//
//             THE MEAN IS NOT 9.4 m/s AND SHOULD NOT BE. GROUND_SPEED is the velocity the
//             movement model commands; what the rig actually travels is that velocity
//             after the navmesh clamp, and clampStep projects the step PERPENDICULAR onto
//             the polygon it lands in — so on a slope of angle t the horizontal speed is
//             9.4 * cos^2(t), and against a wall it is zero. CTF-Face's middle is all
//             ramp and rock. The BEST WINDOW is the flat-ground number, and that one must
//             be 9.4 within 5% on both pages.
//
//   2. Y      the largest single-frame step in the rig's y over the steady window. A
//             navmesh clamp that slingshots (the failure the whole hop-off-the-rig design
//             exists to avoid) shows up here first.
//
//   3. JUMP   press Space and poll the hop every frame for 1.2 s: peak height over the
//             standing baseline, time to the peak, time back down. NOTE the baseline is
//             NOT zero — visualOffset() is the hop PLUS the drawn-floor correction, which
//             is a fifth of a metre or so while standing (see groundToFloor).
//
//   4. FLOOR  the camera's height above the DRAWN floor, raycast straight down against
//             the map meshes. This is the number behind "the avatars don't follow the
//             ground the way I do": the navmesh sits up to half a metre above what you
//             can see, and the two pages must agree to within 2 cm.
//
//   5. YAW    pointer-lock mouse deltas cannot be synthesised from Playwright, so the
//             heading is tested where it is USED rather than where it comes from: set the
//             yaw, walk, and check the direction travelled is the one the yaw names.
//
// Headed, always (scripts/pw/launch.mjs): the headless shell renders through SwiftShader
// and neither its frame times nor its rasterisation are the GPU's.
//
// Usage: node scripts/pw/walk.mjs [baseUrl]      default http://localhost:8080
// Also exported as runWalk({ browser, base }) so scripts/pw/parity.mjs can run it beside
// the other three probes in one browser and fold its verdict into one table.
import { launchQuiet } from "./launch.mjs";
import { baseUrl, createChecks, isMain, printChecks } from "./lib.mjs";
import { SPAWNS } from "../../src/shared/map-actors.js";

const GROUND_SPEED = 9.4; // GAME_CONFIG.MOVEMENT.GROUND_SPEED
const SPEED_TOLERANCE = 0.05; // 5% on the best window
const MAX_Y_STEP = 0.35; // metres between two consecutive frames
const WALK_MS = 3000;
const WINDOW_MS = 500; // the "best window" width
const RAMP_MS = 500; // the config claims 0.183 s to 95% of top speed; leave margin
// WHERE BOTH PAGES ARE MEASURED FROM. player/spawn.js's offline placement — the downward
// raycast from above the navmesh bounding box's centre — which is deterministic and is the
// same point in both builds. It has to be FORCED rather than merely waited for: both pages
// talk to the game server now, and `hello.spawn` seats each of them on one of its own
// team's PlayerStarts about a hundred metres from here, on whichever side the server had
// room for. Neither page can be measured where it lands, so both are teleported here.
const START = { x: 11.18, y: 14.41, z: -5.39 };
// How far off a server spawn point a rig may land and still be said to be ON it:
// server.js jitters each spawn by up to SPAWN_JITTER (1 m) in x and z.
const SPAWN_TOLERANCE = 1.5;
// Which way to walk. Swept over the eight compass headings from START: this is the one
// with a long clear run. 0 and 135-225 walk into geometry within a second — CTF-Face's
// middle is ramps and rock, which is also why the MEAN speed is below GROUND_SPEED.
const WALK_YAW_DEG = 45;
// Headings for the direction test, each walked from START. One with no room (a wall in
// front) is reported as "blocked" and skipped rather than failed.
const YAW_TEST_DEG = [45, 90, 315];
// How far a heading sample may travel before it is read as a respawn rather than a walk:
// 800 ms of GROUND_SPEED is 7.5 m, and the furthest any of these headings gets is 4.5.
const MAX_YAW_TRAVEL = 10;
const YAW_ATTEMPTS = 3;

/* ------------------------------------------------------------------ page adapters --
   Each page exposes the same four probes as SELF-CONTAINED functions (they are stringified
   and re-created inside the page, so they may not close over anything out here). The
   A-Frame page is read through the DOM exactly as it was before this migration; the three
   page is read through window.__fw, the debug handle the design doc asked for. Nothing is
   injected into either page beyond one requestAnimationFrame sampler. */
const ADAPTERS = {
  "play.html": {
    ready: () => {
      const g = window.__fw;
      return !!(g && g.player && g.map && g.map.userData.mesh && g.rig.position.lengthSq() > 0);
    },
    pose: () => {
      const p = window.__fw.rig.position;
      return { x: p.x, y: p.y, z: p.z };
    },
    hop: () => window.__fw.player.visualOffset(),
    floor: () => {
      const g = window.__fw;
      const T = g.THREE;
      const from = new T.Vector3();
      g.camera.getWorldPosition(from);
      const meshes = [];
      g.map.userData.mesh.traverse((o) => {
        if (o.isMesh && o.geometry) meshes.push(o);
      });
      const hits = new T.Raycaster(from, new T.Vector3(0, -1, 0), 0, 50).intersectObjects(meshes, false);
      return hits.length ? from.y - hits[0].point.y : null;
    },
    yaw: (radians) => window.__fw.player.setYaw(radians),
    // spawnAt is the controller's own teleport: it resets the navmesh clamp's polygon
    // cache, the velocity, the hop and the speed tracker. Exactly what a respawn does.
    teleport: (at) => window.__fw.player.spawnAt(at.x, at.y, at.z, (at.yawDeg * Math.PI) / 180),
  },

  "index.html": {
    ready: () => {
      const rig = document.querySelector("#rig");
      const world = document.querySelector("#world");
      return !!(rig && world && world.getObject3D("mesh") && rig.object3D.position.lengthSq() > 0);
    },
    pose: () => {
      const p = document.querySelector("#rig").object3D.position;
      return { x: p.x, y: p.y, z: p.z };
    },
    hop: () => {
      const jump = document.querySelector("#rig").components["ut-jump"];
      return jump ? jump.visualOffset() : 0;
    },
    floor: () => {
      const from = new THREE.Vector3();
      document.querySelector("#cam").getObject3D("camera").getWorldPosition(from);
      const meshes = [];
      document.querySelector("#world").object3D.traverse((o) => {
        if (o.isMesh && o.geometry) meshes.push(o);
      });
      const hits = new THREE.Raycaster(from, new THREE.Vector3(0, -1, 0), 0, 50).intersectObjects(meshes, false);
      return hits.length ? from.y - hits[0].point.y : null;
    },
    // look-controls keeps the mouse yaw on #cam and leaves the rig's own alone, so this
    // is the rig yaw that spawns write (network.js applyLocalSpawn does the same); the
    // heading maths in ut-controls reads the product of the two.
    yaw: (radians) => {
      document.querySelector("#rig").object3D.rotation.y = radians;
    },
    // movement-controls caches which navmesh polygon the rig is on and searches only
    // three hops out from it, so a teleport without updateNavLocation() — its own public
    // reset, the one the nav system calls when the mesh changes — is dragged back. This
    // is the same cache player/controller.js resets through navClamp.reset().
    teleport: (at) => {
      const rig = document.querySelector("#rig");
      rig.object3D.position.set(at.x, at.y, at.z);
      rig.object3D.rotation.y = (at.yawDeg * Math.PI) / 180;
      const mc = rig.components["movement-controls"];
      if (mc) mc.updateNavLocation();
    },
  },
};

/* ----------------------------------------------------------------------- helpers -- */
const round = (n, d = 3) => (n === null || n === undefined || Number.isNaN(n) ? null : Number(n.toFixed(d)));

/** Start a per-frame sampler in the page from a stringified probe. */
const START_SAMPLER = (src) => {
  const read = new Function("return (" + src + ")")();
  window.__walkProbe = [];
  const tick = () => {
    const v = read();
    window.__walkProbe.push(typeof v === "number" ? { t: performance.now(), h: v } : { t: performance.now(), ...v });
    window.__walkProbeRaf = requestAnimationFrame(tick);
  };
  tick();
};
const STOP_SAMPLER = () => {
  cancelAnimationFrame(window.__walkProbeRaf);
  const out = window.__walkProbe;
  window.__walkProbe = null;
  return out;
};

async function sampleWhile(page, probe, body) {
  await page.evaluate(START_SAMPLER, probe.toString());
  await body();
  return page.evaluate(STOP_SAMPLER);
}

async function measure(browser, base, name, adapter) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/${name}`);

  await page.waitForFunction(adapter.ready, null, { timeout: 45000 });
  // One more beat so the offline navmesh placement and the first clamp have settled.
  await page.waitForTimeout(1500);
  const spawn = await page.evaluate(adapter.pose);

  // --- 1/2. WALK --------------------------------------------------------------------
  await page.evaluate(adapter.teleport, { ...START, yawDeg: WALK_YAW_DEG });
  await page.waitForTimeout(400);
  const walk = await sampleWhile(page, adapter.pose, async () => {
    await page.keyboard.down("KeyW");
    await page.waitForTimeout(WALK_MS);
    await page.keyboard.up("KeyW");
  });

  const t0 = walk[0].t;
  let steady = 0;
  let steadyFrames = 0;
  let maxYStep = 0;
  const speeds = []; // { t, speed } per frame, for the best-window search
  for (let i = 1; i < walk.length; i++) {
    const a = walk[i - 1];
    const b = walk[i];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) continue;
    const speed = Math.hypot(b.x - a.x, b.z - a.z) / dt;
    speeds.push({ t: b.t - t0, d: Math.hypot(b.x - a.x, b.z - a.z), dt });
    if (b.t - t0 > RAMP_MS) {
      steady += speed;
      steadyFrames++;
      const dy = Math.abs(b.y - a.y);
      if (dy > maxYStep) maxYStep = dy;
    }
  }
  const meanSpeed = steadyFrames ? steady / steadyFrames : 0;

  // Best sustained WINDOW_MS of travel: the flat, unobstructed stretch of the run.
  let bestWindow = 0;
  for (let i = 0; i < speeds.length; i++) {
    let d = 0;
    let dt = 0;
    for (let j = i; j < speeds.length && dt < WINDOW_MS / 1000; j++) {
      d += speeds[j].d;
      dt += speeds[j].dt;
    }
    if (dt >= WINDOW_MS / 1000 && d / dt > bestWindow) bestWindow = d / dt;
  }

  // --- 3. JUMP ----------------------------------------------------------------------
  // Back to START: the hop baseline is the drawn-floor correction, which is a property of
  // where you are standing, so the two pages have to be standing in the same place.
  await page.evaluate(adapter.teleport, { ...START, yawDeg: WALK_YAW_DEG });
  await page.waitForTimeout(700);
  const baseline = await page.evaluate(adapter.hop);
  const hops = await sampleWhile(page, adapter.hop, async () => {
    await page.keyboard.press("Space");
    await page.waitForTimeout(1200);
  });
  const j0 = hops[0].t;
  let peak = -Infinity;
  let peakAt = 0;
  for (const s of hops) {
    if (s.h - baseline > peak) {
      peak = s.h - baseline;
      peakAt = s.t - j0;
    }
  }
  let landedAt = null;
  for (const s of hops) {
    if (s.t - j0 > peakAt && Math.abs(s.h - baseline) < 0.05) {
      landedAt = s.t - j0;
      break;
    }
  }

  // --- 4. FLOOR ---------------------------------------------------------------------
  await page.waitForTimeout(500);
  const floor = await page.evaluate(adapter.floor);

  // --- 5. YAW -----------------------------------------------------------------------
  // BOTH PAGES ARE ON THE LIVE SERVER, and standing still in the middle of CTF-Face for
  // half a second with nine bots on the map is a way to get shot. A respawn is a teleport
  // to a team base a hundred metres away, which arrives in this sample as a "walk" of 95 m
  // in 500 ms and reads as a heading the controller ignored. So a sample that travelled
  // further than a player possibly could is thrown away and the heading walked again.
  const yawTest = [];
  for (const deg of YAW_TEST_DEG) {
    const radians = (deg * Math.PI) / 180;
    let attempt = null;
    for (let tries = 0; tries < YAW_ATTEMPTS && !attempt; tries++) {
      await page.evaluate(adapter.teleport, { ...START, yawDeg: deg });
      await page.waitForTimeout(400);
      const before = await page.evaluate(adapter.pose);
      await page.keyboard.down("KeyW");
      await page.waitForTimeout(500);
      await page.keyboard.up("KeyW");
      await page.waitForTimeout(300);
      const after = await page.evaluate(adapter.pose);
      const dx = after.x - before.x;
      const dz = after.z - before.z;
      const moved = Math.hypot(dx, dz);
      if (moved > MAX_YAW_TRAVEL) continue; // respawned mid-sample; walk it again
      // Forward is world -Z rotated about +Y by the yaw.
      const wantX = -Math.sin(radians);
      const wantZ = -Math.cos(radians);
      attempt = { deg, moved, alignment: moved > 2 ? (dx * wantX + dz * wantZ) / moved : null };
    }
    // Three respawns in a row: report it as a heading with no usable sample rather than
    // as a heading that was walked wrong.
    yawTest.push(attempt || { deg, moved: null, alignment: null, interrupted: true });
  }

  await page.close();
  return { name, spawn, meanSpeed, bestWindow, maxYStep, baseline, peak, peakAt, landedAt, floor, yawTest, errors };
}

/* -------------------------------------------------------------------------- run -- */
/**
 * Measure both pages and print the side-by-side table. Returns the raw measurements plus
 * the check rows (parity.mjs prints those; run directly, they are printed here).
 */
export async function runWalk({ browser, base = baseUrl() } = {}) {
  const results = [];
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    try {
      results.push(await measure(browser, base, name, adapter));
    } catch (e) {
      results.push({ name, failed: e.message });
    }
  }

  const pad = (s, n) => String(s).padEnd(n);
  const col = (s, n) => String(s).padStart(n);
  console.log("");
  console.log(pad(`walk yaw ${WALK_YAW_DEG} deg, ${WALK_MS} ms`, 36) + results.map((r) => col(r.name, 13)).join(""));
  console.log("-".repeat(36 + 13 * results.length));
  const row = (label, f) => console.log(pad(label, 36) + results.map((r) => col(r.failed ? "FAILED" : f(r), 13)).join(""));
  row("spawn x", (r) => round(r.spawn.x, 2));
  row("spawn y", (r) => round(r.spawn.y, 2));
  row("spawn z", (r) => round(r.spawn.z, 2));
  row("mean ground speed (m/s)", (r) => round(r.meanSpeed, 2));
  row(`best ${WINDOW_MS} ms window (m/s)`, (r) => round(r.bestWindow, 2));
  row("max y step per frame (m)", (r) => round(r.maxYStep, 3));
  row("standing hop baseline (m)", (r) => round(r.baseline, 3));
  row("jump peak over baseline (m)", (r) => round(r.peak, 3));
  row("time to peak (ms)", (r) => round(r.peakAt, 0));
  row("back to standing (ms)", (r) => (r.landedAt === null ? "never" : round(r.landedAt, 0)));
  row("camera above drawn floor (m)", (r) => round(r.floor, 3));
  for (const deg of YAW_TEST_DEG) {
    row(`yaw ${deg} deg: walked (m)`, (r) => {
      const y = r.yawTest.find((t) => t.deg === deg);
      return y.interrupted ? "respawned" : round(y.moved, 2);
    });
    row(`yaw ${deg} deg: heading alignment`, (r) => {
      const a = r.yawTest.find((y) => y.deg === deg).alignment;
      return a === null ? "blocked" : round(a, 3);
    });
  }
  console.log("");

  /* ------------------------------------------------------------------------ assert -- */
  const problems = [];
  for (const r of results) {
    if (r.failed) {
      problems.push(`${r.name}: ${r.failed}`);
      continue;
    }
    if (r.errors.length) problems.push(`${r.name}: page errors: ${r.errors.join("; ")}`);
    const off = Math.abs(r.bestWindow - GROUND_SPEED) / GROUND_SPEED;
    if (off > SPEED_TOLERANCE)
      problems.push(`${r.name}: best-window speed ${r.bestWindow.toFixed(2)} is ${(off * 100).toFixed(1)}% off ${GROUND_SPEED}`);
    if (r.maxYStep > MAX_Y_STEP) problems.push(`${r.name}: y jumped ${r.maxYStep.toFixed(3)} m in one frame (limit ${MAX_Y_STEP})`);
    if (!(r.peak > 0.3)) problems.push(`${r.name}: jump only reached ${r.peak.toFixed(3)} m over the standing baseline`);
    if (r.landedAt === null || r.landedAt > 1000) problems.push(`${r.name}: the jump did not return to the standing height within 1 s`);
    // A heading can be deflected by the map itself — CTF-Face's middle is rock, and the
    // clamp slides you along it — so what is asserted is that at least two of the three
    // headings are travelled DEAD ON, and (below) that both pages are deflected by the same
    // amount on the rest. A yaw the controller ignored entirely would fail every heading.
    const aligned = r.yawTest.filter((y) => y.alignment !== null);
    if (aligned.length < 2)
      problems.push(
        `${r.name}: fewer than two headings had room to walk (${r.yawTest.map((y) => `${y.deg}:${y.interrupted ? "respawned" : y.alignment === null ? "blocked" : "ok"}`).join(" ")})`
      );
    if (aligned.filter((y) => y.alignment > 0.98).length < 2)
      problems.push(`${r.name}: fewer than two headings were walked dead on (${aligned.map((y) => `${y.deg}:${y.alignment.toFixed(3)}`).join(" ")})`);
  }

  const [play, index] = results;
  const gaps = {};
  if (!play.failed && !index.failed) {
    const compare = (label, a, b, limit, unit = "m") => {
      const d = Math.abs(a - b);
      gaps[label] = d;
      console.log(`${pad(label, 36)}${col(round(d, 3) + " " + unit, 13)}${d > limit ? "  OVER LIMIT " + limit : ""}`);
      if (d > limit) problems.push(`${label}: the two pages differ by ${d.toFixed(3)} ${unit} (limit ${limit})`);
    };
    console.log("play.html vs index.html");
    console.log("-".repeat(49));
    compare("camera above drawn floor", play.floor, index.floor, 0.02);
    compare("best-window speed", play.bestWindow, index.bestWindow, 0.5, "m/s");
    compare("jump peak", play.peak, index.peak, 0.05);
    compare("time to peak", play.peakAt, index.peakAt, 40, "ms");
    compare("back to standing", play.landedAt, index.landedAt, 40, "ms");
    compare("standing hop baseline", play.baseline, index.baseline, 0.02);
    compare("mean ground speed", play.meanSpeed, index.meanSpeed, 0.5, "m/s");
    for (const deg of YAW_TEST_DEG) {
      const a = play.yawTest.find((y) => y.deg === deg).alignment;
      const b = index.yawTest.find((y) => y.deg === deg).alignment;
      if (a !== null && b !== null) compare(`yaw ${deg} deg heading alignment`, a, b, 0.02, "");
    }
  }

  /* --------------------------------------------------------------------- the rows --
     The detail above is what you read when something is wrong. These are the eight lines
     that say whether the ported player moves like the A-Frame one — the same eight the
     parity table carries. A row is failed by any `problem` that names its subject. */
  const checks = createChecks();
  const clean = (...keys) => !problems.some((p) => keys.some((k) => p.includes(k)));
  const both = (f) => results.map((r) => (r.failed ? "FAILED" : f(r))).join(" / ");
  const gap = (label, unit = "m") => (gaps[label] === undefined ? "" : ` (gap ${round(gaps[label], 3)} ${unit})`);
  checks.row("page loads with no errors", both((r) => (r.errors.length ? `${r.errors.length} errors` : "clean")), clean("page errors", "FAILED"));
  // Both pages are seated by the server, so what can be asserted about a spawn is that
  // applyLocalSpawn put the rig ON the PlayerStart hello named — not near it, and not at
  // the origin, which is where a rig that was never spawned sits.
  const onStart = (r) =>
    r.failed
      ? null
      : Math.min(
          ...[...SPAWNS.red, ...SPAWNS.blue].map((s) => Math.hypot(r.spawn.x - s.x, r.spawn.y - s.y, r.spawn.z - s.z))
        );
  checks.row(
    "spawned on a server PlayerStart (m off)",
    both((r) => round(onStart(r), 2)),
    results.every((r) => onStart(r) !== null && onStart(r) < SPAWN_TOLERANCE)
  );
  checks.row(`ground speed, best ${WINDOW_MS} ms (m/s)`, both((r) => round(r.bestWindow, 2)) + gap("best-window speed", "m/s"), clean("best-window speed"));
  checks.row("no navmesh slingshot (max y step, m)", both((r) => round(r.maxYStep, 3)), clean("y jumped"));
  checks.row("jump peak over baseline (m)", both((r) => round(r.peak, 3)) + gap("jump peak"), clean("jump only reached", "jump peak"));
  checks.row("jump timing up/down (ms)", both((r) => `${round(r.peakAt, 0)}+${r.landedAt === null ? "never" : round(r.landedAt, 0)}`), clean("did not return", "time to peak", "back to standing"));
  checks.row("camera above drawn floor (m)", both((r) => round(r.floor, 3)) + gap("camera above drawn floor"), clean("camera above drawn floor"));
  checks.row("heading follows the yaw", both((r) => `${r.yawTest.filter((y) => y.alignment > 0.98).length}/${YAW_TEST_DEG.length} dead on`), clean("dead on", "room to walk", "heading alignment"));

  return { results, problems, rows: checks.rows };
}

if (isMain(import.meta.url)) {
  const browser = await launchQuiet();
  const { problems, rows } = await runWalk({ browser, base: baseUrl() });
  await browser.close();
  printChecks(rows, { title: "walk" });
  if (problems.length) {
    console.log("\nFAIL\n" + problems.map((p) => `  - ${p}`).join("\n"));
    process.exit(1);
  }
  console.log("\nOK");
}
