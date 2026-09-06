// effects.mjs — Task 10's probe: does a shot draw what Epic's numbers say it should?
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
// Finally it screenshots the wall hit, the decal it leaves and the shock beam, for the eye.
//
// HEADED, always: the headless shell renders through SwiftShader, which would happily
// "prove" a match that the real driver does not draw (ground rule in
// docs/plans/2026-09-06-three-migration.md).
//
// Usage:
//   node scripts/pw/effects.mjs [outDir]
// Also exported as runEffects({ browser, base, out }) so scripts/pw/parity.mjs can run it
// beside the other probes in one browser and fold its verdict into one table.
import { launchQuiet } from "./launch.mjs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { baseUrl, createChecks, isMain, printChecks } from "./lib.mjs";

const VIEWPORT = { width: 1280, height: 720 };
// What Epic's numbers say a shot must draw, and what the checks below are against.
// ShockRifle.SpawnEffect lays one ShockBeam every 135 UU and ut_RingExplosion5 plays a
// nine-frame 'Explo' — see src/shared/effects.js, generated from BotPack/UnrealShare.
const BEAM_PARTICLES = 40;
const RING_FRAMES = 9;
const SEGMENT_M = 3.17; // 135 UU between ShockBeam segments

export async function runEffects({ browser, base = baseUrl(), out = process.env.SCRATCHPAD || "." } = {}) {
  const OUT = out;
  const BASE = base;
  mkdirSync(OUT, { recursive: true });
  const errors = [];

  const page = await browser.newPage({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console error: ${m.text()}`);
  });
  await page.goto(`${BASE}/index.html`, { waitUntil: "load" });

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
    // The pool is round-robin and the bots' Enforcers throw cases into it too, so the
    // probe follows the slot its own shot is about to take, not the last live one.
    const slot = fx.stats().shellSlot;
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
        y: s.shellY[slot] == null ? null : +s.shellY[slot].toFixed(3),
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
  const shot = path.join(OUT, "fx.png");
  await page.screenshot({ path: shot });

  // The same hits 2.3 s later: the flash (67 ms), the sparks (1 s) and the smoke (1.5 s)
  // have all gone and only UT99's Pock decals are left, which live 18-23 s. This is the
  // pair that shows whether the decal survived r180 — see isModulate() in ut-effects.js.
  await page.waitForTimeout(2300);
  const decal = path.join(OUT, "fx-decal.png");
  await page.screenshot({ path: decal });

  // The Shock beam, held for a frame or two so the segments have shown themselves.
  await page.evaluate(async (p) => {
    const w = window.__fw.systems.get("first-person-weapon");
    window.__fw.player.setPitch(p.pitch);
    w.setWeapon("shock");
    await new Promise((r) => setTimeout(r, 500));
    w.fireBullet();
  }, pose);
  await page.waitForTimeout(120);
  const beam = path.join(OUT, "fx-beam.png");
  await page.screenshot({ path: beam });

  // The camera, for the record, so a screenshot can be placed.
  const cam = await page.evaluate(() => {
    const v = new window.__fw.THREE.Vector3();
    window.__fw.camera.getWorldPosition(v);
    return v.toArray().map((n) => +n.toFixed(3));
  });
  await page.close();

  console.log("pose:", JSON.stringify(pose));
  console.log("camera:", JSON.stringify(cam));
  console.log("shell:", JSON.stringify(shell));
  console.log("volley:", JSON.stringify(volley));
  console.log("shock:", JSON.stringify(shock));
  console.log(shot);
  console.log(decal);
  console.log(beam);
  console.log(errors.length ? errors.join("\n") : "no console errors");

  /* --------------------------------------------------------------------- the rows --
     The detail above is what you read when a shot looks wrong. These are the five lines
     that say a shot draws what Epic's numbers say. */
  const checks = createChecks();
  const P = volley.peak;
  checks.row("the pose aims at a surface ~5 m off", `${pose.aimType} at ${pose.aimDistance} m`, pose.aimType === "world" && Math.abs(pose.aimDistance - 5) < 2);
  checks.row("ten Enforcer shots spend the pools", `impacts ${P.impacts}, smoke ${P.smokes}, sparks ${P.sparks}, shells ${P.shells}, pocks ${volley.pocks}`, P.impacts > 0 && P.smokes > 0 && P.sparks > 0 && P.shells > 0 && volley.pocks > 0);
  // The sign of UE1's gravity, which nothing on screen announces: a case is thrown UP at
  // 3.8-4.9 m/s, peaks around 200 ms, and only then falls.
  checks.row("the ejected shell rises, then falls", `${shell.series.map((s) => s.y).filter((y) => y !== null).length} samples, rose ${shell.rose}, fell ${shell.fell}`, shell.rose && shell.fell);
  // The "long" shot is only long if the level gave it room: it is fired level from wherever
  // the server spawned this client, and at the red base that is a wall 5 m away. Epic lays
  // one segment every SEGMENT_M, so what can be asserted is that a shot with room for two
  // segments draws at least two — a shot with room for one says nothing about the chain.
  const wantSegments = Math.max(1, Math.min(2, Math.floor(shock.longShotDistance / SEGMENT_M)));
  checks.row(
    "shock beam is Epic's chain",
    `${shock.beamParticles} particles, ring ${shock.ringFrames} frames, ${shock.longShotSegments} segment(s) over ${shock.longShotDistance} m (wanted >= ${wantSegments})`,
    shock.beamParticles === BEAM_PARTICLES && shock.ringFrames === RING_FRAMES && shock.longShotSegments >= wantSegments
  );
  checks.row("no page errors", `${errors.length}`, errors.length === 0);

  return { rows: checks.rows, pose, shell, volley, shock, shots: { shot, decal, beam }, errors };
}

if (isMain(import.meta.url)) {
  const browser = await launchQuiet({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const { rows } = await runEffects({ browser, base: baseUrl(), out: process.argv[2] || process.env.SCRATCHPAD || "." });
  await browser.close();
  printChecks(rows, { title: "effects" });
  process.exit(rows.filter((r) => !r.ok).length ? 1 : 0);
}
