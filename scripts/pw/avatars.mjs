// avatars.mjs — the remote-avatar probe (Task 12).
//
// The network layer is not ported yet, so this drives systems/remote-avatars.js directly:
// it registers the system on the running play.html, spawns three bodies with the exact
// payload shape network.js's spawnRemote receives (server.js publicPlayer: id, name, hp,
// x/y/z, ry, speed, animation, dual, weapon, team, character), and then feeds a walking
// pose stream at GROUND_SPEED for two seconds — the same 20 Hz cadence and the same
// `t` timestamps the server sends, so the SnapshotBuffer does its real job.
//
// What it measures, in the order the port can break it:
//   run clip     the wire's animation block reaches the mixer: Run's effective weight ~1
//   feet         each body's floor probe lands it on the drawn floor (the old page held
//                bots inside ~5 cm of it)
//   facing       the body's forward axis points along the direction of travel
//   the hand     each held weapon slot sits exactly on the animated "weaponAnchor" node
//                (and the dual pair's second gun on its mirror image)
//   hp           setHp(50) redraws the overhead label — Health's `sethp` replacement
//   fire         fire() plays the held mesh's own sequence and raises the FR twin
//
// Usage:
//   node scripts/pw/avatars.mjs                 probe play.html, screenshot one avatar
//   node scripts/pw/avatars.mjs --legacy        screenshot a BOT on the A-Frame index.html
//                                               (needs the game server on 8081) for the
//                                               side-by-side comparison
import { launchQuiet } from "./launch.mjs";
import { mkdirSync } from "node:fs";
import path from "node:path";

const SCRATCH = process.env.SCRATCHPAD || "/tmp";
mkdirSync(SCRATCH, { recursive: true });

const legacy = process.argv.includes("--legacy");
const url =
  process.argv.find((a) => a.startsWith("http")) ||
  (legacy ? "http://localhost:8080/index.html" : "http://localhost:8080/play.html");

// The red flag base: floor at a known height, with room to walk. src/shared/map-actors.js.
const START = { x: 101.18, y: -0.36, z: 5 };
const GROUND_SPEED = 9.4;
const WALK_MS = 2000;
const POSE_HZ = 20;
// soldier/malcom — one of the two bodies that carry the *FR firing twins and the anchor
// node, and the one index.html's bots draw most often.
const CHARACTER = 18;

const browser = await launchQuiet();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

await page.goto(url);

if (legacy) {
  await runLegacy();
} else {
  await runProbe();
}

if (errors.length) console.log("\n--- console ---\n" + errors.join("\n"));
await browser.close();

// ---------------------------------------------------------------------------

async function runProbe() {
  // Boot registers bloom last: once it is there, every system main-three.js builds is in.
  await page.waitForFunction(() => window.__fw && window.__fw.systems.has("bloom"), null, { timeout: 40000 });
  await page.waitForFunction(() => window.__fw && window.__fw.map && window.__fw.map.userData.mesh, null, {
    timeout: 30000,
  });

  const spawned = await page.evaluate(
    async ({ START, CHARACTER, GROUND_SPEED }) => {
      const THREE = window.__fw.THREE;
      const game = window.__fw;
      // main-three.js registers the registry at boot; only build one if it did not.
      let avatars = game.systems.get("remote-avatars");
      if (!avatars) {
        const { RemoteAvatars } = await import("/src/game/systems/remote-avatars.js");
        avatars = game.register("remote-avatars", new RemoteAvatars(game));
      }
      window.__avatars = avatars;

      // Where the floor actually is under a point, so the poses we feed are the poses the
      // server would send (its heights come off the same geometry).
      const colliders = avatars.worldColliders();
      const ray = new THREE.Raycaster();
      const down = new THREE.Vector3(0, -1, 0);
      window.__floorAt = (x, z, from = 60) => {
        ray.set(new THREE.Vector3(x, from, z), down);
        ray.far = 400;
        const hits = ray.intersectObjects(colliders, false);
        return hits.length ? hits[0].point.y : null;
      };

      // A direction with floor all the way along it, so the walk does not step off the
      // bridge halfway through and turn the floor check into a fall check.
      const dist = GROUND_SPEED * 2;
      let best = null;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const dx = Math.sin(a);
        const dz = Math.cos(a);
        let ok = 0;
        let drop = 0;
        const y0 = window.__floorAt(START.x, START.z);
        for (let s = 0; s <= 20; s++) {
          const y = window.__floorAt(START.x + dx * dist * (s / 20), START.z + dz * dist * (s / 20));
          if (y === null) break;
          drop = Math.max(drop, Math.abs(y - y0));
          ok++;
        }
        if (ok === 21 && drop < 2 && (!best || drop < best.drop)) best = { dx, dz, drop };
      }
      const dir = best || { dx: 0, dz: 1 };
      // A body facing -Z at yaw 0: rotating by t maps (0,0,-1) to (-sin t, -cos t), so
      // the yaw that faces (dx, dz) is atan2(-dx, -dz). Same convention the rig uses.
      const ry = Math.atan2(-dir.dx, -dir.dz);
      window.__walk = { dir, ry, start: { ...START } };

      // The publicPlayer payload, as spawnRemote receives it.
      const mk = (id, off, extra) => ({
        id,
        name: `PROBE-${id}`,
        hp: 100,
        x: START.x + off,
        y: window.__floorAt(START.x + off, START.z) ?? START.y,
        z: START.z,
        ry,
        kills: 0,
        speed: 0,
        animation: { idle: 1, walk: 0, run: 0 },
        dual: false,
        weapon: "enforcer",
        team: "red",
        character: CHARACTER,
        armor: 0,
        ...extra,
      });
      avatars.spawn(mk(901, 0, { team: "red" }));
      avatars.spawn(mk(902, 2.5, { team: "blue", dual: true }));
      avatars.spawn(mk(903, 5, { team: "red", weapon: "shock" }));

      await Promise.all([...avatars.avatars.values()].map((a) => a.ready));
      return [...avatars.avatars.keys()];
    },
    { START, CHARACTER, GROUND_SPEED }
  );
  console.log(`spawned ${spawned.length} avatars: ${spawned.join(", ")}`);

  // ---- walk them in a straight line at GROUND_SPEED, 20 poses a second ----
  await page.evaluate(
    ({ WALK_MS, POSE_HZ, GROUND_SPEED }) => {
      const avatars = window.__avatars;
      const w = window.__walk;
      const t0 = performance.now();
      window.__walkDone = new Promise((resolve) => {
        const timer = setInterval(() => {
          const t = performance.now();
          const el = (t - t0) / 1000;
          const d = Math.min(el, WALK_MS / 1000) * GROUND_SPEED;
          let i = 0;
          for (const a of avatars.avatars.values()) {
            // The three walk parallel lines, 2.5 m apart, as they were spawned.
            const off = i++ * 2.5;
            const x = w.start.x + w.dir.dx * d + off;
            const z = w.start.z + w.dir.dz * d;
            const y = window.__floorAt(x, z) ?? w.start.y;
            a.setPose({
              t,
              x,
              y,
              z,
              ry: w.ry,
              speed: GROUND_SPEED,
              // What the server sends for a sprinting pawn.
              animation: { idle: 0, walk: 0, run: 1 },
            });
          }
          if (t - t0 > WALK_MS) {
            clearInterval(timer);
            resolve();
          }
        }, 1000 / POSE_HZ);
      });
    },
    { WALK_MS, POSE_HZ, GROUND_SPEED }
  );
  await page.waitForFunction(() => window.__walkDone && window.__walkDone.then, null, { timeout: 5000 });
  await page.evaluate(() => window.__walkDone);
  await page.waitForTimeout(300); // let the interpolation delay drain

  const report = await page.evaluate(() => {
    const THREE = window.__fw.THREE;
    const avatars = window.__avatars;
    const colliders = avatars.worldColliders();
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const wp = new THREE.Vector3();
    const out = [];
    for (const a of avatars.avatars.values()) {
      const body = a.body;
      body.updateWorldMatrix(true, true);
      body.getWorldPosition(wp);

      // Feet: distance from the body's origin to the drawn floor under it.
      ray.set(new THREE.Vector3(wp.x, wp.y + 1.2, wp.z), down);
      ray.far = 4;
      const hits = ray.intersectObjects(colliders, false);
      const above = hits.length ? wp.y - hits[0].point.y : null;

      // Facing: the body's own forward axis against the direction of travel.
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(body.getWorldQuaternion(new THREE.Quaternion()));
      const w = window.__walk;
      const facingDot = fwd.x * w.dir.dx + fwd.z * w.dir.dz;

      // The gun in the hand: each slot's world position against the anchor node's.
      const anchor = a._anchor;
      const slots = a._weaponSlots.map((slot, i) => {
        if (!slot || !anchor) return null;
        const ap = anchor.getWorldPosition(new THREE.Vector3());
        const sp = slot.getWorldPosition(new THREE.Vector3());
        if (i === 0) return { i, scaleX: slot.scale.x, dist: sp.distanceTo(ap), visible: slot.visible };
        // Slot 1 is the mirror across the body's YZ plane: compare against the anchor
        // reflected in body space, not against the anchor itself.
        const local = a.body.worldToLocal(ap.clone());
        local.x = -local.x;
        const mirrored = a.body.localToWorld(local);
        return { i, scaleX: slot.scale.x, dist: sp.distanceTo(mirrored), visible: slot.visible };
      });

      const act = a.char && a.char.actions;
      out.push({
        id: a.id,
        weapon: a.weaponId,
        dual: a.dual,
        team: a.team,
        y: +wp.y.toFixed(3),
        aboveFloor: above === null ? null : +above.toFixed(4),
        facingDot: +facingDot.toFixed(4),
        weights: act
          ? {
              Idle: +act.Idle.getEffectiveWeight().toFixed(3),
              Walk: +act.Walk.getEffectiveWeight().toFixed(3),
              Run: +act.Run.getEffectiveWeight().toFixed(3),
            }
          : null,
        runClip: act ? act.Run.getClip().name : null,
        slots: slots.filter(Boolean),
        anchor: !!anchor,
        hp: a.health.hp,
        label: a.health.label.userData.label.text,
        labelColor: a.health.label.userData.label.color,
      });
    }
    return out;
  });

  console.log("\n--- after a 2 s run at 9.4 m/s ---");
  for (const r of report) console.log(JSON.stringify(r));

  // ---- the floor correction, given a wire height that is wrong ----
  // The whole point of _groundToFloor: the server's height is its own idea of the ground
  // and is measurably off (median 4 mm, but 11.6% of frames more than 5 cm high). Feed a
  // height INSIDE the acceptance window and the body must come back down to the drawn
  // floor; feed one outside it and the wire height has to stand, because that is a jump.
  const floorFix = await page.evaluate(async () => {
    const THREE = window.__fw.THREE;
    const avatars = window.__avatars;
    const a = avatars.get(901);
    const w = window.__walk;
    const colliders = avatars.worldColliders();
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const wp = new THREE.Vector3();
    const measure = () => {
      a.body.updateWorldMatrix(true, true);
      a.body.getWorldPosition(wp);
      ray.set(new THREE.Vector3(wp.x, wp.y + 1.5, wp.z), down);
      ray.far = 6;
      const hits = ray.intersectObjects(colliders, false);
      return hits.length ? wp.y - hits[0].point.y : null;
    };
    const hold = async (lift, ms) => {
      const p = a.rig.position.clone();
      const y = window.__floorAt(p.x, p.z) ?? p.y;
      const until = performance.now() + ms;
      while (performance.now() < until) {
        const anim = { idle: 1, walk: 0, run: 0 };
        a.setPose({ t: performance.now(), x: p.x, y: y + lift, z: p.z, ry: w.ry, speed: 0, animation: anim });
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 200));
      return { lift, aboveFloor: +measure().toFixed(4), groundOffset: +a.groundOffset.toFixed(4) };
    };
    return [await hold(0.25, 900), await hold(0.8, 900), await hold(0, 900)];
  });
  console.log("\n--- floor correction (lift = the error in the wire height) ---");
  for (const r of floorFix) console.log(JSON.stringify(r));

  // ---- hp label, and a shot ----
  const after = await page.evaluate(async () => {
    const avatars = window.__avatars;
    const a = avatars.get(901);
    a.setHp(50);
    const hurt = { text: a.health.label.userData.label.text, color: a.health.label.userData.label.color };
    a.setHp(15);
    const critical = { text: a.health.label.userData.label.text, color: a.health.label.userData.label.color };
    a.setHp(100);

    // A shot: the FR twin has to take the weight over the plain Run, and the held mesh's
    // own sequence has to start.
    a.fire();
    await new Promise((r) => setTimeout(r, 120));
    const fireAction = a.fireActions.Run;
    const slot = a._weaponSlots[0];
    const mixer = slot && slot.userData.thirdMixer;
    let held = null;
    if (mixer && slot.userData.thirdClips) {
      const running = slot.userData.thirdClips
        .map((c) => mixer.clipAction(c))
        .filter((x) => x.isRunning())
        .map((x) => x.getClip().name);
      held = running;
    }
    return {
      hurt,
      critical,
      fireMix: +a.fireMix.toFixed(3),
      runTwin: fireAction ? +fireAction.getEffectiveWeight().toFixed(3) : null,
      runPlain: +a.char.actions.Run.getEffectiveWeight().toFixed(3),
      heldClipsRunning: held,
      recoilActive: a._recoilActive,
    };
  });
  console.log("\n--- setHp + fire ---");
  console.log(JSON.stringify(after, null, 2));

  // ---- screenshot one avatar from a planted camera ----
  const shot = path.join(SCRATCH, "avatars-three.png");
  await page.evaluate(() => {
    const THREE = window.__fw.THREE;
    const game = window.__fw;
    const a = window.__avatars.get(901);
    const p = a.body.getWorldPosition(new THREE.Vector3());
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(a.body.getWorldQuaternion(new THREE.Quaternion()));
    // In front of the body, at chest height, looking back at it — the framing the legacy
    // shot below reproduces from the A-Frame page.
    const eye = p.clone().addScaledVector(fwd, 3.4).add(new THREE.Vector3(0, 1.5, 0));
    const look = p.clone().add(new THREE.Vector3(0, 1.0, 0));
    // The camera is a CHILD of the player's head node, and the controller writes its roll
    // and eye lift every frame. Reparent it to the scene so a world position is a world
    // position, and pin it from a system registered LAST — after the player — so this
    // wins whatever else touched it this frame.
    game.scene.add(game.camera);
    game.register("probe-camera", {
      update() {
        game.camera.position.copy(eye);
        game.camera.lookAt(look);
      },
    });
  });
  // The pointer-lock prompt is a DOM overlay across the middle of the page.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll(".ut-lock-prompt, #credits-container, #ut-hud")) {
      el.style.setProperty("visibility", "hidden", "important");
    }
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: shot });
  console.log(`\nscreenshot: ${shot}`);
}

// ---------------------------------------------------------------------------
// The A-Frame page, for the side-by-side: join the live server, wait for a bot, put the
// local rig in front of it and look at it.
async function runLegacy() {
  await page.waitForFunction(() => document.querySelectorAll("[remote-avatar]").length > 0, null, { timeout: 40000 });
  await page.waitForTimeout(5000); // models, skins and the first poses in

  const info = await page.evaluate(() => {
    const THREE = AFRAME.THREE;
    const v = new THREE.Vector3();
    // A bot whose body has loaded AND which has been given a pose: a rig still sitting at
    // the origin has never had setNetPose called on it and is not on the map at all.
    const el = [...document.querySelectorAll("[remote-avatar]")].find(
      (s) => s.getObject3D("mesh") && s.parentElement && s.parentElement.object3D.getWorldPosition(v).lengthSq() > 1
    );
    if (!el) return { bots: 0 };
    const rig = el.parentElement;
    const myRig = document.querySelector("#rig");
    const cam = document.querySelector("#cam");

    // THREE THINGS OWN THIS CAMERA AND ALL THREE HAVE TO BE TAKEN OFF IT.
    //   movement-controls clamps the rig to the navmesh every tick FROM ITS CACHED
    //     POLYGON, so a position written from outside is dragged straight back;
    //   look-controls rewrites the camera entity's rotation every tick from its own
    //     yaw/pitch objects (this is the leak the whole port is about);
    //   the RIG carries the player's yaw, so a yaw written on the camera composes with it
    //     — the rig has to be squared up or the shot points 80 degrees off.
    myRig.setAttribute("movement-controls", "enabled", false);
    cam.setAttribute("look-controls", "enabled", false);
    cam.object3D.rotation.order = "YXZ";

    // The bot is RUNNING. Framing it once and screenshotting two seconds later
    // photographs an empty floor, so the framing is re-made every frame.
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const fwd = new THREE.Vector3();
    const eye = new THREE.Vector3();
    const to = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    window.__follow = setInterval(() => {
      rig.object3D.getWorldPosition(p);
      rig.object3D.getWorldQuaternion(q);
      fwd.set(0, 0, -1).applyQuaternion(q);
      // In front of the body at chest height, looking back at it — the same framing the
      // three.js probe plants its camera with, so the two shots are comparable.
      eye.copy(p).addScaledVector(fwd, 3.4).addScaledVector(up, 1.5);
      myRig.object3D.position.set(eye.x, eye.y - 1.4, eye.z); // the rig is at the feet
      myRig.object3D.rotation.set(0, 0, 0);
      to.copy(p).addScaledVector(up, 1.0).sub(eye);
      cam.object3D.rotation.set(Math.asin(to.clone().normalize().y), Math.atan2(-to.x, -to.z), 0);
    }, 16);

    rig.object3D.getWorldPosition(p);
    const health = el.components.health;
    const text = health && health.label && health.label.getObject3D("text");
    const box = text ? new THREE.Box3().setFromObject(text).getSize(new THREE.Vector3()) : null;
    return {
      bots: document.querySelectorAll("[remote-avatar]").length,
      name: rig.getAttribute("data-name"),
      model: el.getAttribute("gltf-model"),
      skin: (rig.dataset.skin || "").split(",")[0],
      weapon: rig.dataset.weapon,
      dual: rig.dataset.dual || "",
      botAt: p.toArray().map((n) => +n.toFixed(2)),
      // The size the overhead HP number is drawn at TODAY, which is what health.js's
      // sprite is scaled to match. See its widthM comment.
      hpLabelSizeM: box ? box.toArray().map((n) => +n.toFixed(3)) : null,
    };
  });
  console.log(JSON.stringify(info, null, 2));

  await page.evaluate(() => {
    // The lock prompt and the HUD are DOM overlays across the shot; the three.js page has
    // no HUD yet, so hiding both is what makes the two comparable.
    for (const el of document.querySelectorAll(".ut-lock-prompt, #credits-container, #ut-hud")) {
      el.style.setProperty("visibility", "hidden", "important");
    }
  });
  await page.waitForTimeout(2000);
  const shot = path.join(SCRATCH, "avatars-aframe.png");
  await page.screenshot({ path: shot });
  console.log(`screenshot: ${shot}`);
}
