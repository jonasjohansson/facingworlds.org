const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");

// 8081, not 8080: `npm start` serves the static site on 8080, so a dev client pointed at
// ws://localhost:8080 connects to the http-server (or whatever else holds the port) and
// reports ONLINE while no game traffic flows. Render supplies PORT in production.
const PORT = process.env.PORT || 8081;
const PLAYER_HP = 100;
const MAX_NAME = 24;
const POSE_UPDATE_INTERVAL = 50; // ms - throttle pose updates

// ---- world scale ----
// Mirrors WORLD_SCALE in src/shared/map-transform.js, which is the single source of
// truth and carries the full derivation. It cannot be imported: this file is CommonJS
// (server/package.json declares no "type") and map-transform.js is an ES module, so a
// require() of it throws. If you change it there, change it here — and re-derive every
// value marked "x k" below, plus the matching constants in server/test/ctf.test.mjs.
//
// The CTF-Face fan model was authored at 0.010062 m/UU while the player rig is at UT99
// pawn scale (0.0235 m/UU), so the map was 43% of the size the movement numbers assume.
// k closes that gap; it is baked into the two .glb files by scripts/optimize-assets.mjs,
// so #world and #navmesh stay at the identity transform and every world coordinate below
// is already in its final, scaled form.
//
// World-anchored POSITIONS are no longer written here at all: FLAG_HOMES, SPAWNS, the
// tower roofs and every pickup come out of the generated CTF-Face table below. What is
// left as `<pre-scale> * WORLD_SCALE` are the two values that are just round margins —
// WORLD_LIMIT and MAP_MARGIN — so their provenance stays legible.
const WORLD_SCALE = 2.33552;

// ---- the real CTF-Face placements ----
// server/map-actors.js is GENERATED (scripts/gen-map-actors.mjs) from Epic's own actor
// table, put through the measured UU->scene transform in src/shared/map-transform.js.
// It is a CommonJS twin of src/shared/map-actors.js — same numbers, same run of the
// generator, written next to server.js so it deploys with the server whatever root
// directory the host is pointed at. Nothing below re-derives a world position by hand.
//
// Regenerate with `node scripts/gen-map-actors.mjs`; `--check` fails if it is stale.
const MAP = require("./map-actors.js");

// Bots. Everything about them lives in server/bots.js; this file only creates the manager
// (below, once the state and helpers it borrows exist) and calls its roster check from the
// world sweep. A bot is an ordinary entry in `players` with no socket, so nothing else in
// here — publicPlayer, applyHit, dropFlag, resetMatch, the scoreboard — knows or cares.
const { createBots } = require("./bots.js");
const { pickCharacter } = require("./characters.js");
// The baked navmesh, for standing pickups on the floor they belong to.
const { surfaceNear } = require("./navmesh-surface.js");

// ---- validation / anti-cheat tuning ----
const HEARTBEAT_INTERVAL = 15000; // ms between pings; two misses reaps the socket
// NOT scaled by k, deliberately. This is a SPEED, and the player did not get faster: the
// walk is still 9.4 m/s, and the fastest anything legitimate goes is a fall off a tower —
// which did grow, from 30 m to 71 m, but only as sqrt: sqrt(2 * 22.3 * 71) = 56.3 m/s,
// against 36.8 m/s before. 100 still covers it with 1.8x to spare. Multiplying it by k
// would hand a cheater 234 u/s for nothing.
const MAX_POSE_SPEED = 100; // u/s ceiling incl. tower falls — anything faster is a teleport
// Also NOT scaled: this is speed * a lag spike's worth of time, and neither term moved.
const POSE_SLACK = 6; // units of tolerance on top of speed*dt (lag spikes)
const POSE_REJECT_LIMIT = 5; // after this many rejects in a row we resync to the client
const WORLD_LIMIT = 500 * WORLD_SCALE; // 1167.8 — absolute coordinate clamp (map spans ~±140)
// UT99's Enforcer damage, exactly (Botpack.Enforcer HitDamage=17). Was 20, which is a
// number nothing in the source justifies and which put a kill at five hits: at the
// 4 shots/s fire rate, 1.25 s of sustained fire from one opponent. 17 makes it six
// hits and 1.50 s, and it is the figure the rest of the weapon is already built to.
// The other half of "it is too easy to die" was bots shooting through the rock, which
// is server/bots.js's canSee().
const HIT_DAMAGE = 17; // fixed server-side damage per hit

// ---- pickups ----
// UT99's Enforcer progression: pick up a second one and you dual-wield. Same
// weapon, twice the guns. Ownership MUST live here — if the client decided, two
// players standing on the same pedestal would both walk away with it.
const PICKUP_RESPAWN = 20000; // ms before a taken pickup returns
// How close a player must be to claim one. NOT world-anchored, and the x k it used to
// carry was a mistake: this is a touch radius between a body and an item, and neither
// the body nor the item changed size when the map did. At 7.01 (plus the slack below)
// pickups flew off their pedestals from nine metres away, which is what made picking
// something up feel like it happened TO you rather than because you ran over it.
// UT99's own is the item's CollisionRadius plus the pawn's — about 44 UU, and at this
// scene's 0.0235 m/UU that is 1.03 units. 1.6 keeps a little of the old generosity for
// a fast run-past without letting anyone vacuum a pedestal from across the room.
const PICKUP_RADIUS = 1.6;
// Generous against PICKUP_RADIUS on purpose: the claim is checked against the
// server's copy of the player position, which lags the client's by up to a pose
// interval, and a player running at 9.4 m/s covers ~0.9 units in that time.
// NOT scaled by k: it is speed * latency, and neither of those changed with the map.
// Sized down with the radius — 2.5 of slack on a 1.6 radius would be the slack doing
// the deciding, and it exists to forgive latency, not to widen the rule.
const PICKUP_CLAIM_SLACK = 1.0;
// The longest shot anyone can take is the map's full diagonal, and at world scale that
// is sqrt(259.4^2 + 110.0^2 + 97.2^2) = 298 units — so the old 300 had literally zero
// headroom and a genuine tower-to-tower snipe would have started coming back "out of
// range". 400 covers the diagonal with a third to spare and still refuses a hit claimed
// against someone who has fallen out of the world. Keep it >= the client's trace length
// (GAME_CONFIG.WEAPON.MAX_RANGE), or honest client hits get rejected here.
const MAX_HIT_RANGE = 400;
const HIT_ORDER_GRACE = 150; // ms a hit may arrive AHEAD of the fire that paid for it
const SHOT_LIFETIME = 2500; // ms a fired shot stays eligible to produce a hit
const MAX_PENDING_SHOTS = 32;
const FIRE_MIN_INTERVAL = 80; // ms — fastest honest weapon is 8 shots/sec (125ms), leave headroom
const FIRE_BURST = 5; // token bucket depth, absorbs client timing jitter
const HIT_MIN_INTERVAL = 80; // ms — an honest hit cannot outpace the fire rate
const HIT_BURST = 4;
const SESSION_TTL = 120000; // ms a disconnected player's score is held for resume
const RESPAWN_DELAY = 1500;

// ---- capture the flag ----
// UT99 CTF rules, kept whole: one flag per base, touch the enemy flag to carry it, die
// and it drops where you fell, touch your own DROPPED flag to send it home, and score
// only by bringing the enemy flag to your own flag while yours is standing at home.
// Every one of those decisions is made here; the client only ever asks (touchFlag),
// exactly like takePickup. Knobs are env-overridable so the test can run a 2-capture
// match with a 1.5s return timer instead of waiting 25 seconds for anything.
const CTF_CAP_LIMIT = Number(process.env.CTF_CAP_LIMIT) || 3; // UT99 GoalTeamScore
const CTF_AUTO_RETURN_MS = Number(process.env.CTF_AUTO_RETURN_MS) || 25000; // UT99 CTFFlag timer
const CTF_MATCH_RESET_MS = Number(process.env.CTF_MATCH_RESET_MS) || 10000; // scoreboard dwell after a win
const FLAG_RADIUS = Number(process.env.CTF_FLAG_RADIUS) || 4.67; // x k
// Same reasoning as PICKUP_CLAIM_SLACK: the touch is judged against the server's copy of
// the player position, which lags the client's by up to a pose interval. Speed x latency,
// so it does NOT scale with the map.
const FLAG_CLAIM_SLACK = Number(process.env.CTF_FLAG_CLAIM_SLACK) || 2.5;
const FLAG_MIN_INTERVAL = Number(process.env.CTF_FLAG_MIN_INTERVAL) || 150; // ms between honest touches
const FLAG_BURST = Number(process.env.CTF_FLAG_BURST) || 3;

// The flags stand at the FOOT of each tower, on the low plinth CTF-Face puts them on —
// FlagBase1 for blue, FlagBase0 for red, converted straight out of the level. They were
// on the roofs here until stage (b); that was wrong. In the original the roofs are SNIPER
// DECKS: you climb one for the Body Armor and the firing line, not for the objective, and
// a flag run is a run across the bridge and up into the enemy base, not two tower climbs.
//
// The reach that has to cover a touch is the CLIENT's: it is the tighter of the two gates,
// because a touch only ever happens when the client asks for one and the server can only
// refuse. GAME_CONFIG.CTF.RADIUS (7.01) is what decides whether a player standing next to
// the plinth can take the flag; FLAG_RADIUS + FLAG_CLAIM_SLACK (7.17 here) is deliberately
// looser, so a client whose position the server has not caught up with yet is not punished
// for the lag.
//
// The same two points are rendered by index.html (#flag-stand-blue / #flag-stand-red),
// which reads them from the ESM half of the same generated module — so there is no third
// copy to keep in step any more.
//
// Spread rather than aliased: MAP.FLAG_HOMES entries also carry `ry` and `ut` (the
// original actor's heading and name), and those must not leak into the flag broadcasts.
const flagHome = (team) => ({
  x: MAP.FLAG_HOMES[team].x,
  y: MAP.FLAG_HOMES[team].y,
  z: MAP.FLAG_HOMES[team].z,
});
const FLAG_HOMES = {
  blue: flagHome("blue"), // -75.11, 0.14, -19.22
  red: flagHome("red"), // 101.18, 0.43, 5.00
};

// Team spawns: all TWENTY of CTF-Face's PlayerStarts, ten a side, each keeping the
// heading Epic gave it. They sit in the two spawn rooms at each tower's foot, and the
// facings work out to +90 deg for red and -82 for blue — forward in three is
// (-sin ry, 0, -cos ry), so both teams come out of their base looking at the bridge.
// Handed out round-robin (spawnCursor below) with a small jitter so two players joining
// together do not spawn inside each other. The jitter is sized against the PLAYER capsule
// (HITBOX.RADIUS 0.34), not against the map, so it stays at 1.0 — and with ten points a
// side it now has much less work to do than it did with four.
//
// Only x/y/z/ry are taken: the generated entries also carry `ut` (the original actor's
// name), which is for tracing numbers back to the level, not for the wire.
const SPAWN_JITTER = 1.0;
const spawnPoints = (team) => MAP.SPAWNS[team].map((s) => ({ x: s.x, y: s.y, z: s.z, ry: s.ry }));
const SPAWNS = {
  blue: spawnPoints("blue"),
  red: spawnPoints("red"),
};
const spawnCursor = { red: 0, blue: 0 };

// ---- map geometry, derived rather than guessed ----
// The lowest navmesh polygon (the pedestal ground both bases stand on), measured off
// assets/3d/navmesh.gltf at -0.175 and x k by the generator.
const GROUND_Y = MAP.GROUND_Y; // -0.41
// Below this the carrier was not standing anywhere — they were falling off the map, or
// already under it. A flag left down there is a flag the match never gets back. x k.
const MAP_FLOOR_Y = -4.67;
// The two tower roofs: the only walkable surface on the map above the bridge, and — now
// that the flags live at ground level — no longer anything to do with FLAG_HOMES. They
// are the sniper decks, and the Enforcer pedestals stand on them.
//
// Centre and height come from the generated table: y is the navmesh's highest polygon
// (30.425 x k), and each centre is the x/z centre of that tower's mesh column. The two
// sources agree — converting CTF-Face's own roof-top Body Armor actors through the
// transform lands them at 71.19 and 71.77 against this 71.06 deck, i.e. sitting on it.
const ROOF_Y = MAP.TOWER_ROOFS.blue.y; // 71.06; the red deck is the same height
const ROOF_CENTRES = [MAP.TOWER_ROOFS.red, MAP.TOWER_ROOFS.blue];
// Half-extent of the "above a tower" box around each centre: half the tower column's own
// footprint (38.1 x 40.1 at world scale). Generous against the ~8.4 x 10.3 walkable deck
// on purpose — this only ever has to be wider than the truth, because its job is to spare
// an honest player, and the nearest other geometry is seventy-odd units away across the
// bridge. Separate x and z because the towers are not square.
const ROOF_HALF_EXTENT = MAP.TOWER_ROOFS.HALF_EXTENT; // { x: 19.03, z: 20.05 }

// Horizontal playfield: the extents of the two flag plinths, the twenty team spawns and
// the two tower roofs, plus a generous margin. Every point anyone can legitimately walk,
// jump or fall onto is inside this; a drop outside it is off the map. The roofs have to
// be in the list explicitly now — they used to ride in on FLAG_HOMES, and the flags have
// come down off them. Derived bounds are x -151.4..176.6 / z -100.9..84.0, comfortably
// around the scaled navmesh (x -117.5..139.9, z -53.0..42.3).
const MAP_MARGIN = 25 * WORLD_SCALE; // 58.4
const MAP_BOUNDS = (() => {
  const pts = [...Object.values(FLAG_HOMES), ...ROOF_CENTRES, ...SPAWNS.red, ...SPAWNS.blue];
  const xs = pts.map((p) => p.x);
  const zs = pts.map((p) => p.z);
  return {
    minX: Math.min(...xs) - MAP_MARGIN,
    maxX: Math.max(...xs) + MAP_MARGIN,
    minZ: Math.min(...zs) - MAP_MARGIN,
    maxZ: Math.max(...zs) + MAP_MARGIN,
  };
})();
// Above this height nothing is walkable except those roofs, so a pose up here anywhere
// else is a fly hack rather than a lag spike. Just over the roofs, to leave normal
// jumping and the client's 0.05 navmesh lift alone.
//
// DERIVED, not multiplied: only the roof term scales. ROOF_Y (71.06) + a dodge-jump apex
// (1.44 m, which is player-anchored and did not grow) + the 0.05 lift = 72.55.
const ROOF_AIRSPACE_Y = ROOF_Y + 1.44 + 0.05; // 72.55
// A dodge-jump peaks well under this. Anything higher above a surface is not a hop.
// PLAYER-anchored: JUMP_VELOCITY and GRAVITY are unchanged, so the apex is still 1.44 m
// and this stays 4. Scaling it would let a flag snap down through 9 units of nothing.
const JUMP_CLEARANCE = 4;

function overATowerRoof(x, z) {
  for (const c of ROOF_CENTRES) {
    if (Math.abs(x - c.x) <= ROOF_HALF_EXTENT.x && Math.abs(z - c.z) <= ROOF_HALF_EXTENT.z) return true;
  }
  return false;
}

// "Is this a place a dropped flag could ever be picked up again?"
function inPlayableSpace(x, y, z) {
  if (y < MAP_FLOOR_Y) return false;
  return x >= MAP_BOUNDS.minX && x <= MAP_BOUNDS.maxX && z >= MAP_BOUNDS.minZ && z <= MAP_BOUNDS.maxZ;
}

// Strip the jump off a drop: a carrier killed mid-air would otherwise leave the flag
// hovering out of reach. Only known surfaces are snapped to, and only from within jump
// range, so a death on the arching bridge (y up to 14.3, not a level we know) leaves the
// flag exactly where the body was.
//
// Four levels now, not two: the pedestal ground, each base's flag plinth (they differ by
// 0.3, and a flag dropped a step from home should come to rest at home's height rather
// than half a unit into the plinth), and the tower decks.
const DROP_LEVELS = [...new Set([GROUND_Y, FLAG_HOMES.blue.y, FLAG_HOMES.red.y, ROOF_Y])].sort((a, b) => a - b);
function dropGroundY(y) {
  let best = y;
  let bestGap = Infinity;
  for (const level of DROP_LEVELS) {
    const gap = y - level;
    if (gap >= 0 && gap <= JUMP_CLEARANCE && gap < bestGap) {
      bestGap = gap;
      best = level;
    }
  }
  return best;
}

// One state machine per flag: home -> carried -> dropped -> home. `returnAt` is only
// meaningful while dropped, `carrier` only while carried.
const flags = {
  red: { team: "red", home: FLAG_HOMES.red, state: "home", ...FLAG_HOMES.red, carrier: null, returnAt: 0 },
  blue: { team: "blue", home: FLAG_HOMES.blue, state: "home", ...FLAG_HOMES.blue, carrier: null, returnAt: 0 },
};
const match = {
  scores: { red: 0, blue: 0 },
  capLimit: CTF_CAP_LIMIT,
  state: "playing", // "playing" | "ended"
  winner: null,
  resetAt: 0,
};
// Balanced teams need a tiebreak when the sides are level; alternate rather than
// randomise so two players joining back to back always land on opposite sides.
let nextTieTeam = "red";
const otherTeam = (t) => (t === "red" ? "blue" : "red");

const players = new Map(); // id -> {id,name,hp,x,y,z,ry,kills,...private fields}
const clients = new Map(); // ws -> id
const lastPoseUpdate = new Map(); // id -> timestamp
const sessions = new Map(); // sessionKey -> {kills,name,team,expires} — score/team resume across reconnects
const claimedSessions = new Map(); // sessionKey -> live player id currently owning that key
const spectators = new Map(); // ws -> spectator id (observers, never part of the game)

// Pickups. Every position is CTF-Face's own, out of the generated actor table — x and z
// straight through the transform, y snapped to the surface the item stands on plus the
// unscaled ~1-unit hover a UT pickup floats at relative to the PLAYER walking into it.
// (A hover of 1.0 x k would have put them at 1.92, over the head of a 1.83 m soldier.)
const pickups = new Map(); // id -> {id, type, x, y, z, availableAt}

function definePickup(id, type, { x, y, z }) {
  pickups.set(id, { id, type, x, y, z, availableAt: 0 });
}

// --- the second Enforcer, one on each TOWER ROOF ---
//
// CTF-Face has no Enforcer pickup at all — in UT99 you spawn with one and the map's job
// is to hand you something better. So these two stand where the original puts its BODY
// ARMOR: on the sniper decks, one per tower (armor3 on blue, armor2 on red). That is the
// bargain the map is built around and the reason to make the climb — you go up for the
// firing line and you come down harder-hitting than you went. Leaving them at ground
// level, as they were, made the roofs worth nothing now that the flags are not up there.
//
// Team-labelled by which tower they sit on, not by who may take them: it is the enemy
// deck that is worth taking, and holding your own is how you stop them.
const armorOn = (team) => {
  const c = MAP.TOWER_ROOFS[team];
  const d2 = (a) => (a.x - c.x) ** 2 + (a.z - c.z) ** 2;
  return MAP.BODY_ARMOR.reduce((best, a) => (d2(a) < d2(best) ? a : best));
};
// REMOVED, deliberately. Those two coordinates are the map's BODY ARMOR, and they are
// now what UT99 puts there — see the armor entry in PICKUP_TYPE below. The reasoning
// above still holds (the roofs have to be worth climbing) and armour does the same job
// the second Enforcer was standing in for: you go up for the firing line and you come
// down harder to kill.
//
// The consequence is that nothing on this map hands out a second Enforcer any more,
// which is also true of the original — CTF-Face has no Enforcer pickup at all. The
// dual-wield code in applyHit and first-person-weapon is untouched and still works; it
// simply has no source on this map. Put `dual-enforcer` back on any actor to restore it.

// --- health, at CTF-Face's eight MedBoxes ---
//
// Four in each tower base, which is exactly where they belong: the thing that keeps a
// defender alive is in the room they are defending, and a carrier who makes it home can
// top up before going out again. Ids are stable across restarts (medbox-<actor name>) so
// a reconnecting client's pickup set lines up with the one it had.
//
// A MedBox is worth 20 in UT99 and does not overheal, which is what HEALTH_PICKUP_HP
// below is. The big 100-point HealthPack at the centre of the bridge is NOT placed: it is
// the single most contested item on the map and it wants to be balanced deliberately, not
// added because it happened to be in the table. Its coordinates are there when it is
// wanted, as MAP.HEALTH_PACK (11.52, 13.13, -9.17).
const HEALTH_PICKUP_HP = 20;
// The bridge HealthPack, and UT99's Body Armor. Armour absorbs a share of incoming
// damage until it runs out, which is what makes the sniper decks worth holding: you
// come down from one able to survive a shot you could not before.
const HEALTH_BIG_HP = 100;
const ARMOR_MAX = 100;
const ARMOR_ABSORB = 0.5; // share of a hit taken by armour rather than health
// UT99's Damage Amplifier: double damage, and it runs on a clock rather than a
// counter, so it is worth taking even when you are about to die.
const UDAMAGE_MS = 30000;
const UDAMAGE_MULT = 2;
for (const box of MAP.MED_BOXES) definePickup(`medbox-${box.name}`, "health", box);

// --- everything else CTF-Face actually has ---
//
// The other 46 actors in MAP.UT_PICKUPS, at Epic's own coordinates. The map was
// designed around them: six Sniper Rifles because the towers are firing platforms, a
// Redeemer on each side as the thing worth crossing for, ammo stacked where you run
// out. Placing ten of fifty-six and calling it CTF-Face was the biggest single gap
// between this and the original.
//
// One `type` per Unreal class. The client keys its model off the type
// (assets/3d/pickups/<class>/) and the server keys the effect off it; anything the
// server has no effect for yet still stands on the map and still respawns, because a
// Sniper Rifle you can see on the deck is already telling you what the deck is for.
//
// y comes from the actor table unsnapped, as the flags and spawns do — these are
// Epic's placements, and the navmesh is the thing with holes in it, not the map.
const PICKUP_TYPE = {
  armor2: "armor",
  UDamage: "udamage",
  HealthPack: "health-big",
  SniperRifle: "weapon-sniper",
  ShockRifle: "weapon-shock",
  UT_Eightball: "weapon-rocket",
  ripper: "weapon-ripper",
  WarheadLauncher: "weapon-redeemer",
  BulletBox: "ammo-bullet",
  RocketPack: "ammo-rocket",
  ShockCore: "ammo-shock",
};
// y needs the same treatment MAP.MED_BOXES already got in the generator, and did not
// get here: an Unreal actor's y is its COLLISION ORIGIN, not the bottom of its mesh, so
// dropped in raw these sit about a third of a unit into the floor (measured: median
// -0.31, worst -3.05). Snap to the surface the item stands on, then add the same hover
// the MedBoxes float at.
//
// Where the navmesh has no answer — 22 of the 48, all in the tower interiors it is
// missing — keep Epic's y untouched. It is the honest number, and a wrong snap onto a
// surface two storeys away would be worse than a slightly sunk box.
const PICKUP_HOVER = 0.45;
const PICKUP_SNAP_WINDOW = 4;
let snapped = 0;
for (const [cls, type] of Object.entries(PICKUP_TYPE)) {
  for (const a of MAP.UT_PICKUPS[cls] || []) {
    const ground = surfaceNear(a.x, a.z, a.y, PICKUP_SNAP_WINDOW);
    const y = ground === null ? a.y : ground + PICKUP_HOVER;
    if (ground !== null) snapped++;
    definePickup(`${cls}-${a.name}`, type, { x: a.x, y, z: a.z });
  }
}
console.log(`[server] ${pickups.size} pickups placed (${snapped} snapped to the surface)`);

function pickupIsAvailable(p, now) {
  return p.availableAt <= now;
}

function publicPickup(p, now) {
  return {
    id: p.id,
    type: p.type,
    x: q2(p.x),
    y: q2(p.y),
    z: q2(p.z),
    available: pickupIsAvailable(p, now),
    // Seconds until it returns, so a late joiner can render the timer rather
    // than a pedestal that pops into existence for no visible reason.
    respawnInMs: pickupIsAvailable(p, now) ? 0 : p.availableAt - now,
  };
}

// Optional TLS. A phone on the LAN opens the site over https:// (self-signed mkcert),
// and a secure page may not open a plain ws:// socket to a LAN IP — browsers block it as
// mixed content, so the AR spectator table would silently watch nothing. Point SSL_CERT
// and SSL_KEY at the same pair the static server uses and this listens for wss:// on the
// same port instead. Unset (the default) is byte-for-byte the previous plain-ws server.
function createServer() {
  const certPath = process.env.SSL_CERT;
  const keyPath = process.env.SSL_KEY;
  if (!certPath || !keyPath) {
    return new WebSocketServer({ port: PORT }, () => console.log(`✅ ws server on :${PORT}`));
  }

  // A misread cert must fail loudly here rather than half-start an unreachable server.
  const creds = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  const httpsServer = https.createServer(creds);
  httpsServer.listen(PORT, () => console.log(`✅ wss server on :${PORT} (TLS)`));
  return new WebSocketServer({ server: httpsServer });
}

const wss = createServer();

const id4 = () => crypto.randomBytes(3).toString("hex");

// Quantize to 2 decimals (1cm) for position, 3 for radians — cuts JSON payloads roughly in half
const q2 = (n) => Math.round(n * 100) / 100;
const q3 = (n) => Math.round(n * 1000) / 1000;

// Strict numeric guard. JSON turns NaN/Infinity into null and `+null` is 0, so a
// plain Number.isFinite(+v) check would silently accept garbage as the origin.
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// Never leak private fields (session token, anti-cheat bookkeeping) to other clients
function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    hp: p.hp,
    x: q2(p.x),
    y: q2(p.y),
    z: q2(p.z),
    ry: q3(p.ry),
    kills: p.kills || 0,
    speed: q2(p.speed || 0),
    animation: p.animation || { idle: 1, walk: 0, run: 0 },
    dual: !!p.dual,
    team: p.team || null,
    flag: p.flag || null, // the team colour of the flag this player is carrying
    // Which UT99 body this player wears. An index into server/characters.js, chosen
    // here rather than on the client so everyone sees the same person as the same
    // character — and so a bot keeps its face for the life of the match.
    character: typeof p.character === "number" ? p.character : 0,
    armor: p.armor || 0,
  };
}

// The flag as everyone else is allowed to see it. Position means home when home, where
// it fell when dropped, and the carrier's position at the moment of the take when
// carried (the carrier's own pose stream is what actually moves it on screen).
function publicFlag(f, now) {
  return {
    team: f.team,
    state: f.state,
    x: q2(f.x),
    y: q2(f.y),
    z: q2(f.z),
    carrier: f.carrier,
    returnInMs: f.state === "dropped" ? Math.max(0, f.returnAt - now) : 0,
  };
}

function publicCtf(now) {
  return {
    flags: [publicFlag(flags.red, now), publicFlag(flags.blue, now)],
    scores: { ...match.scores },
    capLimit: match.capLimit,
    state: match.state,
    winner: match.winner,
    resetInMs: match.state === "ended" ? Math.max(0, match.resetAt - now) : 0,
  };
}

// Token bucket shared by the fire and hit limiters
function takeToken(bucket, now, interval, depth) {
  const elapsed = now - bucket.ts;
  bucket.ts = now;
  bucket.tokens = Math.min(depth, bucket.tokens + elapsed / interval);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// A client that connects with ?spectate=1 is a pure observer (AR spectator table, stream
// overlay, …). req.url is attacker-controlled and may be absent on odd transports, so this
// must never throw — anything unparseable is treated as a normal player.
function isSpectatorRequest(req) {
  try {
    const raw = req && req.url;
    if (typeof raw !== "string" || raw.length === 0) return false;
    const v = new URL(raw, "http://localhost").searchParams.get("spectate");
    if (v === null) return false;
    return v !== "0" && v.toLowerCase() !== "false";
  } catch {
    return false;
  }
}

// Session tokens live in localStorage, which is shared by every tab of the same origin —
// exactly how this game gets tested locally. Two tabs therefore present the SAME token and,
// keyed naively, their stashes clobber each other on disconnect. Only the first live claimant
// gets the bare key; every later connection presenting an already-claimed token is given a
// private, per-connection key (and no resume, since the score under the bare key belongs to
// the connection still holding it).
function claimSession(id, token) {
  if (!claimedSessions.has(token)) {
    claimedSessions.set(token, id);
    return { key: token, resumable: true };
  }
  const key = `${token}#${id}`;
  claimedSessions.set(key, id);
  return { key, resumable: false };
}

function releaseSession(key, id) {
  if (key && claimedSessions.get(key) === id) claimedSessions.delete(key);
}

// Count the live sides. Never stored: a cached count and a Map that a socket error can
// prune behind your back drift apart, and the drift is a permanently lopsided match.
function teamCounts(excludeId) {
  const counts = { red: 0, blue: 0 };
  for (const p of players.values()) {
    if (excludeId && p.id === excludeId) continue;
    if (p.team === "red" || p.team === "blue") counts[p.team]++;
  }
  return counts;
}

// Smaller side on join, alternating on a tie. The tiebreak flips after EVERY join, not
// only after a tie, so four players joining an empty server land red/blue/red/blue
// instead of red/blue/blue/red. Nobody is ever moved after the fact — UT99 does not
// switch you mid-match just because someone else left.
function assignTeam() {
  const counts = teamCounts();
  const team = counts.red < counts.blue ? "red" : counts.blue < counts.red ? "blue" : nextTieTeam;
  nextTieTeam = otherTeam(team);
  return team;
}

// The old randomSpawn dropped players at (±5, 0, ±5) — dead centre of the bridge gap,
// which is not on the navmesh at all. Spawns are team spawns now.
function teamSpawn(p) {
  const list = SPAWNS[p.team] || SPAWNS.blue;
  const point = list[spawnCursor[p.team] % list.length];
  spawnCursor[p.team] = (spawnCursor[p.team] + 1) % list.length;
  p.x = clampWorld(point.x + (Math.random() * 2 - 1) * SPAWN_JITTER);
  p.y = point.y;
  p.z = clampWorld(point.z + (Math.random() * 2 - 1) * SPAWN_JITTER);
  p.ry = point.ry;
  // Spawning is a legitimate teleport — reset the plausibility baseline with it.
  p.lastX = p.x;
  p.lastY = p.y;
  p.lastZ = p.z;
  p.poseRejects = 0;
  p.spawnTeam = p.team;
  return p;
}

wss.on("connection", (ws, req) => {
  // Heartbeat — a socket that misses two pings is dead and gets reaped. Wired for
  // spectators too, before the early return below, so observer sockets cannot leak.
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  if (isSpectatorRequest(req)) {
    const sid = id4();
    ws.isSpectator = true;
    spectators.set(ws, sid);
    console.log(`[server] spectator ${sid} connected (${spectators.size} watching)`);

    // A spectator is never in `players`, so it is never broadcast as a join, never in
    // highscore-update, and never targetable. It still sees the whole world: broadcast()
    // walks wss.clients, which includes this socket.
    const specNow = Date.now();
    send(ws, {
      type: "hello",
      yourId: sid,
      spectator: true,
      players: [...players.values()].map(publicPlayer),
      pickups: [...pickups.values()].map((p) => publicPickup(p, specNow)),
      // An observer belongs to neither side and gets no spawn, but it sees the whole
      // match: the flags, the score and every later flag/ctf-score/match-* broadcast.
      team: null,
      ctf: publicCtf(specNow),
    });
    // Seed the scoreboard for this socket only — the players must learn nothing.
    send(ws, { type: "highscore-update", players: highscoreList() });

    // Every inbound message is dropped on the floor. A spectator cannot pose, fire, hit,
    // rename or spawn, so it has no way to mutate game state or grief.
    ws.on("message", () => {});

    ws.on("close", () => {
      spectators.delete(ws);
      // No leave broadcast — nobody was ever told this socket joined.
      console.log(`[server] spectator ${sid} disconnected (${spectators.size} watching)`);
    });

    ws.on("error", (err) => {
      console.warn(`[server] spectator socket error for ${sid}:`, err && err.message);
    });
    return;
  }

  const id = id4();
  clients.set(ws, id);

  const p = {
    id,
    name: `Player_${id}`,
    hp: PLAYER_HP,
    x: 0,
    y: 0,
    z: 0,
    ry: 0,
    kills: 0,
    speed: 0,
    // --- private (never sent to other clients) ---
    session: null,
    sessionResumable: false, // false when this connection was isolated off a claimed token
    lastX: 0,
    lastY: 0,
    lastZ: 0,
    poseRejects: 0,
    spawned: false, // the client sends "spawn" exactly once, right after connecting
    shots: [], // timestamps of fired-but-unclaimed shots
    pendingHit: null, // one hit awaiting the fire message right behind it
    fireBucket: { tokens: FIRE_BURST, ts: Date.now() },
    hitBucket: { tokens: HIT_BURST, ts: Date.now() },
    team: null, // assigned just below, fixed for the connection
    character: 0, // assigned just below, fixed for the connection
    armor: 0, // absorbs a share of incoming damage; from the map's Body Armor
    udamageUntil: 0, // ms timestamp; while in the future, this player deals double
    flag: null, // "red"|"blue" while carrying that team's flag
    spawnTeam: null, // the team the current spawn point was picked for
    respawnTimer: null, // in-flight applyHit respawn, so a match reset can cancel it
    flagBucket: { tokens: FLAG_BURST, ts: Date.now() },
    // last broadcast pose, for "did anything actually change" suppression
    bx: null,
    by: null,
    bz: null,
    bry: null,
    banim: "",
  };
  // Team first: the spawn point depends on it, and so does everything in `hello`.
  p.team = assignTeam();
  // A body nobody on the map is already wearing, where there is one to spare.
  p.character = pickCharacter([...players.values()].map((o) => o.character));
  teamSpawn(p);
  players.set(id, p);

  const helloNow = Date.now();
  send(ws, {
    type: "hello",
    yourId: id,
    players: [...players.values()].map(publicPlayer),
    pickups: [...pickups.values()].map((pk) => publicPickup(pk, helloNow)),
    team: p.team,
    // The assigned team spawn. The client places its rig here BEFORE it sends `spawn`,
    // so the pose loop starts from the same point the server is already judging against
    // and the first pose is not read as a teleport.
    spawn: { x: q2(p.x), y: q2(p.y), z: q2(p.z), ry: q3(p.ry) },
    ctf: publicCtf(helloNow),
  });
  console.log(`[server] ${p.name} joined the ${p.team} team`);
  broadcastExcept(ws, { type: "join", player: publicPlayer(p) });
  broadcastHighscore(); // Send initial highscore

  ws.on("message", (buf) => {
    let m;
    try {
      m = JSON.parse(buf.toString());
    } catch {
      return;
    }
    const me = players.get(id);
    if (!me) return;

    switch (m.type) {
      case "setName": {
        let clean =
          String(m.name || "")
            .slice(0, MAX_NAME)
            .trim() || `Player_${id}`;
        // Humans share seven names with BOT_NAMES and two humans can pick the
        // same one; two identical scoreboard rows help nobody. The newcomer
        // gets a numeric suffix.
        {
          const want = clean;
          let n = 2;
          const taken = () => { for (const p of players.values()) if (p !== me && p.name === clean) return true; return false; };
          while (taken()) clean = `${want} ${n++}`.slice(0, MAX_NAME + 3);
        }
        me.name = clean;

        // Optional session token — lets a reconnecting player resume the score the
        // SERVER counted for them, instead of the client declaring its own score.
        if (!me.session && typeof m.session === "string" && m.session.length > 0) {
          const { key, resumable } = claimSession(id, m.session.slice(0, 64));
          me.session = key;
          me.sessionResumable = resumable;
          const stash = resumable ? sessions.get(key) : null;
          if (stash && stash.expires > Date.now()) {
            me.kills = stash.kills;
            // Your side survives a reconnect the way it does in UT99 — but never at the
            // cost of a lopsided match, so the switch happens only while it keeps the two
            // teams within one player of each other. The stash rides in on `setName`, one
            // message after `hello` already announced a count-balanced team, so this can
            // flip a client's team once, within a few ms of connecting. Clients are told
            // with a `team` message rather than being left to guess.
            if ((stash.team === "red" || stash.team === "blue") && stash.team !== me.team) {
              const counts = teamCounts(id);
              if (Math.abs(counts[stash.team] + 1 - counts[otherTeam(stash.team)]) <= 1) {
                me.team = stash.team;
                // The spawn point handed out in `hello` belongs to the side this player
                // just left, so it has to be re-rolled. Normally the `spawn` handler does
                // it: it sees me.spawnTeam !== me.team and picks a new one.
                //
                // me.spawned is FALSE here in every reachable ordering, so the two guards
                // below never fire. The session token only ever rides in on the FIRST
                // setName (the `if (!me.session)` above), the client sends that one from
                // onopen, and it sends `spawn` only after it has received `hello` — a
                // later message on the same ordered socket. There is no race: setName is
                // always processed first. A second setName (a rename) cannot get here at
                // all, because me.session is set by then.
                //
                // They are kept as explicit defence, not as a race fix: a client that
                // spoke out of order, or a future caller that resumes a session on an
                // already-spawned player, would otherwise leave that player standing in
                // the enemy base until they died.
                if (me.spawned) teamSpawn(me);
                broadcast({ type: "team", id, team: me.team });
                if (me.spawned) broadcast({ type: "respawn", player: publicPlayer(me) });
                console.log(`[server] ${clean} resumed on the ${me.team} team`);
              }
            }
            sessions.delete(key);
            console.log(`[server] ${clean} resumed session with ${me.kills} kills`);
          } else if (!resumable) {
            console.log(`[server] ${clean} presented an already-claimed session token; isolated as ${key}`);
          }
        }

        broadcast({ type: "name", id, name: clean });
        broadcastHighscore();
        break;
      }

      case "setScore": {
        // Neutered on purpose: kills are counted server-side in `clientHit`, so a
        // client can no longer declare its own score. Accepted and ignored so that
        // older clients (which still send this on connect) do not break.
        break;
      }

      case "spawn": {
        // Honoured ONCE per connection. The client sends it as soon as it has put its rig
        // on the point `hello.spawn` gave it. Accepting it again would hand any client a
        // free full heal and an unchecked teleport to any coordinate, which would defeat
        // both the server-side damage model and the pose plausibility cap below. Respawns
        // are server-driven (see applyHit) and never come from here.
        if (me.spawned) break;
        me.spawned = true;
        // m.position and m.ry are ignored: a client asserting its own position was always
        // a free teleport, and the spawn is the server's to choose. The point was already
        // picked at connection and shipped in `hello.spawn`; re-rolling it here would
        // yank a rig that is standing exactly where both sides agree it should be. Only a
        // team that changed underneath us (a session stash resumed in setName) earns one.
        if (me.spawnTeam !== me.team) teamSpawn(me);
        me.hp = PLAYER_HP;
        // Spawning is a legitimate teleport — reset the plausibility baseline
        me.lastX = me.x;
        me.lastY = me.y;
        me.lastZ = me.z;
        me.poseRejects = 0;
        me.shots.length = 0;
        me.pendingHit = null;
        // Don't reset kills — they are owned by the server
        broadcast({ type: "spawn", player: publicPlayer(me) });
        break;
      }

      case "pose": {
        const now = Date.now();
        // Nothing has a position until the client has taken the spawn the server picked.
        // Storing a pose before that would overwrite the point `hello.spawn` promised —
        // and hand a client that never spawns a free position it was never given.
        if (!me.spawned) return;
        const lastUpdate = lastPoseUpdate.get(id) || 0;

        // Throttle pose updates to prevent spam
        if (now - lastUpdate < POSE_UPDATE_INTERVAL) return;

        // Reject anything non-numeric outright rather than partially applying it
        const x = m.x,
          y = m.y,
          z = m.z,
          ry = m.ry;
        if (!isNum(x) || !isNum(y) || !isNum(z) || !isNum(ry)) return;
        if (Math.abs(x) > WORLD_LIMIT || Math.abs(y) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) return;

        // Ceiling. The speed cap below only limits how FAST you climb, so a patient
        // cheater could walk up the sky a hundred units a second and sit above a base
        // shooting down with nothing able to reach them. Above the tower roofs the only
        // legal airspace is directly over one of the two roofs.
        if (y > ROOF_AIRSPACE_Y && !overATowerRoof(x, z)) return;

        // Teleport check — cap the distance covered since the last accepted pose
        const dt = Math.min(1, Math.max(0.02, (now - (lastUpdate || now)) / 1000));
        const maxDist = MAX_POSE_SPEED * dt + POSE_SLACK;
        const dx = x - me.lastX,
          dy = y - me.lastY,
          dz = z - me.lastZ;
        if (dx * dx + dy * dy + dz * dz > maxDist * maxDist) {
          me.poseRejects++;
          // A long stall can look like a teleport; after a few in a row believe the
          // client and resync rather than freezing them in place forever.
          if (me.poseRejects <= POSE_REJECT_LIMIT) {
            lastPoseUpdate.set(id, now);
            return;
          }
        }
        me.poseRejects = 0;

        me.x = x;
        me.y = y;
        me.z = z;
        me.ry = ry;
        me.lastX = x;
        me.lastY = y;
        me.lastZ = z;
        if (isNum(m.speed)) me.speed = Math.max(0, Math.min(MAX_POSE_SPEED, m.speed));

        // Store animation state
        if (m.animation) {
          me.animation = {
            idle: clamp01(m.animation.idle),
            walk: clamp01(m.animation.walk),
            run: clamp01(m.animation.run),
          };
        }

        lastPoseUpdate.set(id, now);

        // Quantize, then skip the broadcast entirely if nothing meaningfully moved
        const qx = q2(me.x),
          qy = q2(me.y),
          qz = q2(me.z),
          qry = q3(me.ry);
        const anim = me.animation || { idle: 1, walk: 0, run: 0 };
        const animKey = `${q2(anim.idle)},${q2(anim.walk)},${q2(anim.run)}`;
        if (qx === me.bx && qy === me.by && qz === me.bz && qry === me.bry && animKey === me.banim) return;

        const animChanged = animKey !== me.banim;
        me.bx = qx;
        me.by = qy;
        me.bz = qz;
        me.bry = qry;
        me.banim = animKey;

        const out = { type: "pose", id, t: now, x: qx, y: qy, z: qz, ry: qry, speed: q2(me.speed || 0) };
        // Only ship the animation block when it actually changed (clients carry it forward)
        if (animChanged) out.animation = anim;
        broadcastExcept(ws, out);
        break;
      }

      case "fire": {
        const now = Date.now();
        if (me.hp <= 0) break;
        if (!m.origin || !m.dir) break;
        const ox = m.origin.x,
          oy = m.origin.y,
          oz = m.origin.z;
        const dxr = m.dir.x,
          dyr = m.dir.y,
          dzr = m.dir.z;
        if (![ox, oy, oz, dxr, dyr, dzr].every(isNum)) break;
        if (Math.abs(ox) > WORLD_LIMIT || Math.abs(oy) > WORLD_LIMIT || Math.abs(oz) > WORLD_LIMIT) break;
        if (!takeToken(me.fireBucket, now, FIRE_MIN_INTERVAL, FIRE_BURST)) break;

        // Credit the shot — a hit must later be paid for by one of these
        me.shots.push(now);
        if (me.shots.length > MAX_PENDING_SHOTS) me.shots.shift();

        // A hitscan client resolves the trace before it tells us it fired, so the
        // clientHit can legitimately arrive just ahead of its own fire. Settle any
        // hit that was parked waiting for this shot.
        if (me.pendingHit) {
          const ph = me.pendingHit;
          me.pendingHit = null;
          if (now - ph.at <= HIT_ORDER_GRACE && canHit(me, ph.victimId)) {
            me.shots.shift();
            applyHit(me, players.get(ph.victimId));
          }
        }

        broadcastExcept(ws, {
          type: "fire",
          id,
          origin: { x: q2(ox), y: q2(oy), z: q2(oz) },
          dir: { x: q3(dxr), y: q3(dyr), z: q3(dzr) },
          t: now,
        });
        break;
      }

      case "takePickup": {
        const now = Date.now();
        const p = pickups.get(String(m.id || ""));
        if (!p || !pickupIsAvailable(p, now)) break;
        if (me.hp <= 0) break; // a corpse does not shop

        // Distance is checked against the SERVER's copy of the position. A client
        // could otherwise claim a pickup from across the map by asserting it was
        // standing on it.
        const dx = me.x - p.x;
        const dy = me.y - p.y;
        const dz = me.z - p.z;
        const reach = PICKUP_RADIUS + PICKUP_CLAIM_SLACK;
        if (dx * dx + dy * dy + dz * dz > reach * reach) break;

        // Already dual-wielding, or already at full health: leave the pickup standing for
        // someone who wants it. Both are the same rule — an item that would do nothing is
        // an item you walk past, which is how UT99 behaves and what stops a player parked
        // on a MedBox soaking up its respawns for free.
        if (p.type === "dual-enforcer" && me.dual) break;
        if (p.type === "health" && me.hp >= PLAYER_HP) break;
        if (p.type === "health-big" && me.hp >= PLAYER_HP) break;
        if (p.type === "armor" && me.armor >= ARMOR_MAX) break;

        p.availableAt = now + PICKUP_RESPAWN;
        if (p.type === "dual-enforcer") me.dual = true;
        if (p.type === "health") me.hp = Math.min(PLAYER_HP, me.hp + HEALTH_PICKUP_HP);
        // The HealthPack at the centre of the bridge. 100 in UT99, and the single most
        // contested item on the map: it is worth five MedBoxes and it sits in the open
        // exactly where both teams have to cross. No overheal — UT99 lets it run to 199
        // and that is a bigger balance decision than a pickup placement.
        if (p.type === "health-big") me.hp = Math.min(PLAYER_HP, me.hp + HEALTH_BIG_HP);
        if (p.type === "armor") me.armor = ARMOR_MAX;
        // The Damage Amplifier, one on each ramp. Doubles what you deal, for a while.
        if (p.type === "udamage") me.udamageUntil = now + UDAMAGE_MS;

        broadcast({
          type: "pickup-taken",
          id: p.id,
          by: me.id,
          respawnInMs: PICKUP_RESPAWN,
        });
        // Health is server-authoritative like damage is, so healing goes out on the wire
        // as its own message rather than riding on `hit` — a client that read a heal as a
        // hit would flash the damage vignette for being given health.
        if (p.type === "health" || p.type === "health-big") broadcast({ type: "health", id: me.id, hp: me.hp });
        if (p.type === "armor") broadcast({ type: "armor", id: me.id, armor: me.armor });
        if (p.type === "dual-enforcer") broadcast({ type: "loadout", id: me.id, dual: !!me.dual });
        console.log(`[server] ${me.name} took ${p.type} (${p.id})`);
        break;
      }

      // "I am standing on this flag." The server works out what that MEANS — take the
      // enemy's, return your own, or capture — from who is asking and what they carry.
      // Refusals are silent, exactly like takePickup: a client that is out of position
      // or out of turn simply sees nothing happen.
      case "touchFlag": {
        // Every rule — match state, the rate limit, the reach, and what a touch MEANS —
        // lives in tryTouchFlag(). The bots call the same function rather than reaching
        // into `flags` themselves, so there is exactly one copy of this validation and a
        // bot can no more take a flag from across the map than a client can.
        tryTouchFlag(me, m.team);
        break;
      }

      case "clientHit": {
        const now = Date.now();
        if (!canHit(me, m.victimId)) break;

        // Rate limit: an honest client cannot land hits faster than it can fire
        if (!takeToken(me.hitBucket, now, HIT_MIN_INTERVAL, HIT_BURST)) break;

        // Every hit must be paid for by a shot this player actually fired recently
        while (me.shots.length && now - me.shots[0] > SHOT_LIFETIME) me.shots.shift();
        if (me.shots.length) {
          me.shots.shift();
          applyHit(me, players.get(m.victimId));
        } else {
          // No shot to pay for it yet. Park it — the matching "fire" may be a
          // fraction of a millisecond behind (see the fire handler). One only, so
          // this can never become a queue of free damage.
          me.pendingHit = { victimId: m.victimId, at: now };
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    const me = players.get(id);
    // Hold this player's server-counted score briefly so a reconnect can resume it.
    // An isolated key (`token#<playerId>`) contains a per-connection id that no future
    // connection can ever present, so stashing under it is a write nothing can read —
    // skip it rather than parking dead entries in `sessions` for the whole TTL.
    // Leaving with the flag does not take it out of the match — it falls where you stood
    // and the auto-return timer starts, the same as dying with it.
    dropFlag(me, "disconnected");
    if (me && me.respawnTimer) {
      clearTimeout(me.respawnTimer);
      me.respawnTimer = null;
    }
    if (me && me.session) {
      if (me.sessionResumable) {
        sessions.set(me.session, {
          kills: me.kills || 0,
          name: me.name,
          team: me.team,
          expires: Date.now() + SESSION_TTL,
        });
      }
      releaseSession(me.session, id);
    }
    players.delete(id);
    clients.delete(ws);
    lastPoseUpdate.delete(id);
    broadcast({ type: "leave", id });
    broadcastHighscore(); // Update highscore when player leaves
  });

  ws.on("error", (err) => {
    console.warn(`[server] socket error for ${id}:`, err && err.message);
  });
});

// ---- bots ----
// Created here, after every function and table it borrows exists. The context is explicit
// rather than a module-wide reach-in so that bots.js holds no second copy of any rule:
// tryTouchFlag is the flag rule, canHit/applyHit are the damage path the clientHit
// handler uses, teamSpawn is the spawn every respawn already goes through.
const bots = createBots({
  players,
  flags,
  match,
  lastPoseUpdate,
  PLAYER_HP,
  MAX_POSE_SPEED,
  ROOF_AIRSPACE_Y,
  FIRE_BURST,
  HIT_BURST,
  FLAG_BURST,
  FLAG_RADIUS,
  id4,
  q2,
  q3,
  clampWorld,
  otherTeam,
  publicPlayer,
  broadcast,
  broadcastHighscore,
  teamSpawn,
  dropFlag,
  tryTouchFlag,
  canHit,
  applyHit,
});

// ---- heartbeat: reap sockets that stopped answering, sweep expired sessions ----
// Pickup respawn sweep. One timer for every pedestal rather than a setTimeout per
// claim: a timer per claim would have to be cancelled on shutdown and could fire
// against a pickup that was redefined underneath it. A 500ms sweep is well inside
// the resolution anyone can perceive on a 20s respawn.
const worldSweep = setInterval(() => {
  const now = Date.now();
  for (const p of pickups.values()) {
    // availableAt of 0 means "has always been available" — nothing to announce.
    if (p.availableAt === 0 || p.availableAt > now) continue;
    p.availableAt = 0;
    broadcast({ type: "pickup-respawn", id: p.id });
  }
  // A dropped flag nobody reached goes home on its own. Without this a flag shot off a
  // ledge, or dropped by the last player on a side, would take the match with it.
  for (const f of [flags.red, flags.blue]) {
    // A carrier can leave `players` without the close handler ever running its drop —
    // a socket error, a heartbeat reap, an exception between the two. The flag would
    // then sit in "carried" behind a player nobody can shoot, forever: no drop, no
    // return timer, no second half of the match. Drop it where it stands instead.
    if (f.state === "carried" && !players.has(f.carrier)) {
      const orphan = f.carrier;
      f.carrier = null;
      if (inPlayableSpace(f.x, f.y, f.z)) {
        f.state = "dropped";
        f.y = dropGroundY(f.y);
        f.returnAt = now + CTF_AUTO_RETURN_MS;
        broadcastFlag(f, "dropped", null);
        console.log(`[server] the ${f.team} flag dropped — carrier ${orphan} is gone`);
      } else {
        returnFlag(f, null);
      }
      continue;
    }
    if (f.state === "dropped" && now >= f.returnAt) returnFlag(f, null);
  }
  if (match.state === "ended" && now >= match.resetAt) resetMatch();
  // Roster only — bots move and think on their own 20 Hz timer. Throttled inside to a
  // check every few seconds, so this is a cheap call ten times a second.
  bots.sweep(now);
}, 500);
worldSweep.unref && worldSweep.unref();

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }

  const now = Date.now();
  for (const [key, s] of sessions) if (s.expires <= now) sessions.delete(key);
}, HEARTBEAT_INTERVAL);

wss.on("close", () => clearInterval(heartbeat));

function clamp01(n) {
  return isNum(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function clampWorld(n) {
  return Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, n));
}

// Preconditions shared by the immediate and the parked (out-of-order) hit paths.
// Dead players don't shoot, dead players don't get shot, nobody shoots themselves,
// and the victim has to be plausibly within weapon range of the shooter.
function canHit(shooter, victimId) {
  const victim = players.get(victimId);
  if (!victim || victim.hp <= 0 || victim.id === shooter.id || shooter.hp <= 0) return false;
  const dx = victim.x - shooter.x,
    dy = victim.y - shooter.y,
    dz = victim.z - shooter.z;
  return dx * dx + dy * dy + dz * dz <= MAX_HIT_RANGE * MAX_HIT_RANGE;
}

function applyHit(shooter, victim) {
  const now = Date.now();
  // The client never gets to pick the damage. It is the weapon's number, doubled while
  // the shooter is holding a Damage Amplifier, and then split with the victim's armour.
  let dmg = HIT_DAMAGE;
  if (shooter.udamageUntil > now) dmg *= UDAMAGE_MULT;

  // Armour takes its share first and wears down doing it, so a plated player survives
  // longer without ever being unkillable — the shots still land, they just cost more.
  if (victim.armor > 0) {
    const absorbed = Math.min(victim.armor, Math.round(dmg * ARMOR_ABSORB));
    victim.armor -= absorbed;
    dmg -= absorbed;
    broadcast({ type: "armor", id: victim.id, armor: victim.armor });
  }

  victim.hp = Math.max(0, victim.hp - dmg);
  broadcast({ type: "hit", victimId: victim.id, victimName: victim.name, by: shooter.id, hp: victim.hp });
  if (victim.hp > 0) return;

  // The flag falls before the body: clients see `flag` then `death`, so the drop is
  // already on screen when the kill message lands rather than a beat behind it.
  dropFlag(victim, `killed by ${shooter.name}`);

  // Award kill to attacker
  shooter.kills++;
  console.log(`[server] ${shooter.name} killed ${victim.name} (${shooter.kills} kills)`);

  broadcast({ type: "death", id: victim.id, by: shooter.id });
  broadcast({ type: "player-kill", killerId: shooter.id, victimId: victim.id });
  broadcastHighscore(); // Broadcast updated highscore

  // Held so a match reset (or a second death) can cancel it — a stale timer firing into
  // a fresh match teleports a player who is already standing on a new spawn.
  if (victim.respawnTimer) clearTimeout(victim.respawnTimer);
  victim.respawnTimer = setTimeout(() => {
    const v = players.get(victim.id);
    if (!v) return;
    v.respawnTimer = null;
    v.hp = PLAYER_HP;
    v.armor = 0; // armour and the amplifier die with you, as in UT99
    v.udamageUntil = 0;
    // The second Enforcer does not survive you. Dying costs the pickup, which is
    // what makes holding the bridge mean something.
    v.dual = false;
    v.flag = null;
    // A victim killed before it ever sent `spawn` (shot on the loading screen —
    // no longer possible from bots, still possible from humans) must not be
    // silently moved: its client still sits on the hello.spawn point and the
    // first pose after load would read as a teleport. Leave the point alone.
    if (v.spawned) teamSpawn(v);
    v.animation = { idle: 1, walk: 0, run: 0 };
    v.speed = 0;
    v.shots.length = 0;
    v.pendingHit = null;
    broadcast({ type: "respawn", player: publicPlayer(v) });
  }, RESPAWN_DELAY);
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

function broadcastExcept(exceptWs, msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws !== exceptWs && ws.readyState === ws.OPEN) ws.send(data);
}

// Built from `players` only, so a spectator can never appear on the scoreboard
function highscoreList() {
  return Array.from(players.values()).map((player) => ({
    id: player.id,
    name: player.name,
    kills: player.kills || 0,
    team: player.team || null,
  }));
}

function broadcastHighscore() {
  broadcast({
    type: "highscore-update",
    players: highscoreList(),
  });
}

// ---- flag transitions ----
// One message type for every transition, so a client has exactly one code path to write
// and a late `flag` can never disagree with the state it already has.
function broadcastFlag(f, event, by) {
  broadcast({
    type: "flag",
    ...publicFlag(f, Date.now()),
    event,
    by: by ? by.id : null,
    byName: by ? by.name : null,
    byTeam: by ? by.team : null,
  });
}

function sendFlagHome(f) {
  f.state = "home";
  f.x = f.home.x;
  f.y = f.home.y;
  f.z = f.home.z;
  f.carrier = null;
  f.returnAt = 0;
}

// `by` is the player who touched it, or null for the auto-return timer.
function returnFlag(f, by) {
  sendFlagHome(f);
  broadcastFlag(f, "returned", by);
  console.log(`[server] the ${f.team} flag was returned${by ? ` by ${by.name}` : " (timed out)"}`);
}

// Called when a carrier dies and when one disconnects. The flag lands on the carrier's
// last accepted pose, which is a position the server itself validated.
function dropFlag(p, reason) {
  if (!p || !p.flag) return;
  const f = flags[p.flag];
  p.flag = null;
  // Defensive: if the flag has already moved on (a capture racing a death), leave it be
  // rather than dragging it back out of its new state.
  if (!f || f.carrier !== p.id) return;
  const dx = clampWorld(p.x);
  const dy = clampWorld(p.y);
  const dz = clampWorld(p.z);
  f.carrier = null;
  // Dying in the void takes the flag with you otherwise. Face is two towers over a
  // bottomless drop, so "killed while falling" is an ordinary way to die here, and a
  // flag dropped at y = -180 (or out past the pedestals) is one nobody can ever touch
  // again — the match would stall until the auto-return timer bailed it out, and any
  // carrier could stall it deliberately by jumping off. Send it home instead.
  if (!inPlayableSpace(dx, dy, dz)) {
    returnFlag(f, null);
    console.log(`[server] ${p.name} took the ${f.team} flag out of the world (${reason}) — returned`);
    return;
  }
  f.state = "dropped";
  f.x = dx;
  // Not mid-air: a carrier shot at the top of a jump would leave the flag hovering.
  f.y = dropGroundY(dy);
  f.z = dz;
  f.returnAt = Date.now() + CTF_AUTO_RETURN_MS;
  broadcastFlag(f, "dropped", p);
  console.log(`[server] ${p.name} dropped the ${f.team} flag (${reason})`);
}

// "I am standing on this flag." The server works out what that MEANS — take the enemy's,
// return your own, or capture — from who is asking and what they carry. Refusals are
// silent, exactly like takePickup: a player who is out of position or out of turn simply
// sees nothing happen.
//
// This is the WHOLE rule, in one function, because it has two callers: the `touchFlag`
// message from a client, and a bot deciding it is standing on a flag (server/bots.js).
// A bot has no socket and so bypasses the ws-level fire/hit token buckets, but it does
// NOT bypass anything here — same match-state gate, same per-player flag bucket, same
// 3D reach against the server's own copy of the position, same capture bookkeeping.
//
// `team` is untrusted: it arrives straight off the wire in the client's case.
// Returns "taken" | "returned" | "captured" | null (nothing happened).
function tryTouchFlag(me, team) {
  const now = Date.now();
  // A decided match still lets people shoot it out; it just stops scoring.
  if (match.state !== "playing") return null;
  if (!me || !me.spawned || me.hp <= 0) return null; // a corpse does not touch
  if (!takeToken(me.flagBucket, now, FLAG_MIN_INTERVAL, FLAG_BURST)) return null;

  // Exact string match, never a bare `flags[team]` lookup: team is attacker-controlled,
  // and "__proto__"/"constructor" would otherwise hand back a truthy object whose
  // undefined coordinates make the distance check NaN — which is not greater than the
  // reach, so it would pass.
  if (team !== "red" && team !== "blue") return null;
  const f = flags[team];
  if (f.state === "carried") return null;

  // Judged in 3D against the SERVER's copy of the position — a 2D check would let a
  // player standing on the tower above the plinth touch the flag through the floor.
  const fdx = me.x - f.x;
  const fdy = me.y - f.y;
  const fdz = me.z - f.z;
  const freach = FLAG_RADIUS + FLAG_CLAIM_SLACK;
  if (fdx * fdx + fdy * fdy + fdz * fdz > freach * freach) return null;

  if (f.team !== me.team) {
    // Enemy flag, home or dropped: carry it. One flag to a carrier.
    if (me.flag) return null;
    f.state = "carried";
    f.carrier = me.id;
    f.returnAt = 0;
    f.x = me.x;
    f.y = me.y;
    f.z = me.z;
    me.flag = f.team;
    broadcastFlag(f, "taken", me);
    console.log(`[server] ${me.name} took the ${f.team} flag`);
    return "taken";
  }

  // Own flag, lying where its carrier fell: send it home. Works while carrying the
  // enemy flag too — in UT99 you can return your own and cap on the same run.
  if (f.state === "dropped") {
    returnFlag(f, me);
    return "returned";
  }

  // Own flag, at home. That is a capture if and only if I am carrying the enemy's;
  // otherwise touching your own flag stand does nothing at all.
  if (!me.flag) return null;
  const carried = flags[me.flag];
  // me.flag and flags[].carrier are two halves of the same fact, and a bug (or a race
  // between a drop and a capture) that lets them disagree must not mint a point — a flag
  // that is home, dropped, or on someone else's back is not mine to score. Clear the
  // stale half and refuse.
  if (!carried || carried.carrier !== me.id || carried.state !== "carried") {
    me.flag = null;
    return null;
  }
  me.flag = null;
  sendFlagHome(carried);
  match.scores[me.team]++;
  broadcastFlag(carried, "captured", me);
  broadcast({ type: "ctf-score", scores: { ...match.scores }, by: me.id, team: me.team });
  console.log(
    `[server] ${me.name} captured the ${carried.team} flag (red ${match.scores.red} - blue ${match.scores.blue})`
  );
  if (match.scores[me.team] >= match.capLimit) endMatch(me.team);
  return "captured";
}

function endMatch(winner) {
  match.state = "ended";
  match.winner = winner;
  match.resetAt = Date.now() + CTF_MATCH_RESET_MS;
  broadcast({ type: "match-end", winner, scores: { ...match.scores }, resetInMs: CTF_MATCH_RESET_MS });
  console.log(`[server] match over — ${winner} team wins ${match.scores.red}-${match.scores.blue}`);
}

// A full restart: flags home, scores and frags to zero, and the session stashes wiped of
// kills too, so a player who reconnects mid-next-match does not resume a dead score.
function resetMatch() {
  match.scores = { red: 0, blue: 0 };
  match.state = "playing";
  match.winner = null;
  match.resetAt = 0;
  // Hand the spawn points out from the top again, and let the next tie start red, so the
  // new match begins from exactly the state a freshly started server would be in.
  spawnCursor.red = 0;
  spawnCursor.blue = 0;
  nextTieTeam = "red";
  for (const p of players.values()) {
    p.flag = null;
    p.kills = 0;
    // A kill a second before the reset has a respawn timer in flight. Left alone it fires
    // into the new match and yanks a player who is already standing at a fresh spawn —
    // and it would hand them a second spawn point off the cursor we just rewound.
    if (p.respawnTimer) {
      clearTimeout(p.respawnTimer);
      p.respawnTimer = null;
    }
    // Everyone starts the new match alive, unarmed and at their own base: a corpse that
    // was waiting on that cancelled timer must not stay dead forever, and carrying the
    // second Enforcer across a reset would be a free head start.
    p.hp = PLAYER_HP;
    p.dual = false;
    // Armour and the amplifier are match state, like the score: a new match starts
    // with everyone equal, not with whoever last stood on the deck still plated.
    p.armor = 0;
    p.udamageUntil = 0;
    p.animation = { idle: 1, walk: 0, run: 0 };
    p.speed = 0;
    p.shots.length = 0;
    p.pendingHit = null;
    teamSpawn(p);
    broadcast({ type: "respawn", player: publicPlayer(p) });
    broadcast({ type: "loadout", id: p.id, dual: false });
  }
  for (const stash of sessions.values()) stash.kills = 0;
  for (const f of [flags.red, flags.blue]) {
    sendFlagHome(f);
    broadcastFlag(f, "reset", null);
  }
  broadcast({ type: "match-reset", ctf: publicCtf(Date.now()) });
  broadcastHighscore();
  console.log("[server] match reset");
}
