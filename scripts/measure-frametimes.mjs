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
// The page is read through the `window.__fw` debug handle. The numbers are only
// meaningful against each other, on the same machine, in the same session.
//
//   node scripts/measure-frametimes.mjs
//
// THE BOT COUNT IS PART OF THE MEASUREMENT. The 8.3 ms baseline was taken with a full
// roster, and the server fills one bot per side per 3 s sweep, so the probe waits for the
// roster before it starts recording and prints what it got. Run one measurement at a
// time: two connected humans is two fewer bots each (server/bots.js —
// BOTS_MIN_PER_TEAM 5, BOTS_MAX 10, so one human is served nine bots).
//
// HEADED on purpose: the headless shell renders through SwiftShader and its frame times say
// nothing about the GPU a player has. A Chromium window opens for about a minute. Shots are
// driven through the component's own trigger path (`isFiring`), never by calling
// fireBullet() directly, so cadence, FinishAnim and the loop window are all exercised.
import { launchQuiet } from "./pw/launch.mjs";
import fs from "node:fs";
import os from "node:os"; import path from "node:path";

const BASE = (process.env.FW_BASE || "http://localhost:8080").replace(/\/$/, "");
// Nine is what one human is served by a default server (BOTS_MIN_PER_TEAM 5 per side, one
// of the ten slots taken by us). Waiting for it is what makes the two runs comparable.
const WANT_BOTS = Number(process.env.FW_BOTS || 9);
const BOT_WAIT_MS = 90000; // ~15 s of sweeps at full speed; long enough for a slow join

/* ------------------------------------------------------------------- page adapter --
   SELF-CONTAINED functions: they are stringified into the page, so they may not close
   over anything out here. */
const adapter = {
  url: `${BASE}/index.html`,
  // The gun in hand. `primarySlot` is the permanent Object3D the weapon dresses;
  // userData.mesh is what attachModel hung on it.
  ready: () => {
    const c = window.__fw && window.__fw.systems.get("first-person-weapon");
    return !!(c && c.primarySlot && c.primarySlot.userData.mesh);
  },
  install: () => {
    window.__comp = () => window.__fw.systems.get("first-person-weapon");
    window.__slotLoaded = () => {
      const c = window.__comp();
      return !!(c.primarySlot.userData.mesh && c.primarySlot.userData.anim);
    };
    window.__bots = () => {
      const r = window.__fw.systems.get("remote-avatars");
      return r ? r.avatars.size : 0;
    };
    window.__renderer = () => window.__fw.renderer;
  },
};

const name = "index.html";
const OUT = path.join(os.tmpdir(), "facingworlds-measure") + path.sep;
fs.mkdirSync(OUT, { recursive: true });
const browser = await launchQuiet({args: ["--autoplay-policy=no-user-gesture-required", "--enable-gpu-rasterization"]});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
const consoleLines = [];
page.on("console", (m) => { const t = m.text(); if (m.type() === "error" || m.type() === "warning" || /first-person|view|shake|muzzle|Failed|palette/i.test(t)) consoleLines.push(`[${m.type()}] ${t}`); });
page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));
await page.goto(adapter.url, { waitUntil: "load" });

await page.waitForFunction(adapter.ready, null, { timeout: 60000 });
await page.evaluate(adapter.install);

// The roster. This has to be the same number on every run or the frame times are
// measuring the roster.
const bots = await page
  .waitForFunction((want) => window.__bots() >= want, WANT_BOTS, { timeout: BOT_WAIT_MS, polling: 500 })
  .then(() => page.evaluate(() => window.__bots()))
  .catch(() => page.evaluate(() => window.__bots()));
console.log(`${name}: ${bots} remote bodies on the map (wanted ${WANT_BOTS})`);
await page.waitForTimeout(2000);

await page.evaluate(() => {
  window.__frames = []; window.__marks = [];
  let last = performance.now();
  const loop = (t) => { window.__frames.push([t, t - last]); last = t; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  window.__mark = (l) => window.__marks.push([performance.now(), l]);
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
  await page.waitForFunction(() => window.__slotLoaded(), null, { timeout: 20000 });
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

// What the renderer is actually asked to do PER FRAME — the first place to look when a
// run is slower than the last. renderer.info resets itself on every render() call, and
// with the bloom composer there are several of those a frame, so the counters are frozen
// (autoReset = false) and accumulated over a second, then divided by the frames counted.
const rinfo = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const r = window.__renderer();
      r.info.autoReset = false;
      r.info.reset();
      let n = 0;
      const tick = () => {
        n++;
        if (n < 60) return requestAnimationFrame(tick);
        const i = r.info;
        r.info.autoReset = true;
        resolve({ frames: n, calls: i.render.calls / n, triangles: i.render.triangles / n, programs: i.programs.length, geometries: i.memory.geometries, textures: i.memory.textures });
      };
      requestAnimationFrame(tick);
    })
);
const data = await page.evaluate(() => ({ frames: window.__frames, marks: window.__marks }));
fs.writeFileSync(OUT + "frames.json", JSON.stringify(data));
fs.writeFileSync(OUT + "console.txt", consoleLines.join("\n"));

// per-phase stats
const { frames, marks } = data;
const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
console.log("");
console.log(`${name} — ${bots} bots`);
console.log("phase".padEnd(18), "frames", "mean".padStart(6), "p95".padStart(6), "max".padStart(7), ">33ms", ">100ms", " worst frames (ms @ +s into phase)");
const all = [];
for (let i = 0; i < marks.length; i++) {
  const [t0, label] = marks[i]; const t1 = marks[i + 1] ? marks[i + 1][0] : Infinity;
  const fs_ = frames.filter(([t]) => t >= t0 && t < t1); const d = fs_.map((f) => f[1]);
  if (!d.length) continue;
  all.push(...d);
  const worst = fs_.slice().sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, dt]) => `${dt.toFixed(0)}@${((t - t0) / 1000).toFixed(2)}`).join(" ");
  console.log(label.padEnd(18), String(d.length).padStart(6), (d.reduce((a, b) => a + b, 0) / d.length).toFixed(1).padStart(6), q(d, 0.95).toFixed(1).padStart(6), Math.max(...d).toFixed(1).padStart(7), String(d.filter((x) => x > 33).length).padStart(5), String(d.filter((x) => x > 100).length).padStart(6), " ", worst);
}
console.log("ALL".padEnd(18), String(all.length).padStart(6), (all.reduce((a, b) => a + b, 0) / all.length).toFixed(1).padStart(6), q(all, 0.95).toFixed(1).padStart(6), Math.max(...all).toFixed(1).padStart(7), String(all.filter((x) => x > 33).length).padStart(5), String(all.filter((x) => x > 100).length).padStart(6));
console.log(`\nper frame: ${rinfo.calls.toFixed(0)} draw calls, ${Math.round(rinfo.triangles).toLocaleString("en-US")} triangles | ${rinfo.programs} programs, ${rinfo.geometries} geometries, ${rinfo.textures} textures`);
console.log("console lines:", consoleLines.length);
await browser.close();
