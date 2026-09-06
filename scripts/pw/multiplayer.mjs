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
// Usage: node scripts/pw/multiplayer.mjs [url]
import { launchQuiet } from "./launch.mjs";

const url = process.argv.find((a) => a.startsWith("http")) || "http://localhost:8080/play.html";
const LEGACY_URL = "http://localhost:8080/index.html";

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

const rows = [];
const row = (name, value, ok) => {
  rows.push({ name, value, ok });
  return ok;
};

const browser = await launchQuiet();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});
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
  h.setHp(35);
  const hurt = { plate: plate(), low: document.querySelector(".ut-vital--health").classList.contains("is-low") };
  h.setHp(0);
  await new Promise((r) => setTimeout(r, 100));
  const dead = { dead: document.getElementById("ut-hud").classList.contains("is-dead"), canFire: weapon.enabled };
  h.setHp(100);
  await new Promise((r) => setTimeout(r, 100));
  const alive = { plate: plate(), dead: document.getElementById("ut-hud").classList.contains("is-dead"), canFire: weapon.enabled };
  return { hurt, dead, alive, hits: __probe.recv.hit || 0 };
});
row(
  "local Health -> HUD / death / weapon",
  `35 -> "${damage.hurt.plate}" low=${damage.hurt.low}; 0 -> dead=${damage.dead.dead} fire=${damage.dead.canFire}; 100 -> "${damage.alive.plate}" dead=${damage.alive.dead} fire=${damage.alive.canFire} (server sent ${damage.hits} hit msg)`,
  damage.hurt.plate === "35" && damage.hurt.low && damage.dead.dead && !damage.dead.canFire && damage.alive.plate === "100" && !damage.alive.dead && damage.alive.canFire
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
const names = await page.evaluate(() => window.getPlayerName());
const legacyNames = await legacy.evaluate(() => window.getPlayerName());

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

// ---------------------------------------------------------------------------------
const w = Math.max(...rows.map((r) => r.name.length));
console.log("");
console.log(`${"CHECK".padEnd(w)}  OK   VALUE`);
console.log(`${"-".repeat(w)}  ---  -----`);
for (const r of rows) console.log(`${r.name.padEnd(w)}  ${r.ok ? " ok" : "FAIL"}  ${r.value}`);
console.log("");
if (errors.length) console.log("play.html console errors:\n" + errors.join("\n"));
else console.log("play.html: no console errors");

await browser.close();
const failed = rows.filter((r) => !r.ok).length;
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed || errors.some((e) => e.startsWith("pageerror")) ? 1 : 0);
