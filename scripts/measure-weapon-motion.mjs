// measure-weapon-motion.mjs — how much the held weapon and the eye MOVE per frame.
//
// Answers "does it feel yanky?" when the frame rate is fine: for each weapon, hold the
// trigger, then single-click, and record per frame the morphed mesh's barrel tip and
// centroid projected to the screen, the morph frame showing, the camera roll and height.
// Reports the total excursion, the biggest single-frame jump (a snap the eye reads as a
// pop), how many frames moved more than 20 px, and how far the eye dropped per frame.
//
// What it found on 2026-09-05: the Enforcer restarting 'Shoot' before it finished (73 px
// snap per shot — fixed by FinishAnim cadence and PlayRepeatFiring's 'shot2'), the
// Redeemer's invented idle wrapping six times a second (201 px), the Shock Rifle's 95 px
// hard cut into 'Fire1' (fixed by PlayAnim's tween), and the eye stepping 10-21 cm in one
// frame (fixed by porting PlayerPawn.UpdateEyeHeight's lag). The Sniper Rifle was the
// reference throughout: ~7 px per frame, no restarts.
//
//   npm i -D playwright && npx playwright install chromium     (one-off; ~100 MB of browser)
//   node server/server.js (TLS on 8081) and the static server on 8080 must be running.
//
// HEADED on purpose: the headless shell renders through SwiftShader and its frame times say
// nothing about the GPU a player has. A Chromium window opens for about a minute. Shots are
// driven through the component's own trigger path (`isFiring`), never by calling
// fireBullet() directly, so cadence, FinishAnim and the loop window are all exercised.
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os"; import path from "node:path";
const OUT = path.join(os.tmpdir(), "facingworlds-measure") + path.sep;
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: false, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
await page.goto("http://localhost:8080/", { waitUntil: "load" });
await page.waitForFunction(() => { const el = document.querySelector("[first-person-weapon]"); const c = el && el.components && el.components["first-person-weapon"]; return c && c.primaryEl && c.primaryEl.getObject3D("mesh"); }, null, { timeout: 60000 });
await page.waitForTimeout(1500);
await page.addScriptTag({ content: `
  window.__comp = () => document.querySelector("[first-person-weapon]").components["first-person-weapon"];
  window.__rec = null;
  // Per mesh: centroid of the base geometry and, per morph target, the centroid of its
  // deltas, so the morphed centroid is base + sum(w_i * d_i) without touching every vertex.
  function prep(mesh) {
    if (mesh.__probe) return mesh.__probe;
    const THREE = AFRAME.THREE; const out = [];
    mesh.traverse(o => {
      if (!o.isMesh || !o.geometry) return;
      const pos = o.geometry.attributes.position; const n = pos.count;
      const c = new THREE.Vector3(); for (let i = 0; i < n; i++) c.add(new THREE.Vector3().fromBufferAttribute(pos, i)); c.divideScalar(n);
      // front = the vertex with the smallest z (barrel tip), tracked through morphs
      let fi = 0; for (let i = 1; i < n; i++) if (pos.getZ(i) < pos.getZ(fi)) fi = i;
      const front = new THREE.Vector3().fromBufferAttribute(pos, fi);
      const deltas = (o.geometry.morphAttributes.position || []).map(a => { const d = new THREE.Vector3(); for (let i = 0; i < n; i++) d.add(new THREE.Vector3().fromBufferAttribute(a, i)); d.divideScalar(n); return { c: d, f: new THREE.Vector3().fromBufferAttribute(a, fi) }; });
      out.push({ o, c, front, deltas, n });
    });
    mesh.__probe = out; return out;
  }
  (function loop(t){
    if (window.__rec) {
      const c = window.__comp(); const THREE = AFRAME.THREE;
      const cam = c.el.getObject3D("camera"); cam.updateMatrixWorld(true); cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      const mesh = c.primaryEl.getObject3D("mesh"); const parts = prep(mesh);
      let cx = 0, cy = 0, fx = 0, fy = 0, N = 0, frame = -1, wmax = 0;
      for (const p of parts) {
        const w = p.o.morphTargetInfluences || [];
        const cc = p.c.clone(), ff = p.front.clone();
        w.forEach((wi, i) => { if (wi) { cc.addScaledVector(p.deltas[i].c, wi); ff.addScaledVector(p.deltas[i].f, wi); } if (wi > wmax) { wmax = wi; frame = i; } });
        p.o.updateMatrixWorld(true); cc.applyMatrix4(p.o.matrixWorld).project(cam); ff.applyMatrix4(p.o.matrixWorld).project(cam);
        cx += (cc.x+1)/2*1280 * p.n; cy += (1-cc.y)/2*720 * p.n; fx += (ff.x+1)/2*1280 * p.n; fy += (1-ff.y)/2*720 * p.n; N += p.n;
      }
      window.__rec.push({ t, cx: cx/N, cy: cy/N, fx: fx/N, fy: fy/N, frame, wmax, roll: cam.rotation.z*180/Math.PI, camy: cam.position.y });
    }
    requestAnimationFrame(loop);
  })(0);
`});
const results = {};
// hold: trigger held for `hold` ms; then `clicks` single 60 ms presses spaced `gap` ms
const PLAN = [["enforcer", 2500, 3, 700], ["sniper", 3200, 2, 1800], ["shock", 2400, 3, 1000], ["rocket", 2400, 2, 1300], ["ripper", 2000, 3, 800], ["redeemer", 2600, 1, 2600]];
for (const [id, hold, clicks, gap] of PLAN) {
  await page.evaluate((id) => window.__comp().setWeapon(id), id);
  await page.waitForFunction(() => { const c = window.__comp(); return c.primaryEl.getObject3D("mesh") && c.primaryEl.__slotAnim; }, null, { timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { window.__rec = []; window.__shots = 0; const c = window.__comp(); if (!c.__origFire) { c.__origFire = c.fireBullet.bind(c); c.fireBullet = function () { window.__shots++; window.__rec && window.__rec.push({ shot: true, t: performance.now() }); return c.__origFire(); }; } });
  await page.waitForTimeout(600);
  await page.evaluate(() => { const c = window.__comp(); c._burstShots = 0; c.isFiring = true; });
  await page.waitForTimeout(hold);
  await page.evaluate(() => { window.__comp().isFiring = false; });
  await page.waitForTimeout(900);
  for (let k = 0; k < clicks; k++) {
    await page.evaluate(() => { const c = window.__comp(); c._burstShots = 0; c.isFiring = true; });
    await page.waitForTimeout(60);
    await page.evaluate(() => { window.__comp().isFiring = false; });
    await page.waitForTimeout(gap);
  }
  await page.waitForTimeout(800);
  const r = await page.evaluate(() => { const r = window.__rec; window.__rec = null; return { rec: r.filter((x) => !x.shot), shots: r.filter((x) => x.shot).map((x) => x.t), held: null }; });
  results[id] = { ...r, hold };
}
await browser.close();
fs.writeFileSync(OUT + "motion.json", JSON.stringify(results));

for (const [id, { rec: r, shots, hold }] of Object.entries(results)) {
  const idle = r.filter((s) => s.t < r[0].t + 550);
  const mean = (a, k) => a.reduce((s, x) => s + x[k], 0) / a.length;
  const ifr = { x: mean(idle, "fx"), y: mean(idle, "fy") };
  const excF = Math.max(...r.map((s) => Math.hypot(s.fx - ifr.x, s.fy - ifr.y)));
  let maxJump = 0, at = 0, big = 0, pops = 0;
  for (let i = 1; i < r.length; i++) {
    const j = Math.hypot(r[i].fx - r[i-1].fx, r[i].fy - r[i-1].fy); if (j > maxJump) { maxJump = j; at = i; } if (j > 20) big++;
    if (r[i].frame >= 0 && r[i-1].frame >= 0 && r[i-1].frame - r[i].frame > 1) pops++;
  }
  const heldShots = shots.filter((t) => t < r[0].t + 600 + hold + 50).length;
  const cadence = heldShots > 1 ? ((shots[heldShots - 1] - shots[0]) / (heldShots - 1) / 1000).toFixed(2) : "-";
  let eyeStep = 0, eyeMax = 0; for (let i = 1; i < r.length; i++) { eyeStep = Math.max(eyeStep, Math.abs(r[i].camy - r[i-1].camy)); eyeMax = Math.max(eyeMax, Math.abs(r[i].camy - r[0].camy)); }
  console.log(`${id.padEnd(9)} ${heldShots} shots ${cadence}s apart | gun: excursion ${excF.toFixed(0)}px, max/frame ${maxJump.toFixed(0)}px, frames>20px ${big} | eye: deepest ${(eyeMax*100).toFixed(1)}cm, max/frame ${(eyeStep*100).toFixed(1)}cm | roll max ${Math.max(...r.map(s=>Math.abs(s.roll))).toFixed(1)}deg`);
}
