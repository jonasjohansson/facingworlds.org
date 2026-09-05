// measure-frametimes.mjs — frame times around firing and weapon switches, per phase.
//
// Answers "is it stuttering?": rAF deltas are recorded through idle, a burst on every
// weapon, and a dual-Enforcer burst, then summarised per phase (mean / p95 / max, frames
// over 33 and 100 ms, and WHEN the worst ones landed). Screenshots go beside the numbers.
// The 2026-09-05 run found the only spikes were this script's own page.screenshot() calls.
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
const browser = await chromium.launch({ headless: false, args: ["--autoplay-policy=no-user-gesture-required", "--enable-gpu-rasterization"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
const consoleLines = [];
page.on("console", (m) => { const t = m.text(); if (m.type() === "error" || m.type() === "warning" || /first-person|view|shake|muzzle|Failed|palette/i.test(t)) consoleLines.push(`[${m.type()}] ${t}`); });
page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));
await page.goto("http://localhost:8080/", { waitUntil: "load" });

// wait for the component and a loaded primary mesh
await page.waitForFunction(() => {
  const el = document.querySelector("[first-person-weapon]");
  const c = el && el.components && el.components["first-person-weapon"];
  return c && c.primaryEl && c.primaryEl.getObject3D("mesh");
}, null, { timeout: 60000 });
await page.waitForTimeout(2000);

await page.evaluate(() => {
  window.__frames = []; window.__marks = [];
  let last = performance.now();
  const loop = (t) => { window.__frames.push([t, t - last]); last = t; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  window.__mark = (l) => window.__marks.push([performance.now(), l]);
  window.__comp = () => document.querySelector("[first-person-weapon]").components["first-person-weapon"];
});

const shot = (path) => page.screenshot({ path: OUT + path });
const wait = (ms) => page.waitForTimeout(ms);
const mark = (l) => page.evaluate((l) => window.__mark(l), l);

await mark("idle"); await wait(3000); await shot("00-idle-enforcer.png");

// fire the enforcer for 5 s at its cadence
await mark("fire enforcer");
await page.evaluate(() => { const c = window.__comp(); window.__fireTimer = setInterval(() => c.fireBullet(), 250); });
await wait(1500); await shot("01-fire-enforcer.png"); await wait(3500);
await page.evaluate(() => clearInterval(window.__fireTimer));
await mark("after enforcer"); await wait(1500);

for (const [id, interval] of [["sniper", 1500], ["shock", 700], ["rocket", 900], ["ripper", 300], ["redeemer", 2000]]) {
  await mark(`switch ${id}`);
  await page.evaluate((id) => window.__comp().setWeapon(id), id);
  await page.waitForFunction(() => { const c = window.__comp(); const m = c.primaryEl.getObject3D("mesh"); return m && c.primaryEl.__slotAnim; }, null, { timeout: 20000 });
  await mark(`loaded ${id}`); await wait(1200); await shot(`10-${id}-idle.png`);
  await mark(`fire ${id}`);
  await page.evaluate((iv) => { const c = window.__comp(); c.fireBullet(); window.__fireTimer = setInterval(() => c.fireBullet(), iv); }, interval);
  await wait(120); await shot(`11-${id}-firing.png`); await wait(4000);
  await page.evaluate(() => clearInterval(window.__fireTimer));
  await mark(`after ${id}`); await wait(1000);
}
await mark("switch enforcer"); await page.evaluate(() => window.__comp().setWeapon("enforcer")); await wait(1500);
await mark("dual"); await page.evaluate(() => window.__comp().setDual(true)); await wait(1500); await shot("20-dual.png");
await page.evaluate(() => { const c = window.__comp(); window.__fireTimer = setInterval(() => c.fireBullet(), 125); });
await wait(300); await shot("21-dual-firing.png"); await wait(2000);
await page.evaluate(() => clearInterval(window.__fireTimer));
await wait(500);

const data = await page.evaluate(() => ({ frames: window.__frames, marks: window.__marks }));
fs.writeFileSync(OUT + "frames.json", JSON.stringify(data));
fs.writeFileSync(OUT + "console.txt", consoleLines.join("\n"));

// per-phase stats
const { frames, marks } = data;
const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
console.log("phase".padEnd(18), "frames", "mean".padStart(6), "p95".padStart(6), "max".padStart(7), ">33ms", ">100ms", " worst frames (ms @ +s into phase)");
for (let i = 0; i < marks.length; i++) {
  const [t0, label] = marks[i]; const t1 = marks[i + 1] ? marks[i + 1][0] : Infinity;
  const fs_ = frames.filter(([t]) => t >= t0 && t < t1); const d = fs_.map((f) => f[1]);
  if (!d.length) continue;
  const worst = fs_.slice().sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, dt]) => `${dt.toFixed(0)}@${((t - t0) / 1000).toFixed(2)}`).join(" ");
  console.log(label.padEnd(18), String(d.length).padStart(6), (d.reduce((a, b) => a + b, 0) / d.length).toFixed(1).padStart(6), q(d, 0.95).toFixed(1).padStart(6), Math.max(...d).toFixed(1).padStart(7), String(d.filter((x) => x > 33).length).padStart(5), String(d.filter((x) => x > 100).length).padStart(6), " ", worst);
}
console.log("\nconsole lines:", consoleLines.length);
await browser.close();
