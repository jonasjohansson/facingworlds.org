// Smoke test for play.html: loads it headed, collects console errors, checks that the
// renderer is producing frames. Usage: node scripts/pw/smoke.mjs [url]
import { chromium } from "playwright";
const url = process.argv[2] || "http://localhost:8080/play.html";
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`); });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(url);
await page.waitForTimeout(4000);
const info = await page.evaluate(() => {
  const g = window.__fw;
  if (!g) return { fw: false };
  return { fw: true, frame: g.renderer.info.render.frame, systems: [...g.systems.keys()], children: g.scene.children.length };
});
console.log(JSON.stringify(info));
console.log(errors.length ? errors.join("\n") : "no console errors");
await browser.close();
process.exit(info.fw && info.frame > 10 && !errors.some((e) => e.startsWith("pageerror")) ? 0 : 1);
