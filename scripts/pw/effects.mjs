// effects.mjs — Task 10's probe: does a shot on play.html draw what a shot on index.html
// draws?
//
// It plants the player looking at a surface about five metres away (found by sweeping the
// yaw and pitch circle from wherever the spawn put them), fires the Enforcer ten
// times, and reads the ut-effects pools through the system's own stats(): how many
// BulletImpact / smoke / spark / pock / shell slots the shots actually spent. Then it
// watches ONE ejected shell fall — the sign of `gravityMPerSec2` is UE1's and is negative,
// and getting it wrong sends every case up into the ceiling, which nothing on screen
// announces — and fires the Shock Rifle once to check the beam is forty sprites and the
// ring carries UTRingex's nine-frame Explo.
//
// Finally it screenshots the same wall hit on both pages, from the same world pose, so the
// impact sprite size, the smoke, the decal and the beam can be compared by eye.
//
// HEADED, always: the headless shell renders through SwiftShader, which would happily
// "prove" a match that the real driver does not draw (ground rule in
// docs/plans/2026-09-06-three-migration.md).
//
// Usage: node scripts/pw/effects.mjs [outDir]
import { launchQuiet } from "./launch.mjs";
import { mkdirSync } from "node:fs";
import path from "node:path";

const OUT = process.argv[2] || process.env.SCRATCHPAD || ".";
const BASE = process.env.FW_BASE || "http://localhost:8080";
const VIEWPORT = { width: 1280, height: 720 };
mkdirSync(OUT, { recursive: true });

const browser = await launchQuiet({ args: ["--autoplay-policy=no-user-gesture-required"] });
const errors = [];

// ---------------------------------------------------------------------------
// play.html — the port
// ---------------------------------------------------------------------------
const page = await browser.newPage({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console error: ${m.text()}`);
});
await page.goto(`${BASE}/play.html`, { waitUntil: "load" });

// The gun in hand AND every effect asset landed: the pools are built as the glTFs arrive,
// so a shot fired before them draws the procedural fallback and proves nothing.
await page.waitForFunction(
  () => {
    const g = window.__fw;
    const w = g && g.systems.get("first-person-weapon");
    const fx = g && g.systems.get("ut-effects");
    if (!w || !w.primarySlot || !w.primarySlot.userData.mesh || !fx) return false;
    const s = fx.stats();
    return s.models.length >= 4 && s.size.impacts > 0 && s.size.smokes > 0 && s.size.sparks > 0 && s.size.shells > 0;
  },
  null,
  { timeout: 60000 }
);
await page.waitForTimeout(1000);

// Count every sound that actually plays, by file. The wall hit's four-way roll goes
// through the module-level playAt(), not the system method, so wrapping the method would
// see nothing; HTMLMediaElement.play is where all of them end up.
await page.evaluate(() => {
  window.__sounds = {};
  const orig = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const name = String(this.src || "").split("/").pop();
    window.__sounds[name] = (window.__sounds[name] || 0) + 1;
    return orig.apply(this, arguments);
  };
});

// Point at a surface about five metres off. The spawn is on open tower top, where the
// nearest WALL is 67 m away, so the scan sweeps pitch as well as yaw and keeps whatever
// world hit lands closest to 5 m — in practice the floor a few metres ahead, which frames
// the impact, the smoke and the decal just as squarely as a wall does.
const pose = await page.evaluate(() => {
  const g = window.__fw;
  const w = g.systems.get("first-person-weapon");
  const THREE = g.THREE;
  const origin = new THREE.Vector3();
  g.camera.getWorldPosition(origin);
  const dir = new THREE.Vector3();
  let best = null;
  for (let i = 0; i < 72; i++) {
    const yaw = (i / 72) * Math.PI * 2;
    for (let j = 0; j <= 12; j++) {
      const pitch = -j * (Math.PI / 180) * 5; // 0 to -60 degrees
      // The rig turns about Y and the head about X, so this is where setYaw/setPitch look.
      const cp = Math.cos(pitch);
      dir.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
      const r = w.traceShot(origin, dir);
      if (r.type !== "world") continue;
      const err = Math.abs(r.distance - 5);
      if (!best || err < best.err) best = { yaw, pitch, err, distance: r.distance };
    }
  }
  const p = g.rig.position;
  g.player.setYaw(best.yaw);
  g.player.setPitch(best.pitch);
  g.camera.updateMatrixWorld(true);
  const look = new THREE.Vector3();
  g.camera.getWorldDirection(look);
  const hit = w.traceShot(origin, look);
  return {
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: best.yaw,
    pitch: best.pitch,
    scanDistance: +best.distance.toFixed(3),
    // What the crosshair actually reaches once the pose is applied — the scan is only
    // right if these two agree.
    aimDistance: +hit.distance.toFixed(3),
    aimType: hit.type,
  };
});
await page.waitForTimeout(300);

// ---- one shot, and the shell it throws --------------------------------------
const shell = await page.evaluate(async () => {
  const g = window.__fw;
  const w = g.systems.get("first-person-weapon");
  const fx = g.systems.get("ut-effects");
  w.setWeapon("enforcer");
  await new Promise((r) => setTimeout(r, 400)); // let the bring-up animation finish
  const before = fx.stats().live.shells;
  w.fireBullet();
  // 600 ms, because a UT_ShellCase is thrown UP at 3.8-4.9 m/s first: under UE1's
  // -22.325 m/s^2 it peaks around 200 ms and only then falls. A series that rises and
  // keeps rising is the sign-of-gravity bug this sample exists to catch.
  const t0 = performance.now();
  const series = [];
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 50));
    const s = fx.stats();
    series.push({
      t: Math.round(performance.now() - t0),
      y: s.shellY.length ? +s.shellY[s.shellY.length - 1].toFixed(3) : null,
    });
  }
  const ys = series.map((p) => p.y).filter((y) => y !== null);
  return { before, series, rose: Math.max(...ys) > ys[0], fell: ys[ys.length - 1] < Math.max(...ys) };
});

// Let that shell die (3 s lifespan) so the volley below starts from an empty pool.
await page.waitForTimeout(3200);

// ---- ten Enforcer shots at 250 ms -------------------------------------------
const volley = await page.evaluate(async () => {
  const g = window.__fw;
  const w = g.systems.get("first-person-weapon");
  const fx = g.systems.get("ut-effects");
  window.__sounds = {};
  const peak = { beams: 0, rings: 0, impacts: 0, smokes: 0, sparks: 0, shells: 0, pocks: 0 };
  for (let i = 0; i < 10; i++) {
    w.fireBullet();
    // Immediately: BulletImpact is one 67 ms frame of flash and is gone long before the
    // next shot, so a sample taken only at the end of the interval always reads zero.
    let live = fx.stats().live;
    for (const k of Object.keys(peak)) peak[k] = Math.max(peak[k], live[k]);
    await new Promise((r) => setTimeout(r, 250));
    live = fx.stats().live;
    for (const k of Object.keys(peak)) peak[k] = Math.max(peak[k], live[k]);
  }
  const s = fx.stats();
  return { peak, live: s.live, size: s.size, pocks: s.live.pocks, sounds: { ...window.__sounds } };
});

// ---- the Shock Rifle: forty sprites and a nine-frame ring --------------------
const shock = await page.evaluate(async () => {
  const g = window.__fw;
  const w = g.systems.get("first-person-weapon");
  const fx = g.systems.get("ut-effects");
  w.setWeapon("shock");
  await new Promise((r) => setTimeout(r, 500));
  window.__sounds = {};
  w.fireBullet();
  // The shockexplo light is a one-tick actor (SHOCK_LIGHT_LIFE 0.1 s), so it is read on
  // the spawning frame; the beam segments show themselves 0.05 s apart, so they are
  // counted after the chain has had time to appear.
  const atSpawn = fx.stats();
  await new Promise((r) => setTimeout(r, 120));
  const s = fx.stats();

  // And one LONG shot, level, so the chain is more than one segment: Epic lays a segment
  // every 3.17 m, so a 5 m shot is a single one and says nothing about the chain.
  g.player.setPitch(0);
  await new Promise((r) => requestAnimationFrame(r));
  const far = w.traceShot(
    g.camera.getWorldPosition(new g.THREE.Vector3()),
    g.camera.getWorldDirection(new g.THREE.Vector3())
  );
  w.fireBullet();
  await new Promise((r) => setTimeout(r, 260));
  const long = fx.stats();
  return {
    beamParticles: s.beamParticles,
    ringFrames: s.ringFrames,
    liveBeams: s.live.beams,
    liveRings: s.live.rings,
    lightAtSpawn: +atSpawn.lightIntensity.toFixed(2),
    longShotDistance: +far.distance.toFixed(2),
    longShotSegments: long.live.beams,
    sounds: { ...window.__sounds },
  };
});

// ---- the screenshot: a fresh Enforcer wall hit -------------------------------
// Re-aim first: the long shock shot above levelled the pitch, and at 400 m the shot
// reaches nothing at all — the screenshot has to show the surface the pose was chosen for.
await page.evaluate(async (p) => {
  const w = window.__fw.systems.get("first-person-weapon");
  window.__fw.player.setPitch(p.pitch);
  w.setWeapon("enforcer");
  await new Promise((r) => setTimeout(r, 500));
  for (let i = 0; i < 3; i++) {
    w.fireBullet();
    await new Promise((r) => setTimeout(r, 60));
  }
}, pose);
await page.waitForTimeout(70);
const shotPlay = path.join(OUT, "fx-play.png");
await page.screenshot({ path: shotPlay });

// The same hits 2.3 s later: the flash (67 ms), the sparks (1 s) and the smoke (1.5 s)
// have all gone and only UT99's Pock decals are left, which live 18-23 s. This is the
// pair that shows whether the decal survived r180 — see isModulate() in ut-effects.js.
await page.waitForTimeout(2300);
const decalPlay = path.join(OUT, "fx-play-decal.png");
await page.screenshot({ path: decalPlay });

// The Shock beam, held for a frame or two so the segments have shown themselves.
await page.evaluate(async (p) => {
  const w = window.__fw.systems.get("first-person-weapon");
  window.__fw.player.setPitch(p.pitch);
  w.setWeapon("shock");
  await new Promise((r) => setTimeout(r, 500));
  w.fireBullet();
}, pose);
await page.waitForTimeout(120);
const beamPlay = path.join(OUT, "fx-play-beam.png");
await page.screenshot({ path: beamPlay });

// ---------------------------------------------------------------------------
// index.html — the A-Frame reference, planted on the same world pose
// ---------------------------------------------------------------------------
const ref = await browser.newPage({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
const refErrors = [];
ref.on("pageerror", (e) => refErrors.push(`pageerror: ${e.message}`));
await ref.goto(`${BASE}/index.html`, { waitUntil: "load" });
await ref.waitForFunction(
  () => {
    const cam = document.querySelector("#cam");
    const c = cam && cam.components && cam.components["first-person-weapon"];
    return !!(c && c.el.sceneEl.systems["ut-effects"]);
  },
  null,
  { timeout: 60000 }
);
await ref.waitForTimeout(6000);

await ref.evaluate((p) => {
  const rig = document.querySelector("#rig");
  rig.setAttribute("position", `${p.x} ${p.y} ${p.z}`);
  // look-controls owns the view rotation and rewrites it every frame from these two
  // objects, so setting the entity's rotation would last exactly one tick.
  //
  // AND THE YAW IS SPLIT IN TWO HERE, which play.html's is not. index.html's rig carries
  // the spawn heading the server sent (rig.rotation.y, about -1.43 rad at the blue base)
  // and look-controls adds its own on the CAMERA, so the world yaw is the sum. The three
  // build puts the whole yaw on the rig (player/controller.js setYaw), so the reference
  // page has to be given the difference or the two screenshots look in different
  // directions from the same point.
  const cam = document.querySelector("#cam");
  const lc = cam.components["look-controls"];
  if (lc) {
    lc.yawObject.rotation.y = p.yaw - rig.object3D.rotation.y;
    lc.pitchObject.rotation.x = p.pitch;
  }
}, pose);
await ref.waitForTimeout(600);

const refInfo = await ref.evaluate(async (p) => {
  const cam = document.querySelector("#cam");
  const c = cam.components["first-person-weapon"];
  const camObj = cam.getObject3D("camera");
  camObj.updateMatrixWorld(true);
  const pos = new AFRAME.THREE.Vector3();
  camObj.getWorldPosition(pos);
  for (let i = 0; i < 3; i++) {
    c.fireBullet();
    await new Promise((r) => setTimeout(r, 60));
  }
  return { camera: pos.toArray().map((v) => +v.toFixed(3)) };
}, pose);
await ref.waitForTimeout(70);
const shotIndex = path.join(OUT, "fx-index.png");
await ref.screenshot({ path: shotIndex });

await ref.waitForTimeout(2300);
const decalIndex = path.join(OUT, "fx-index-decal.png");
await ref.screenshot({ path: decalIndex });

await ref.evaluate(async () => {
  const c = document.querySelector("#cam").components["first-person-weapon"];
  c.setWeapon("shock");
  await new Promise((r) => setTimeout(r, 500));
  c.fireBullet();
});
await ref.waitForTimeout(120);
const beamIndex = path.join(OUT, "fx-index-beam.png");
await ref.screenshot({ path: beamIndex });

// The play.html camera, for the record: the two screenshots are only comparable if the
// two cameras ended up in the same place.
const playCam = await page.evaluate(() => {
  const v = new window.__fw.THREE.Vector3();
  window.__fw.camera.getWorldPosition(v);
  return v.toArray().map((n) => +n.toFixed(3));
});

await browser.close();

console.log("pose:", JSON.stringify(pose));
console.log("camera play/index:", JSON.stringify(playCam), JSON.stringify(refInfo.camera));
console.log("shell:", JSON.stringify(shell));
console.log("volley:", JSON.stringify(volley));
console.log("shock:", JSON.stringify(shock));
console.log(shotPlay);
console.log(decalPlay);
console.log(beamPlay);
console.log(shotIndex);
console.log(decalIndex);
console.log(beamIndex);
console.log("play.html:", errors.length ? errors.join("\n") : "no console errors");
console.log("index.html:", refErrors.length ? refErrors.join("\n") : "no page errors");
