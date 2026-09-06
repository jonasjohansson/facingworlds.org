// pickups.mjs — the pickups/CTF probe.
//
// HEADED, always (docs/plans/2026-09-06-three-migration.md ground rules): SwiftShader
// renders a different, dimmer scene than the real driver and would happily "prove" a
// match that does not exist.
//
// The running 8081 server feeds the page `pickups-init` and `ctf-init` through
// network.js, so the probe waits for both systems to fill, checks what they built
// against the generated tables (src/shared/map-actors.js), plants two camera poses on
// the BLUE base and screenshots each, and then exercises the event contract with
// synthetic messages in the server's own shapes.
//
// Usage: node scripts/pw/pickups.mjs [outDir]
//   needs `npm run dev` (8080) and `npm run server:tls` (8081).
import { launchQuiet } from "./launch.mjs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { FLAG_HOMES } from "../../src/shared/map-actors.js";

const OUT = process.argv[2] || process.env.SCRATCHPAD || ".";
const BASE = process.env.FW_BASE || "http://localhost:8080";
const VIEWPORT = { width: 1280, height: 720 };

mkdirSync(OUT, { recursive: true });
// Two poses at the BLUE base, both found by sweeping the map rather than guessed —
// FlagBase1 sits in an alcove inside the tower and almost every line to it is blocked
// by the base's own columns.
//
//   flag    the flag, its lit stand and the ring, from the one clear line into the alcove
//   items   the Shock Rifle, its two Shock Cores and a MedBox in the room above it
const BLUE_HOME = FLAG_HOMES.blue;
const SHOCK = { x: -75.31, y: -1.02, z: 8.97 };
const POSES = [
  { name: "flag", eye: { x: BLUE_HOME.x + 5, y: BLUE_HOME.y + 1.6, z: BLUE_HOME.z }, look: { x: BLUE_HOME.x, y: BLUE_HOME.y + 1.2, z: BLUE_HOME.z } },
  { name: "items", eye: { x: SHOCK.x + 4, y: SHOCK.y + 1.8, z: SHOCK.z + 4 }, look: { x: SHOCK.x, y: SHOCK.y + 0.5, z: SHOCK.z } },
];
const shotPath = (pose) => path.join(OUT, `pickups-${pose}.png`);

const fail = [];
const check = (ok, label) => {
  console.log(`${ok ? "  ok" : "FAIL"}  ${label}`);
  if (!ok) fail.push(label);
};

const browser = await launchQuiet({ args: ["--ignore-certificate-errors"] });

// ---------------------------------------------------------------------------
// 1. The page, with the real server behind it.
// ---------------------------------------------------------------------------
const errors = [];
const page = await browser.newPage({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/index.html`);
await page.waitForFunction(() => window.__fw && window.__fw.world && window.__fw.systems.has("quality-tier"), {
  timeout: 30000,
});
// The server's `hello` carries the pickup table and the flags; both systems are empty
// until it lands.
const fed = await page
  .waitForFunction(
    () => {
      const g = window.__fw;
      const p = g.systems.get("weapon-pickup");
      const c = g.systems.get("ctf-flag");
      return !!(p && c && p.items.size > 0 && c.flags.size === 2 && c.myTeam);
    },
    null,
    { timeout: 30000 }
  )
  .then(() => true)
  .catch(() => false);
if (!fed) {
  console.error("no pickups arrived — is `npm run server:tls` running on 8081?");
  await browser.close();
  process.exit(1);
}
// The pointer-lock prompt and the credits are DOM; the shots are of what the engine draws.
await page.evaluate(() => {
  for (const el of document.body.children) {
    if (el.tagName !== "CANVAS") el.style.setProperty("display", "none", "important");
  }
});

const built = await page.evaluate(async () => {
  const game = window.__fw;
  await game.systems.get("weapon-pickup").ready();

  const THREE = game.THREE;
  const pickups = game.systems.get("weapon-pickup");
  const ctf = game.systems.get("ctf-flag");

  const withMesh = [...pickups.items.values()].filter((i) => {
    let meshes = 0;
    i.node.traverse((o) => {
      if (o.isMesh) meshes++;
    });
    return meshes > 0;
  }).length;

  const glows = [];
  game.scene.traverse((o) => {
    if (o.isPointLight && o.distance > 18 && o.distance < 19) {
      glows.push({ color: `#${o.color.getHexString()}`, world: o.getWorldPosition(new THREE.Vector3()).toArray() });
    }
  });

  return {
    myTeam: ctf.myTeam,
    pickups: [...pickups.items.values()].map((i) => ({ ...i.data, available: i.available })),
    pickupNodes: pickups.items.size,
    withMesh,
    underWorld: [...pickups.items.values()].every((i) => i.node.parent === game.world),
    stands: [...ctf.stands.entries()].map(([team, s]) => ({ team, position: s.node.position.toArray() })),
    flags: [...ctf.flags.entries()].map(([team, f]) => ({
      team,
      state: f.state,
      position: f.node.position.toArray(),
      visible: f.group.visible,
    })),
    glows,
  };
});
console.log(`${built.pickupNodes} pickups, ${built.flags.length} flags, team ${built.myTeam}`);

// Plant the poses and take the shots BEFORE any of the mutation checks below move a flag.
for (const pose of POSES) {
  await page.evaluate((p) => {
    const game = window.__fw;
    const cam = game.camera;
    // The player controller parents the camera to the rig's head and writes the view
    // shake into its local transform every frame. Lift it out to the scene root (where
    // local IS world) and freeze its matrix, so the planted pose is the one rendered.
    if (cam.parent !== game.scene) game.scene.add(cam);
    cam.matrixAutoUpdate = false;
    cam.position.set(p.eye.x, p.eye.y, p.eye.z);
    cam.lookAt(p.look.x, p.look.y, p.look.z);
    cam.updateMatrix();
    cam.updateMatrixWorld(true);
  }, pose);
  await page.waitForTimeout(600);
  await page.screenshot({ path: shotPath(pose.name) });
}

// ---------------------------------------------------------------------------
// 2. The event contract, with synthetic messages in the server's own shapes.
// ---------------------------------------------------------------------------
const events = await page.evaluate(
  async ({ built, homes }) => {
    const game = window.__fw;
    const ctf = game.systems.get("ctf-flag");
    const pickups = game.systems.get("weapon-pickup");
    const out = {};

    // A flag taken by SOMEONE ELSE: state carried, the snapshot position ignored, the
    // mesh still visible (it is only hidden when the local player is the carrier).
    const enemy = built.flags.find((f) => f.team !== built.myTeam) || built.flags[0];
    const before = ctf.flags.get(enemy.team).node.position.toArray();
    const home = [homes[enemy.team].x, homes[enemy.team].y, homes[enemy.team].z];
    game.events.emit("flag-update", {
      team: enemy.team,
      state: "carried",
      x: 0,
      y: 0,
      z: 0,
      carrier: "ghost",
      isMine: false,
      myTeam: built.myTeam,
    });
    const carried = ctf.flags.get(enemy.team);
    out.carriedState = carried.state;
    out.carriedIgnoredSnapshot = JSON.stringify(carried.node.position.toArray()) === JSON.stringify(before);
    out.carriedStillDrawn = carried.group.visible;

    // The same flag dropped out on the bridge: authoritative position, tipped over.
    game.events.emit("flag-update", {
      team: enemy.team,
      state: "dropped",
      x: 11.52,
      y: 13.13,
      z: -9.17,
      carrier: null,
      isMine: false,
      myTeam: built.myTeam,
    });
    out.droppedAt = carried.node.position.toArray();
    out.droppedTiltDeg = (carried.node.rotation.x * 180) / Math.PI;

    // And home again: upright, square to the world.
    game.events.emit("flag-update", {
      team: enemy.team,
      state: "home",
      x: home[0],
      y: home[1],
      z: home[2],
      carrier: null,
      isMine: false,
      myTeam: built.myTeam,
    });
    out.homeAgainAt = carried.node.position.toArray();
    out.homeAgainRot = carried.node.rotation.toArray().slice(0, 3);

    // A pickup taken and respawned.
    const id = built.pickups[0].id;
    game.events.emit("pickup-taken", { id, by: "ghost", respawnInMs: 30000 });
    out.takenHidden = !pickups.items.get(id).node.visible;
    game.events.emit("pickup-respawn", { id });
    out.respawnShown = pickups.items.get(id).node.visible;

    // The proximity sweep: stand the rig on a pickup and on the enemy flag and listen for
    // the asks.
    const asks = [];
    game.events.on("request-pickup", (e) => asks.push(`pickup:${e.detail.id}`));
    game.events.on("request-flag-touch", (e) => asks.push(`flag:${e.detail.team}`));
    const p0 = built.pickups[0];
    game.rig.position.set(p0.x, p0.y, p0.z);
    pickups.checkLocalPlayer(performance.now() + 10000);
    game.rig.position.set(home[0], home[1], home[2]);
    ctf.lastClaim = 0;
    ctf.update(0.016, performance.now() + 20000);
    out.asks = asks;

    return out;
  },
  { built, homes: FLAG_HOMES }
);

const info = await page.evaluate(() => {
  const g = window.__fw;
  return {
    frame: g.renderer.info.render.frame,
    calls: g.renderer.info.render.calls,
    triangles: g.renderer.info.render.triangles,
    systems: [...g.systems.keys()],
  };
});
await browser.close();

// ---------------------------------------------------------------------------
// 3. The report.
// ---------------------------------------------------------------------------
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const nearArr = (a, b, eps = 0.01) => a.length === b.length && a.every((v, i) => near(v, b[i], eps));
const byTeam = (rows) => Object.fromEntries(rows.map((r) => [r.team, r]));

console.log("\n--- nodes ---");
check(built.pickupNodes > 0, `${built.pickupNodes} pickup nodes`);
check(built.withMesh === built.pickupNodes, `${built.withMesh}/${built.pickupNodes} pickups have a loaded mesh`);
check(built.underWorld, "every pickup node hangs off game.world");

// The stands place themselves from FLAG_HOMES; a flag at home sits on its stand.
const gotStands = byTeam(built.stands);
const gotFlags = byTeam(built.flags);
for (const team of ["red", "blue"]) {
  const home = [FLAG_HOMES[team].x, FLAG_HOMES[team].y, FLAG_HOMES[team].z];
  check(
    gotStands[team] && nearArr(gotStands[team].position, home, 0.001),
    `${team} stand at ${JSON.stringify(gotStands[team] && gotStands[team].position)} (FLAG_HOMES: ${JSON.stringify(home)})`
  );
  const got = gotFlags[team];
  check(
    got && (got.state !== "home" || nearArr(got.position, home, 0.3)),
    `${team} flag ${got && got.state} at ${JSON.stringify(got && got.position)} (FLAG_HOMES: ${JSON.stringify(home)}, bob included)`
  );
}

console.log("\n--- glow lights ---");
const EXPECTED_GLOWS = [
  [101.18, 1.44, 5.0],
  [-75.42, 1.48, -20.38],
];
for (const want of EXPECTED_GLOWS) {
  check(
    built.glows.some((g) => nearArr(g.world, want, 0.001)),
    `a glow at ${JSON.stringify(want)} — got ${JSON.stringify(built.glows.map((g) => g.world))}`
  );
}

console.log("\n--- events ---");
check(events.carriedState === "carried", "flag-update carried -> state carried");
check(events.carriedIgnoredSnapshot, "a carried flag ignores the snapshot position (it rides the carrier)");
check(events.carriedStillDrawn, "a flag carried by someone else is still drawn");
check(nearArr(events.droppedAt, [11.52, 13.13, -9.17], 0.3), `dropped at ${JSON.stringify(events.droppedAt)} (bob included)`);
check(near(events.droppedTiltDeg, 12, 0.001), `dropped tilt ${events.droppedTiltDeg.toFixed(2)} deg`);
check(nearArr(events.homeAgainRot, [0, 0, 0], 1e-9), "returned home upright and square to the world");
check(events.takenHidden, "pickup-taken hides the item");
check(events.respawnShown, "pickup-respawn shows it again");
check(events.asks.some((a) => a.startsWith("pickup:")), `request-pickup emitted (${JSON.stringify(events.asks)})`);
check(events.asks.some((a) => a.startsWith("flag:")), `request-flag-touch emitted (${JSON.stringify(events.asks)})`);

console.log("\nrenderer:", JSON.stringify(info));
for (const pose of POSES) console.log(shotPath(pose.name));
console.log(errors.length ? `\nconsole:\n${errors.join("\n")}` : "\nno console errors");
console.log(fail.length ? `\n${fail.length} FAILED` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
