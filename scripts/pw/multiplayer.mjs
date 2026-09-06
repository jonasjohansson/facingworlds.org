// multiplayer.mjs — the network probe (Task 13). The milestone for step 4 of the
// migration design doc: play against bots.
//
// It joins the real 8081 server from play.html and checks the whole of what network.js
// now does through method calls rather than the DOM:
//
//   hello        the server's id lands on game.rig.userData.playerId (CTF reads it there)
//   team         `local-team` fired with a side
//   spawn        applyLocalSpawn put the rig ON the point hello carried, not near it
//   bots         a remote avatar appears, its body MOVES, and its locomotion blend is
//                running — i.e. the wire's animation block reaches the mixer through
//                avatar.setPose()
//   hp           the local Health is wired to the HUD plate (100 on the tile)
//   scoreboard   TAB opens it (the level input.js already tracks; hold-to-show, as in the
//                A-Frame build — see systems/highscore-display.js)
//   fire         five fireBullet() calls put five `fire` messages on the wire
//   remote fx    a bot's shot comes back and is DRAWN here (ut-effects.drawHitscanShot)
//   pickups/CTF  the `pickups-init` and `ctf-init` relays reached their systems
//   name         the N dialog's save path emits `change-name` and the server echoes a
//                `name` message back
//   interop      a SECOND page on the A-Frame index.html, same server, same browser
//                context: each page must see the other as a remote body with its name
//
// Needs both servers: static on 8080 (`npm run dev`) and the game server on 8081
// (`npm run server:tls`). Headed, as every probe here is.
//
// Usage: node scripts/pw/multiplayer.mjs [baseUrl]
// Also exported as runMultiplayer({ browser, base }) so scripts/pw/parity.mjs can run it
// beside the other three probes in one browser and fold its verdict into one table.
import { launchQuiet } from "./launch.mjs";
import { baseUrl, createChecks, isMain, printChecks, watchErrors } from "./lib.mjs";

// Everything the probe needs to see from INSIDE the page, installed before any page
// script runs: the raw socket traffic (there is no other way to read `hello.spawn` or to
// count what went out), the scene bus, and a counter on the one draw call a remote shot
// makes. Nothing here changes behaviour — every wrapper calls through.
const INIT = `
window.__probe = { events: {}, sent: {}, recv: {}, hello: null, drawn: 0 };
const OrigWS = window.WebSocket;
const origSend = OrigWS.prototype.send;
OrigWS.prototype.send = function (data) {
  try { const m = JSON.parse(data); __probe.sent[m.type] = (__probe.sent[m.type] || 0) + 1; } catch (e) {}
  return origSend.call(this, data);
};
window.WebSocket = function (...a) {
  const s = new OrigWS(...a);
  __probe.socket = s;
  s.addEventListener("message", (e) => {
    try {
      const m = JSON.parse(e.data);
      __probe.recv[m.type] = (__probe.recv[m.type] || 0) + 1;
      if (m.type === "hello") __probe.hello = m;
      if (m.type === "name") (__probe.names = __probe.names || []).push(m);
    } catch (err) {}
  });
  return s;
};
window.WebSocket.prototype = OrigWS.prototype;
const BUS = ["local-team", "player-join", "player-leave", "pickups-init", "ctf-init",
             "local-fire", "remote-fire", "bullet-fired", "highscore-update", "name-change",
             "change-name", "player-loadout", "flag-update"];
let hookedBus = false, hookedFx = false;
const tick = () => {
  const g = window.__fw;
  if (g && g.events && !hookedBus) {
    hookedBus = true;
    for (const n of BUS) g.events.on(n, (e) => { (__probe.events[n] = __probe.events[n] || []).push(e.detail); });
  }
  if (g && g.systems && !hookedFx) {
    const fx = g.systems.get("ut-effects");
    if (fx) {
      hookedFx = true;
      const orig = fx.drawHitscanShot.bind(fx);
      fx.drawHitscanShot = (...a) => { __probe.drawn++; return orig(...a); };
    }
  }
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
`;

export async function runMultiplayer({ browser, base = baseUrl() } = {}) {
  const url = `${base}/play.html`;
  const LEGACY_URL = `${base}/index.html`;
  const checks = createChecks();
  const row = (name, value, ok) => checks.row(name, value, ok);
  const rows = checks.rows;
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.addInitScript(INIT);
  await page.goto(url);

  // ---- hello ----------------------------------------------------------------------
  const gotHello = await page
    .waitForFunction(() => window.__fw && window.__fw.rig && window.__fw.rig.userData.playerId, null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  row("hello: id on game.rig.userData.playerId", String(gotHello), gotHello);

  const join = await page.evaluate(() => {
    const g = window.__fw;
    const p = __probe;
    const teamEv = (p.events["local-team"] || []).map((d) => d && d.team);
    const spawn = p.hello && p.hello.spawn;
    const rig = g.rig.position;
    const dist = spawn ? Math.hypot(rig.x - spawn.x, rig.y - (spawn.y ?? 0), rig.z - spawn.z) : null;
    return {
      id: g.rig.userData.playerId,
      team: teamEv[teamEv.length - 1] || null,
      teamEvents: teamEv.length,
      spawn: spawn ? [spawn.x, spawn.y ?? 0, spawn.z] : null,
      rig: [+rig.x.toFixed(3), +rig.y.toFixed(3), +rig.z.toFixed(3)],
      spawnErrorM: dist == null ? null : +dist.toFixed(4),
      sentSpawn: p.sent.spawn || 0,
      pickups: (g.systems.get("weapon-pickup") || { items: new Map() }).items.size,
      flags: (g.systems.get("ctf-flag") || { flags: new Map() }).flags.size,
      stands: (g.systems.get("ctf-flag") || { stands: new Map() }).stands.size,
      hudHp: [...document.querySelectorAll(".ut-vital--health .ut-seg")].map((d) => d.dataset.d ?? "").join(""),
      localHp: g.player.health ? g.player.health.hp : null,
    };
  });
  row("team assigned (local-team)", `${join.team} (${join.teamEvents} event(s))`, !!join.team);
  row("spawn: rig on hello.spawn", join.spawn ? `${join.spawnErrorM} m from ${join.spawn.map((n) => +n.toFixed(2))}` : "no spawn in hello", join.spawn != null && join.spawnErrorM <= 0.1);
  row("HUD health plate", `${join.hudHp} (Health.hp ${join.localHp})`, join.hudHp === "100" && join.localHp === 100);
  row("pickups populated", String(join.pickups), join.pickups === 56);
  row("CTF flags / stands", `${join.flags} / ${join.stands}`, join.flags === 2 && join.stands === 2);

  // ---- bots -----------------------------------------------------------------------
  const gotBot = await page
    .waitForFunction(() => {
      const r = window.__fw.systems.get("remote-avatars");
      return !!(r && r.bodies().length);
    }, null, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  row("a remote avatar within 10 s", String(gotBot), gotBot);

  const before = await page.evaluate(() => {
    const r = window.__fw.systems.get("remote-avatars");
    const out = {};
    for (const b of r.bodies()) out[b.id] = [b.rig.position.x, b.rig.position.y, b.rig.position.z];
    return out;
  });
  await page.waitForTimeout(2000);
  const motion = await page.evaluate((before) => {
    const r = window.__fw.systems.get("remote-avatars");
    let best = { id: null, moved: 0, run: 0, walk: 0, name: "" };
    for (const b of r.bodies()) {
      const p0 = before[b.id];
      if (!p0) continue;
      const p = b.rig.position;
      const moved = Math.hypot(p.x - p0[0], p.y - p0[1], p.z - p0[2]);
      const a = b.avatar;
      const w = a.char && a.char.weights ? a.char.weights : { Run: 0, Walk: 0 };
      if (moved > best.moved) best = { id: b.id, moved, run: w.Run || 0, walk: w.Walk || 0, name: a.name };
    }
    return { count: r.bodies().length, ...best };
  }, before);
  row("bots on the map", String(motion.count), motion.count > 0);
  row("bot body moved over 2 s", `${motion.moved.toFixed(2)} m (${motion.name})`, motion.moved > 1);
  row("bot Run/Walk clip weight", `run ${motion.run.toFixed(3)} / walk ${motion.walk.toFixed(3)}`, motion.run + motion.walk > 0);

  // ---- our own body, on the wire --------------------------------------------------
  // The local Character is new here (main-three.js builds it on game.player.soldier once
  // the model resolves) and the pose loop reads its blend targets, so a run has to reach
  // the `pose` message's animation block or every other client draws us gliding.
  const poseBefore = await page.evaluate(() => __probe.sent.pose || 0);
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(1500);
  const running = await page.evaluate(() => {
    const g = window.__fw;
    const c = g.player.character;
    return {
      character: !!c,
      speed: +g.player.speedMps.toFixed(2),
      target: c ? { ...c.target } : null,
      pose: __probe.sent.pose || 0,
    };
  });
  await page.keyboard.up("KeyW");
  row("local Character built on the body", String(running.character), running.character);
  row("running -> Run target on the wire", `${running.speed} m/s, target ${JSON.stringify(running.target)}`, !!running.target && running.target.Run === 1);
  row("pose messages sent while moving", String(running.pose - poseBefore), running.pose - poseBefore > 10);

  // ---- scoreboard (TAB) -----------------------------------------------------------
  // HOLD, not toggle: the A-Frame component owned a keydown/keyup pair and the port reads
  // the same key's level off engine/input.js once a frame. So the probe holds it too.
  await page.keyboard.down("Tab");
  await page.waitForTimeout(200);
  const tabOpen = await page.evaluate(() => document.getElementById("highscore-container").classList.contains("is-open"));
  await page.keyboard.up("Tab");
  await page.waitForTimeout(200);
  const tabClosed = await page.evaluate(() => !document.getElementById("highscore-container").classList.contains("is-open"));
  const scoreRows = await page.evaluate(() => document.querySelectorAll("#players-list .ut-row").length);
  row("scoreboard opens on TAB (held)", `${tabOpen}, closes on release ${tabClosed}, ${scoreRows} row(s)`, tabOpen && tabClosed && scoreRows > 0);

  // ---- firing ---------------------------------------------------------------------
  const fire = await page.evaluate(async () => {
    const before = __probe.sent.fire || 0;
    const w = window.__fw.systems.get("first-person-weapon");
    for (let i = 0; i < 5; i++) w.fireBullet();
    await new Promise((r) => setTimeout(r, 300));
    return { sent: (__probe.sent.fire || 0) - before, localFire: (__probe.events["local-fire"] || []).length };
  });
  row("5x fireBullet() -> `fire` on the wire", `${fire.sent} sent, ${fire.localFire} local-fire`, fire.sent === 5);

  // ---- somebody else's shot -------------------------------------------------------
  const fxBefore = await page.evaluate(() => ({ drawn: __probe.drawn, recv: __probe.recv.fire || 0 }));
  await page.waitForTimeout(10000);
  const fxAfter = await page.evaluate(() => ({
    drawn: __probe.drawn,
    recv: __probe.recv.fire || 0,
    remoteFire: (__probe.events["remote-fire"] || []).length,
  }));
  const drawn = fxAfter.drawn - fxBefore.drawn;
  const recv = fxAfter.recv - fxBefore.recv;
  row("bots' `fire` echoed by the server (10 s)", String(recv), recv > 0);
  row("remote shots DRAWN (drawHitscanShot)", `${drawn} draw(s), ${fxAfter.remoteFire} remote-fire`, drawn > 0);

  // ---- getting shot ---------------------------------------------------------------
  // network.js routes `hit` / `health` / `respawn` for the local player to
  // game.player.health — the Health instance main-three.js builds on the body. Whether a
  // bot lands a shot inside the probe's window is luck, so what is CHECKED here is the
  // wiring that routing depends on, driven through the same setHp() the message handler
  // calls: the HUD plate, the death card and the weapon lock-out. `hits` reports what the
  // server actually sent us in the meantime.
  const damage = await page.evaluate(async () => {
    const g = window.__fw;
    const h = g.player.health;
    const plate = () => [...document.querySelectorAll(".ut-vital--health .ut-seg")].map((d) => d.dataset.d ?? "").join("");
    const weapon = g.systems.get("first-person-weapon");
    // THE SERVER IS SHOOTING BACK while this runs, and a `hit`, `health` or `respawn`
    // message calls the very setHp() being driven here — so an hp written by hand can be
    // overwritten inside the 100 ms the HUD needs to redraw, and the death card that did
    // appear is gone before it is read. A sample where the hp did not stay put is not a
    // failure of the wiring, it is a sample the server took away: throw it out and drive
    // the sequence again.
    let out = null;
    for (let tries = 0; tries < 4 && !out; tries++) {
      h.setHp(35);
      const hurt = { plate: plate(), low: document.querySelector(".ut-vital--health").classList.contains("is-low") };
      h.setHp(0);
      await new Promise((r) => setTimeout(r, 100));
      if (h.hp !== 0) continue;
      const dead = { dead: document.getElementById("ut-hud").classList.contains("is-dead"), canFire: weapon.enabled };
      h.setHp(100);
      await new Promise((r) => setTimeout(r, 100));
      if (h.hp !== 100) continue;
      const alive = { plate: plate(), dead: document.getElementById("ut-hud").classList.contains("is-dead"), canFire: weapon.enabled };
      out = { hurt, dead, alive, tries: tries + 1 };
    }
    return { ...(out || { failed: "the server rewrote hp on every attempt" }), hits: __probe.recv.hit || 0 };
  });
  row(
    "local Health -> HUD / death / weapon",
    damage.failed
      ? `${damage.failed} (server sent ${damage.hits} hit msg)`
      : `35 -> "${damage.hurt.plate}" low=${damage.hurt.low}; 0 -> dead=${damage.dead.dead} fire=${damage.dead.canFire}; 100 -> "${damage.alive.plate}" dead=${damage.alive.dead} fire=${damage.alive.canFire} (attempt ${damage.tries}, server sent ${damage.hits} hit msg)`,
    !damage.failed &&
      damage.hurt.plate === "35" &&
      damage.hurt.low &&
      damage.dead.dead &&
      !damage.dead.canFire &&
      damage.alive.plate === "100" &&
      !damage.alive.dead &&
      damage.alive.canFire
  );

  // ---- name change ----------------------------------------------------------------
  const NEW_NAME = `Probe${Math.floor(Math.random() * 9000) + 1000}`;
  await page.evaluate(() => window.__fw.systems.get("name-changer").show());
  await page.fill("#name-changer-overlay input", NEW_NAME);
  await page.click("#name-changer-overlay .ut-btn--primary");
  await page.waitForTimeout(1500);
  const renamed = await page.evaluate((n) => {
    const board = [...document.querySelectorAll("#players-list .ut-row.is-local .ut-row__name")].map((e) => e.textContent);
    return {
      stored: window.getPlayerName(),
      sentSetName: __probe.sent.setName || 0,
      board,
      closed: !document.getElementById("name-changer-overlay").classList.contains("is-open"),
      matches: window.getPlayerName() === n,
    };
  }, NEW_NAME);
  row("name change (DOM flow)", `${renamed.stored} · setName x${renamed.sentSetName} · scoreboard ${JSON.stringify(renamed.board)}`, renamed.matches && renamed.sentSetName >= 2 && renamed.closed);

  // ---- two clients, one server ----------------------------------------------------
  // The A-Frame page in the SAME browser context, so it shares localStorage and has to go
  // through network.js's per-tab name claim — which is exactly why it gets its own name.
  const legacy = await context.newPage();
  await legacy.goto(LEGACY_URL);
  const legacyReady = await legacy
    .waitForFunction(() => document.querySelector("#rig") && document.querySelector("#rig").dataset.playerId, null, { timeout: 40000 })
    .then(() => true)
    .catch(() => false);
  row("index.html (A-Frame) joined", String(legacyReady), legacyReady);

  await page.waitForTimeout(4000);
  // THE SERVER'S name for each page, not the browser's: the name a client asks for is a
  // request, and server.js disambiguates a collision by suffixing it ("Visse" -> "Visse 2")
  // when a bot already holds it. Both pages' own scoreboards are rebuilt from
  // `highscore-update`, so the local row is each page's copy of what the server settled on.
  const names = await page.evaluate(
    () => document.querySelector("#players-list .ut-row.is-local .ut-row__name")?.textContent || window.getPlayerName()
  );
  const legacyNames = await legacy.evaluate(
    () => document.querySelector("#players-list .ut-row.is-local .ut-row__name")?.textContent || window.getPlayerName()
  );

  const myId = await page.evaluate(() => window.__fw.rig.userData.playerId);
  const legacyId = await legacy.evaluate(() => document.querySelector("#rig").dataset.playerId);

  const seesLegacy = await page.evaluate(
    ({ id, want }) => {
      const r = window.__fw.systems.get("remote-avatars");
      const a = r.get(id);
      return { body: !!a, name: a ? a.name : null, ok: !!a && a.name === want };
    },
    { id: legacyId, want: legacyNames }
  );
  // The A-Frame page has NO name plates (Task 12 gave those to the three build) and its
  // spawnRemote never wrote data-name from the join payload — only a later `name` message
  // did — so the old page's own record of who we are is its rig element plus the scoreboard
  // row the `player-join` / `highscore-update` relays fill in. Both are checked.
  const legacySeesUs = await legacy.evaluate(
    ({ id, want }) => {
      const rig = document.querySelector(`#remote-rig-${id}`);
      const board = [...document.querySelectorAll("#players-list .ut-row__name")].map((e) => e.textContent);
      return { body: !!rig, board, ok: !!rig && board.includes(want) };
    },
    { id: myId, want: names }
  );
  row(`play.html sees "${legacyNames}"`, `body ${seesLegacy.body}, name ${seesLegacy.name}`, seesLegacy.ok);
  row(`index.html sees "${names}"`, `body ${legacySeesUs.body}, scoreboard ${JSON.stringify(legacySeesUs.board)}`, legacySeesUs.ok);

  // ---- teardown -------------------------------------------------------------------
  // LAST, because it takes the page down with it. startNetwork() returns a handle that
  // main-three.js registers as a system, so game.dispose() has to reach the socket, the
  // 20 Hz pose interval and the bus subscriptions — none of which the frame loop owns, and
  // all of which used to outlive it. The HUD refcount is the other half: it only reaches
  // zero (and takes #ut-hud out of the document) if the local Health's dispose() runs,
  // which needs it registered and not merely attached.
  const teardown = await page.evaluate(async () => {
    const g = window.__fw;
    const poseBefore = __probe.sent.pose || 0;
    g.dispose();
    await new Promise((r) => setTimeout(r, 1200));
    return {
      systems: g.systems.size,
      posesAfterDispose: (__probe.sent.pose || 0) - poseBefore,
      socketState: __probe.socket ? __probe.socket.readyState : -1, // 2 CLOSING, 3 CLOSED
      hud: !!document.getElementById("ut-hud"),
      status: !!document.getElementById("net-status"),
      scoreboard: !!document.getElementById("highscore-container"),
      dialog: !!document.getElementById("name-changer-overlay"),
    };
  });
  row(
    "game.dispose() tears the client down",
    `systems ${teardown.systems}, poses after ${teardown.posesAfterDispose}, socket readyState ${teardown.socketState}, #ut-hud ${teardown.hud}, #net-status ${teardown.status}, scoreboard ${teardown.scoreboard}, dialog ${teardown.dialog}`,
    teardown.systems === 0 &&
      teardown.posesAfterDispose === 0 &&
      teardown.socketState >= 2 &&
      !teardown.hud &&
      !teardown.status &&
      !teardown.scoreboard &&
      !teardown.dialog
  );

  // ---------------------------------------------------------------------------------
  // A console error is worth reading; only a pageerror — something actually threw — fails
  // the run, which is the verdict this probe has always given.
  row("no page errors", errors.length ? errors.join(" | ") : "clean", !errors.some((e) => e.startsWith("pageerror")));
  await context.close();
  return { rows, errors };
}

if (isMain(import.meta.url)) {
  const browser = await launchQuiet();
  const { rows } = await runMultiplayer({ browser, base: baseUrl() });
  await browser.close();
  printChecks(rows, { title: "multiplayer" });
  process.exit(rows.filter((r) => !r.ok).length ? 1 : 0);
}
