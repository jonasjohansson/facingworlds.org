// parity.mjs — the four in-browser checks that say the game is the game, in one run and
// one table.
//
// Task 8 (walk), Task 10 (effects), Task 12 (avatars) and Task 13 (multiplayer) of the
// three.js migration each left a probe behind. Each is worth running alone while its
// subsystem is being worked on — they print their own detail, and that detail is what you
// read when something is wrong. What was missing was the one answer: does the whole of it
// still hold today? So this imports the four runners rather than repeating them, drives
// all four through ONE browser, and prints one pass/fail line per check with the number
// behind it.
//
//   node scripts/pw/parity.mjs [baseUrl]        default http://localhost:8080
//   FW_OUT=/tmp/parity node scripts/pw/parity.mjs      where the screenshots go
//
// Needs both servers: static on 8080 (`npm run dev`) and the game server on 8081
// (`npm run server:tls`). Takes about four minutes.
//
// ORDER MATTERS. multiplayer runs LAST because it finishes by calling game.dispose() on
// the page, and avatars runs after effects because it spawns bodies of its own into the
// registry the server is already filling. Every probe closes the pages it opened.
//
// HEADED, always (launch.mjs): the headless shell renders through SwiftShader, whose frame
// times and rasterisation are not the GPU's — the ground rule in
// docs/plans/2026-09-06-three-migration.md.
import { launchQuiet } from "./launch.mjs";
import { baseUrl, printChecks } from "./lib.mjs";
import { runWalk } from "./walk.mjs";
import { runEffects } from "./effects.mjs";
import { runAvatars } from "./avatars.mjs";
import { runMultiplayer } from "./multiplayer.mjs";

const base = baseUrl();
const out = process.env.FW_OUT || process.env.SCRATCHPAD || "/tmp/facingworlds-parity";

const PROBES = [
  ["walk", "player movement, jump, floor, heading", (browser) => runWalk({ browser, base })],
  ["effects", "a shot's impacts, shell, decal and shock beam", (browser) => runEffects({ browser, base, out })],
  ["avatars", "remote bodies: clips, feet, facing, the hand, hp, fire", (browser) => runAvatars({ browser, base, out })],
  ["multiplayer", "the live 8081 server, and a second tab beside it", (browser) => runMultiplayer({ browser, base })],
];

const browser = await launchQuiet();
const all = [];
for (const [name, what, run] of PROBES) {
  console.log(`\n${"=".repeat(78)}\n${name} — ${what}\n${"=".repeat(78)}`);
  const t0 = Date.now();
  try {
    const { rows } = await run(browser);
    for (const r of rows) all.push({ group: name, ...r });
  } catch (e) {
    // A probe that throws is a failure of the thing it measures, not a reason to skip the
    // other three — the point of running them together is the whole picture.
    console.log(`${name} threw: ${e.stack || e.message}`);
    all.push({ group: name, name: "probe ran to the end", value: e.message, ok: false });
  }
  console.log(`\n(${name}: ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
await browser.close();

const failed = all.filter((r) => !r.ok);
printChecks(all, { title: `PARITY — ${base}`, group: true });
console.log(
  `\n${all.length} checks, ${all.length - failed.length} passed, ${failed.length} failed` +
    (failed.length ? `\n\n${failed.map((r) => `  - ${r.group}: ${r.name} — ${r.value}`).join("\n")}` : "")
);
console.log(`screenshots: ${out}`);
process.exit(failed.length ? 1 : 0);
