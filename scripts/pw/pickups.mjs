// pickups.mjs — the pickups/CTF probe for the three.js entry.
//
// HEADED, always (docs/plans/2026-09-06-three-migration.md ground rules): SwiftShader
// renders a different, dimmer scene than the real driver and would happily "prove" a
// match that does not exist.
//
// The network layer is not ported yet, so play.html never hears `pickups-init` or
// `ctf-init`. Rather than invent payloads, this probe takes them off the A-Frame page,
// which IS connected to the running 8081 server: it reads the live `weapon-pickup` and
// `ctf-flag` systems out of index.html and replays exactly those objects onto
// play.html's event bus. Anything the two pages then disagree about is the port, not
// the data.
//
// It also plants the same camera pose on both pages, pointed at the BLUE base, and
// writes the two screenshots side by side.
//
// Usage: node scripts/pw/pickups.mjs [outDir]
//   needs `npm run dev` (8080) and `npm run server:tls` (8081).
import { launchQuiet } from "./launch.mjs";
import { mkdirSync } from "node:fs";
import path from "node:path";

const OUT = process.argv[2] || process.env.SCRATCHPAD || ".";
const BASE = process.env.FW_BASE || "http://localhost:8080";
const SETTLE_MS = 8000;
const VIEWPORT = { width: 1280, height: 720 };

mkdirSync(OUT, { recursive: true });
// Two poses at the BLUE base, both found by sweeping index.html rather than guessed —
// FlagBase1 sits in an alcove inside the tower and almost every line to it is blocked
// by the base's own columns.
//
//   flag    the flag, its lit stand and the ring, from the one clear line into the alcove
//   items   the Shock Rifle, its two Shock Cores and a MedBox in the room above it
const BLUE_HOME = { x: -75.42, y: -0.32, z: -20.38 };
const SHOCK = { x: -75.31, y: -1.02, z: 8.97 };
const POSES = [
  { name: "flag", eye: { x: BLUE_HOME.x + 5, y: BLUE_HOME.y + 1.6, z: BLUE_HOME.z }, look: { x: BLUE_HOME.x, y: BLUE_HOME.y + 1.2, z: BLUE_HOME.z } },
  { name: "items", eye: { x: SHOCK.x + 4, y: SHOCK.y + 1.8, z: SHOCK.z + 4 }, look: { x: SHOCK.x, y: SHOCK.y + 0.5, z: SHOCK.z } },
];
const shotPath = (page, pose) => path.join(OUT, `pickups-${pose}-${page}.png`);

const fail = [];
const check = (ok, label) => {
  console.log(`${ok ? "  ok" : "FAIL"}  ${label}`);
  if (!ok) fail.push(label);
};

const browser = await launchQuiet({ args: ["--ignore-certificate-errors"] });

// ---------------------------------------------------------------------------
// 1. index.html — the reference, with the real server behind it.
// ---------------------------------------------------------------------------
const refPage = await browser.newPage({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
await refPage.goto(`${BASE}/index.html`);
await refPage.waitForTimeout(SETTLE_MS);

const payload = await refPage.evaluate(() => {
    const scene = document.querySelector("a-scene");
    const THREE = window.AFRAME.THREE;

    // Everything play.html does not have yet, out of the shot: the HUD and the prompt
    // are DOM, the view weapon is a child of #cam, the bots are remote rigs.
    // !important, because several of the HUD's own rules in styles.css are !important.
    for (const el of document.body.children) {
      if (el.tagName !== "A-SCENE") el.style.setProperty("display", "none", "important");
    }
    for (const rig of document.querySelectorAll('[id^="remote-rig-"]')) {
      if (rig.object3D) rig.object3D.visible = false;
    }
    const soldier = document.querySelector("#soldier");
    if (soldier && soldier.object3D) soldier.object3D.visible = false;

    // look-controls rewrites the camera rotation every frame and movement-controls the
    // rig position, so both have to go before any planted pose sticks. `plant` below
    // then drives the rig directly.
    const cam = document.querySelector("#cam");
    const rig = document.querySelector("#rig");
    cam.removeAttribute("look-controls");
    rig.removeAttribute("movement-controls");
    for (const child of cam.object3D.children) if (!child.isCamera) child.visible = false;
    cam.object3D.position.set(0, 0, 0);

    window.__plant = (eye, look) => {
      // Bots keep joining while the probe runs, and each one arrives visible.
      for (const r of document.querySelectorAll('[id^="remote-rig-"]')) {
        if (r.object3D) r.object3D.visible = false;
      }
      const camObj = cam.getObject3D("camera");
      rig.object3D.position.set(eye.x, eye.y, eye.z);
      rig.object3D.rotation.set(0, 0, 0);
      // The whole graph, not just the camera's own branch: lookAt and the decompose
      // below both read the PARENT world matrix, and the rig's is a frame stale the
      // instant it is moved. Getting this wrong plants play.html on the pose
      // index.html had before the move, which reads as a small pitch error.
      scene.object3D.updateMatrixWorld(true);
      camObj.lookAt(new THREE.Vector3(look.x, look.y, look.z));
      camObj.updateMatrixWorld(true);
    };

    // Read the pose back AFTER the engine has had its way with it. ut-controls and
    // ut-jump still own the rig (only look-controls and movement-controls were taken
    // off), so the eye ends up on the floor rather than exactly where __plant put it —
    // and it is the rendered pose, not the requested one, that play.html has to match.
    window.__readPose = () => {
      const camObj = cam.getObject3D("camera");
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      camObj.updateMatrixWorld(true);
      camObj.matrixWorld.decompose(p, q, s);
      return { position: p.toArray(), quaternion: q.toArray(), fov: camObj.fov };
    };

    // The live server state, straight off the two A-Frame systems.
    const pickupSys = scene.systems["weapon-pickup"];
    const flagSys = scene.systems["ctf-flag"];
    const pickups = [...pickupSys.items.values()].map((i) => ({ ...i.data, available: i.available }));
    const flags = [...flagSys.flags.entries()].map(([team, f]) => ({
      team,
      state: f.state,
      carrier: f.carrier,
      x: f.pos.x,
      y: f.pos.y,
      z: f.pos.z,
      returnInMs: 0,
    }));

    const stands = [...document.querySelectorAll("[ctf-flag-stand]")].map((el) => ({
      team: el.getAttribute("ctf-flag-stand").team,
      position: el.object3D.position.toArray(),
    }));

    // The glow lights, in world space, so the port can be held to the same two points.
    const glows = [];
    scene.object3D.traverse((o) => {
      if (o.isPointLight && o.distance > 18 && o.distance < 19) {
        glows.push({ color: `#${o.color.getHexString()}`, world: o.getWorldPosition(new THREE.Vector3()).toArray() });
      }
    });

    return { pickups, flags, stands, glows, myTeam: flagSys.myTeam };
  });

payload.poses = {};
for (const pose of POSES) {
  await refPage.evaluate(({ eye, look }) => window.__plant(eye, look), { eye: pose.eye, look: pose.look });
  await refPage.waitForTimeout(800);
  payload.poses[pose.name] = await refPage.evaluate(() => window.__readPose());
  await refPage.screenshot({ path: shotPath("index", pose.name) });
}
await refPage.close();

console.log(`index.html: ${payload.pickups.length} pickups, ${payload.flags.length} flags, team ${payload.myTeam}`);
console.log("index.html glow lights:", JSON.stringify(payload.glows));
if (!payload.pickups.length) {
  console.error("index.html got no pickups — is `npm run server:tls` running on 8081?");
  await browser.close();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. play.html — the port, fed the same payloads by hand.
// ---------------------------------------------------------------------------
const errors = [];
const page = await browser.newPage({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/play.html`);
await page.waitForFunction(() => window.__fw && window.__fw.world && window.__fw.systems.has("quality-tier"), {
  timeout: 30000,
});
// The pointer-lock prompt and the credits are DOM, and index.html's are already
// hidden — the shots must differ only in what the two engines draw.
await page.evaluate(() => {
  for (const el of document.body.children) {
    if (el.tagName !== "CANVAS") el.style.setProperty("display", "none", "important");
  }
});

// Register the two systems the way main-three.js will (Task 3's order: after the
// player, before remote avatars).
await page.evaluate(async () => {
  const { WeaponPickups } = await import("/src/game/systems/weapon-pickup.js");
  const { CtfFlags } = await import("/src/game/systems/ctf-flag.js");
  const game = window.__fw;
  game.register("weapon-pickup", new WeaponPickups(game));
  game.register("ctf-flag", new CtfFlags(game));
});

const built = await page.evaluate(async (payload) => {
  const game = window.__fw;
  game.events.emit("pickups-init", { pickups: payload.pickups });
  game.events.emit("ctf-init", { flags: payload.flags, myTeam: payload.myTeam });
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
}, payload);

// Plant the reference poses and take the parity shots BEFORE any of the mutation
// checks below move a flag. The player controller (another agent's task) may already
// own the camera, so the pose is re-planted immediately before each shot.
for (const pose of POSES) {
  await page.evaluate((p) => {
    const game = window.__fw;
    const cam = game.camera;
    // The player controller parents the camera to the rig's head and writes the view
    // shake into its local transform every frame. Lift it out to the scene root (where
    // local IS world) and freeze its matrix, so the planted pose is the one rendered.
    if (cam.parent !== game.scene) game.scene.add(cam);
    cam.matrixAutoUpdate = false;
    cam.position.fromArray(p.position);
    cam.quaternion.fromArray(p.quaternion);
    cam.fov = p.fov;
    cam.updateProjectionMatrix();
    cam.updateMatrix();
    cam.updateMatrixWorld(true);
  }, payload.poses[pose.name]);
  await page.waitForTimeout(600);
  await page.screenshot({ path: shotPath("play", pose.name) });
}

// ---------------------------------------------------------------------------
// 3. The event contract, with synthetic messages in the server's own shapes.
// ---------------------------------------------------------------------------
const events = await page.evaluate(async (payload) => {
  const game = window.__fw;
  const ctf = game.systems.get("ctf-flag");
  const pickups = game.systems.get("weapon-pickup");
  const out = {};

  // A flag taken by SOMEONE ELSE: state carried, the snapshot position ignored, the
  // mesh still visible (it is only hidden when the local player is the carrier).
  const enemy = payload.flags.find((f) => f.team !== payload.myTeam) || payload.flags[0];
  const before = ctf.flags.get(enemy.team).node.position.toArray();
  game.events.emit("flag-update", {
    team: enemy.team,
    state: "carried",
    x: 0,
    y: 0,
    z: 0,
    carrier: "ghost",
    isMine: false,
    myTeam: payload.myTeam,
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
    myTeam: payload.myTeam,
  });
  out.droppedAt = carried.node.position.toArray();
  out.droppedTiltDeg = (carried.node.rotation.x * 180) / Math.PI;

  // And home again: upright, square to the world.
  game.events.emit("flag-update", {
    team: enemy.team,
    state: "home",
    x: enemy.x,
    y: enemy.y,
    z: enemy.z,
    carrier: null,
    isMine: false,
    myTeam: payload.myTeam,
  });
  out.homeAgainAt = carried.node.position.toArray();
  out.homeAgainRot = carried.node.rotation.toArray().slice(0, 3);

  // A pickup taken and respawned.
  const id = payload.pickups[0].id;
  game.events.emit("pickup-taken", { id, by: "ghost", respawnInMs: 30000 });
  out.takenHidden = !pickups.items.get(id).node.visible;
  game.events.emit("pickup-respawn", { id });
  out.respawnShown = pickups.items.get(id).node.visible;

  // The proximity sweep needs a rig; the player controller is another agent's task, so
  // stand a bare Object3D on a pickup and on the enemy flag and listen for the asks.
  const asks = [];
  game.events.on("request-pickup", (e) => asks.push(`pickup:${e.detail.id}`));
  game.events.on("request-flag-touch", (e) => asks.push(`flag:${e.detail.team}`));
  if (!game.rig) {
    game.rig = new game.THREE.Object3D();
    game.scene.add(game.rig);
  }
  const p0 = payload.pickups[0];
  game.rig.position.set(p0.x, p0.y, p0.z);
  pickups.checkLocalPlayer(performance.now() + 10000);
  game.rig.position.set(enemy.x, enemy.y, enemy.z);
  ctf.lastClaim = 0;
  ctf.update(0.016, performance.now() + 20000);
  out.asks = asks;

  return out;
}, payload);

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
// 4. The report.
// ---------------------------------------------------------------------------
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const nearArr = (a, b, eps = 0.01) => a.length === b.length && a.every((v, i) => near(v, b[i], eps));
const byTeam = (rows) => Object.fromEntries(rows.map((r) => [r.team, r]));

console.log("\n--- nodes ---");
check(built.pickupNodes === payload.pickups.length, `${built.pickupNodes} pickup nodes (index.html: ${payload.pickups.length})`);
check(built.withMesh === built.pickupNodes, `${built.withMesh}/${built.pickupNodes} pickups have a loaded mesh`);
check(built.underWorld, "every pickup node hangs off game.world");

const refStands = byTeam(payload.stands);
const gotStands = byTeam(built.stands);
for (const team of ["red", "blue"]) {
  check(
    gotStands[team] && nearArr(gotStands[team].position, refStands[team].position, 0.001),
    `${team} stand at ${JSON.stringify(gotStands[team] && gotStands[team].position)} (index.html: ${JSON.stringify(refStands[team] && refStands[team].position)})`
  );
}

const refFlags = byTeam(payload.flags);
const gotFlags = byTeam(built.flags);
for (const team of ["red", "blue"]) {
  const ref = refFlags[team];
  const got = gotFlags[team];
  check(
    got && nearArr(got.position, [ref.x, ref.y, ref.z], 0.001),
    `${team} flag at ${JSON.stringify(got && got.position)} (index.html: ${JSON.stringify([ref.x, ref.y, ref.z])})`
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
console.log("  index.html measured:", JSON.stringify(payload.glows.map((g) => g.world)));

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

console.log("\nplay.html:", JSON.stringify(info));
for (const pose of POSES) {
  console.log(shotPath("index", pose.name));
  console.log(shotPath("play", pose.name));
}
console.log(errors.length ? `\nconsole:\n${errors.join("\n")}` : "\nno console errors");
console.log(fail.length ? `\n${fail.length} FAILED` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
