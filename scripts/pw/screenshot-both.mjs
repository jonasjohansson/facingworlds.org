// screenshot-both.mjs — the parity shot: index.html (A-Frame) next to play.html (three).
//
// HEADED, always. SwiftShader renders a different, dimmer scene than the real GPU driver
// and would happily "prove" a lighting match that does not exist (ground rule in
// docs/plans/2026-09-06-three-migration.md).
//
// index.html spawns the player somewhere on the navmesh; play.html has no player yet, so
// the camera sits at the origin looking down -Z. To compare the same view, we read
// #cam's world pose out of the A-Frame page first and plant play.html's camera on it.
//
// Usage: node scripts/pw/screenshot-both.mjs [outDir]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const OUT = process.argv[2] || process.env.SCRATCHPAD || ".";
const BASE = process.env.FW_BASE || "http://localhost:8080";
const SETTLE_MS = 6000;
const VIEWPORT = { width: 1280, height: 720 };

mkdirSync(OUT, { recursive: true });
const shotIndex = path.join(OUT, "shot-index.png");
const shotPlay = path.join(OUT, "shot-play.png");

const browser = await chromium.launch({ headless: false });

// --- index.html: the reference ---------------------------------------------------
const refPage = await browser.newPage({ viewport: VIEWPORT });
await refPage.goto(`${BASE}/index.html`);
await refPage.waitForTimeout(SETTLE_MS);
const pose = await refPage.evaluate(() => {
  // Strip everything play.html does not have yet, so the shots differ only in the map:
  // the HUD and the prompt are DOM, the view weapon is a child of #cam.
  // !important, because several of the HUD's own rules in styles.css are !important.
  for (const el of document.body.children) {
    if (el.tagName !== "A-SCENE") el.style.setProperty("display", "none", "important");
  }
  const cam = document.querySelector("#cam");
  if (cam && cam.object3D) {
    for (const child of cam.object3D.children) if (!child.isCamera) child.visible = false;
  }
  if (!cam || !cam.object3D) return null;
  const THREE = window.AFRAME.THREE;
  const camObj = cam.getObject3D("camera");
  camObj.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  // Position AND orientation, straight off the matrix: lookAt() would drop view-shake's
  // roll, and roll is one of the things this comparison is meant to catch.
  camObj.matrixWorld.decompose(p, q, s);
  return {
    position: p.toArray(),
    quaternion: q.toArray(),
    fov: camObj.fov,
    aspect: camObj.aspect,
    near: camObj.near,
    far: camObj.far,
  };
});
await refPage.screenshot({ path: shotIndex });
await refPage.close();

// --- play.html: the port ---------------------------------------------------------
const errors = [];
const page = await browser.newPage({ viewport: VIEWPORT });
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/play.html`);
await page.waitForTimeout(SETTLE_MS);
if (pose) {
  await page.evaluate((p) => {
    const cam = window.__fw.camera;
    cam.position.fromArray(p.position);
    cam.quaternion.fromArray(p.quaternion);
    cam.fov = p.fov;
    cam.aspect = p.aspect;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }, pose);
  await page.waitForTimeout(500);
}
await page.screenshot({ path: shotPlay });

const info = await page.evaluate(() => {
  const g = window.__fw;
  const lights = [];
  g.scene.traverse((o) => {
    if (o.isLight) lights.push(`${o.type}(${o.intensity})`);
  });
  return {
    frame: g.renderer.info.render.frame,
    calls: g.renderer.info.render.calls,
    triangles: g.renderer.info.render.triangles,
    lights: lights.length,
    systems: [...g.systems.keys()],
    environment: !!g.scene.environment,
    tier: g.qualityTier,
  };
});
await browser.close();

console.log("camera pose from index.html:", JSON.stringify(pose));
console.log("play.html:", JSON.stringify(info));
console.log(shotIndex);
console.log(shotPlay);
console.log(errors.length ? errors.join("\n") : "no console errors");
