// Server-side bots — CTF-Face's own path network, walked by players that have no socket.
//
// THE ONE IDEA THIS FILE IS BUILT ON: a bot is not a second kind of entity. It is an
// ordinary entry in server.js's `players` map with `ws` simply absent, so publicPlayer(),
// join/leave/pose/hit/death/respawn, the scoreboard, the flag rules and the AR spectator
// table all work on it without a single line of client change. Everything below either
// moves that entry or calls a function server.js already uses for humans:
//
//   damage   -> ctx.canHit + ctx.applyHit, the SAME pair the clientHit handler calls.
//               A bot's shot is a probability roll followed by the identical damage,
//               kill award, flag drop, death broadcast and respawn timer a human's is.
//   flags    -> ctx.tryTouchFlag(bot, team), the function the `touchFlag` message was
//               factored into. Radius, match state, the carried/dropped/home state
//               machine, capture scoring and the touch rate limit are all in that one
//               place, so a bot can no more take a flag from across the map than a
//               client can.
//   spawning -> ctx.teamSpawn, which is also what applyHit's respawn timer calls. That
//               timer works unchanged for a socketless player: it only ever looks the
//               victim up in `players` and broadcasts.
//
// ANTI-CHEAT. Bots have no socket, so the ws-level token buckets (fire/hit) never see
// them — they call the damage internals directly, and there is no message to rate limit.
// They are NOT exempt from the plausibility rules the pose validator enforces, because
// those describe what a body may physically do:
//
//   speed  a bot's velocity is clamped to GROUND_SPEED (9.4 u/s), and the per-tick step
//          is asserted against MAX_POSE_SPEED below. 9.4 * 0.05 = 0.47 units per tick
//          against a budget of 100 * 0.05 = 5 — a 10x margin, and the broadcast gap
//          (BOT_POSE_MS) is smaller still than the validator's dt clamp.
//   roof   the pose validator refuses y above ROOF_AIRSPACE_Y (72.55) unless the point
//          is over a tower roof. The walkable nav component tops out at y = 15.14 (the
//          sniper decks are reached by teleporter, an R_SPECIAL edge aStar leaves out),
//          so a bot cannot get near that ceiling. Asserted anyway in step().
//   spawn  a spawn is a legitimate teleport for humans too. ctx.teamSpawn resets the
//          plausibility baseline; step() notices the jump, drops the stale path and
//          zeroes the velocity so the first tick after a respawn does not try to
//          "continue" a run from the other end of the map.
//
// THE GROUND. A bot steers at nav-graph waypoints and used to lerp its y straight
// between them, which put it up to a metre inside the rock on any slope that bulged.
// server/navmesh-surface.js is the walkable surface baked out of the shipped navmesh,
// and step() pulls y back onto it every tick. Measured over 5,145 broadcast bot poses
// after the change: 99.8% within 0.10 of the surface, worst 0.20.
//
// The bot is deliberately beatable: it fires the Enforcer at the human rate after a
// reaction delay, its hit chance falls off with range and with how fast the target is
// moving, and each bot carries its own skill multiplier. A human who keeps moving wins
// most duels. How hard they hit was TUNED AGAINST A MEASUREMENT rather than by feel —
// see BASE_ACCURACY for the numbers and for why the roster size made that necessary.

const { NODES, WALKABLE_MAIN, nearestNode, aStar } = require("./nav-graph.js");
// The walkable surface, baked out of the shipped navmesh by
// scripts/gen-navmesh-surface.mjs. It is what keeps a bot's feet on the rock (the GROUND
// block in step()) and what stands in for a line-of-sight test (canSee()).
const { surfaceNear, groundRisesAbove } = require("./navmesh-surface.js");
const { pickCharacter } = require("./characters.js");
const { DEFAULT_WEAPON } = require("./weapons.js");

// ---- knobs ----
// Read here rather than in server.js so the whole bot feature is one require away from
// not existing. BOTS_ENABLED=0 (or false/off) is a complete opt-out: no timer, no roster,
// no bots — which is what server/test/ctf.test.mjs runs with, so the CTF suite keeps
// testing the human rules against an empty server.
const envFlag = (name, dflt) => {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  return v !== "0" && v.toLowerCase() !== "false" && v.toLowerCase() !== "off";
};
const envInt = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
};
// The cadences below are the bots' own clocks, and every one of them is a duration in
// milliseconds that only ever wants to go DOWN in a test. Overridable so server/test/
// bots.test.mjs can watch a roster fill, a plan change and a pose stream in seconds
// instead of waiting out the cadences a real match is tuned for. Floored at 1 ms: a 0 ms
// setInterval is a busy loop, and a 0 ms throttle is not a throttle.
const envMs = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : dflt;
};
// A 0..1 knob. Unlike the cadences above, this one is meant to be turned in BOTH
// directions and on a live server: how hard the bots hit is the one thing about them
// that is pure taste, it is what every complaint about them is really about, and
// nobody should need a deploy to answer "make them easier".
const envUnit = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : dflt;
};

const BOTS_ENABLED = envFlag("BOTS_ENABLED", true);
// Five a side is a busy CTF-Face without being a UT99 full house. BOT_NAMES has 20
// entries, so even at BOTS_MAX nobody has to wear a numeric suffix. The cost is ten
// bots x 20 Hz of steering, one ground lookup each (~0.1 us) plus a line-of-sight
// probe per engagement — under a millisecond a second in total, which the free-tier
// dyno does not notice.
const BOTS_MIN_PER_TEAM = envInt("BOTS_MIN_PER_TEAM", 5);
const BOTS_MAX = envInt("BOTS_MAX", 10);
// Bots exist FOR humans: with nobody watching they would run matches for the
// void (and keep the free-tier dyno busy doing it). On by default — an empty
// server is empty until the first human arrives, and drains again when the
// last one leaves. BOTS_NEED_HUMAN=0 restores always-on bots.
const BOTS_NEED_HUMAN = envFlag("BOTS_NEED_HUMAN", true);

// ---- movement ----
// GROUND_SPEED mirrors GAME_CONFIG.MOVEMENT.GROUND_SPEED (9.4 m/s) — the speed a human
// runs at. A bot that moved faster would be both unfair and, at 100 u/s, indistinguishable
// from a cheating client to anyone reading the pose stream.
const GROUND_SPEED = 9.4;
const BOT_TICK_MS = envMs("BOTS_TICK_MS", 50); // 20 Hz internal update
// The client's interpolation buffer renders every remote entity 100 ms in the past
// (DEFAULT_DELAY_MS in src/shared/net/interpolation.js). A 100 ms send cadence would
// leave it with nothing to interpolate BETWEEN for most render frames and it would
// extrapolate instead, which reads as a stutter. Humans are throttled at 50 ms by
// POSE_UPDATE_INTERVAL in server.js (GAME_CONFIG.NETWORK.POSE_UPDATE_INTERVAL says 100,
// but the pose loop in network.js actually ticks at 50), so bots send at 50 too: the
// requirement is that a bot look exactly like a human on the wire.
const BOT_POSE_MS = envMs("BOTS_POSE_MS", 50);
const BRAIN_MS = envMs("BOTS_BRAIN_MS", 500); // 2 Hz re-plan; flag events re-plan immediately, see flagSignature
const ROSTER_MS = envMs("BOTS_ROSTER_MS", 3000); // roster check cadence, driven off server.js's 500 ms sweep

// How close counts as standing on a waypoint. Wide enough that a 0.47-unit step cannot
// orbit it forever, tight enough that corners are still cut at roughly the right place.
const ARRIVE_RADIUS = 2.0;
// Velocity smoothing. The bot never snaps its velocity: it eases towards the desired one,
// which is what keeps the pose stream continuous (and plausible) through a corner.
const STEER_LERP = 9.0;
const TURN_RATE = 7.0; // rad/s — how fast `ry` swings to the heading, so bots do not spin
// A bot that has covered less than this in STUCK_MS while it still has somewhere to be
// has walked into a corner of the graph the straight-line steering cannot leave.
const STUCK_DIST = 0.6;
const STUCK_MS = 1500;

// ---- ground ----
// Steering alone cannot keep a body on CTF-Face. Waypoints are points; the rock
// between two of them is a curve, so a straight lerp cuts through every slope that
// bulges and hangs over every one that dips. That is what put bots knee-deep in the
// surface. Every tick the y is pulled back onto the navmesh instead.
//
// GROUND_WINDOW is how far the snap will reach for a surface. It has to cover the
// worst a lerp can drift over one leg of a path — a couple of units on the steepest
// ramps here — while staying far inside the 17.7-unit gap between one tower storey
// and the next, so a bot on a tower's ground floor is never yanked up to the deck
// above. Nothing is found over the holes the fan navmesh has where the real level has
// lift platforms; there the bot keeps its interpolated y, exactly as before.
const GROUND_WINDOW = 4.0;
// How hard y is pulled towards the surface, per second. 25 settles ~92% of an error
// inside two 20 Hz ticks — near enough to a snap that nothing wades, smooth enough
// that a step or a ramp edge does not pop on the wire. A hard assignment would also
// hand the pose validator a vertical jump on every kerb.
const GROUND_LERP = 25.0;
// Feet-to-navmesh offset. src/game/core/spawn.js lifts the local rig by the same
// amount and server.js stores every spawn already lifted, so a bot standing still is
// at exactly the height a human standing on the same polygon is.
const GROUND_LIFT = 0.05;

// ---- line of sight ----
// There is no collision geometry on the server, so the navmesh doubles as a terrain
// silhouette: sample the shot, and if the walkable surface at a sample stands above
// the shot line, rock is in the way.
//
// WHAT THIS BUYS. The central ridge, the ramps and the drop off either side of the
// bridge — the whole reason a duel across CTF-Face is a duel and not a shooting
// gallery. Before this the only proxy was "more than 6 units apart vertically", so
// bots on opposite sides of the rock shot each other through it, which is most of why
// dying felt cheap.
//
// WHAT IT DOES NOT. It is a height field: it knows floors, not walls. Two players at
// the same height on opposite sides of a tower wall still see each other. Closing that
// needs the map mesh on the server, not the navmesh, and that is a much larger thing
// than this. Written down rather than quietly hoped over.
const LOS_SAMPLES = 12;
// How far a surface must stand above the shot line before it counts as blocking. It
// absorbs the navmesh's own coarseness (791 triangles over 257 units) so a bot does
// not lose a legitimate shot to a polygon edge a few centimetres proud of the floor
// it is standing on.
const LOS_CLEARANCE = 0.6;

// Animation thresholds, copied from src/game/components/character.js so a bot's blend
// matches what the same speed produces on a human rig: moveThreshold 0.2, runThreshold
// GROUND_SPEED * 0.53. Clients read `animation` straight off the wire, so getting these
// wrong is what makes a bot moonwalk.
const MOVE_THRESHOLD = 0.2;
const RUN_THRESHOLD = GROUND_SPEED * 0.53; // 4.98

// ---- combat ----
const SIGHT = 40; // units — engagement range, as specified
// Roughly in front: 55 degrees off the bot's own facing either way. Bots turn to face the
// target while engaging, so this is mostly about not shooting someone behind them during
// the turn.
const AIM_CONE = Math.cos((55 * Math.PI) / 180);
// A floor separation gate, kept alongside canSee(): two players 6 units apart
// vertically inside a tower are on different storeys. It is cheap and it runs first,
// so most pairs never reach the line-of-sight sampling at all.
const MAX_FIGHT_DY = 6;
// A bot does not open fire the instant a target appears. Longer than it was (300),
// and this is one of the two numbers the roster change had to be paid for with: at
// five a side you are simply seen more often, so the window you get to break contact
// before anyone shoots had to widen with it. Measured effect is under BASE_ACCURACY.
const REACTION_MS = envMs("BOTS_REACTION_MS", 550);
const FIRE_MS = 250; // 4 shots/s — GAME_CONFIG.WEAPON.FIRE_RATE
const DUAL_FIRE_MS = 125; // 8 shots/s, if a bot ever ends up dual-wielding
// Hit probability at point-blank range against a standing target, before the per-bot
// skill multiplier. Everything below scales it down.
//
// TUNED BY MEASUREMENT, not by feel, because the two things asked for here pull against
// each other: more bots per side is more incoming fire, and "make it less easy to die"
// is less. The test is a motionless player parked on the enemy flag — the worst case a
// human can be in, since hitChance's motion term is at its maximum — with 180 s of
// clock and the median time alive taken across the deaths:
//
//   before, 2/team, 20 dmg, acc 0.60, react 300      9.1 s   0.36 hits/s
//   5/team, 17 dmg, acc 0.42, react 420              5.4 s   0.57 hits/s   WORSE
//   5/team, 17 dmg, acc 0.26, react 550             13.0 s   0.31 hits/s
//
// The middle row is the point: five a side more than swallowed the damage cut on its
// own, and without measuring it this would have shipped as "less lethal" while being
// the opposite. A real player also moves, which halves the hit chance again.
//
// One 180 s sample per row (9-17 deaths each), so the ordering is solid and the second
// decimal is not. BOTS_ACCURACY overrides this at run time precisely because it is the
// kind of number that wants a live opinion, not a deploy.
const BASE_ACCURACY = envUnit("BOTS_ACCURACY", 0.26);
// Per-bot skill, rolled once at join and multiplied into hitChance. UT99 ships a
// difficulty per bot rather than one number for the roster, and a squad where every
// member shoots identically reads as one opponent copied five times.
const SKILL_MIN = 0.75;
const SKILL_MAX = 1.25;
const SPREAD_RAD = (6 * Math.PI) / 180; // visual tracer spread; the roll decides damage

// Where a shot leaves and where it is aimed, relative to the pose position (the feet).
// 1.4 is the camera height in GAME_CONFIG's own comment; 1.0 is chest height on the
// 1.83 m rig, which is what a bot aims at.
const EYE_HEIGHT = 1.4;
const AIM_HEIGHT = 1.0;

// UT99's own roster. Nothing here is an Epic asset — these are names, the same class of
// fact as the spawn coordinates already in the repo.
const BOT_NAMES = [
  "Loque",
  "Visse",
  "Tamerlane",
  "Malakai",
  "Peacemaker",
  "Nikita",
  "Cathode",
  "Riker",
  "Aryss",
  "Sarena",
  "Kyra",
  "Lauren",
  "Rankin",
  "Boris",
  "Divisor",
  "Gorge",
  "Anna",
  "Baird",
  "Sarge",
  "Kane",
];

/**
 * Is there rock between these two? The navmesh as a terrain silhouette.
 *
 * Walks the segment from the shooter's eye to the target's chest and asks, at each
 * sample, whether the walkable surface has RISEN ABOVE the shot line — meaning there
 * is mesh here and none of it is at or below the line any more.
 *
 * WHY THAT AND NOT A HEIGHT COMPARISON. A height field cannot tell terrain from a
 * ceiling by height alone, and on this map the two ranges overlap: the ridge stands
 * about 15.4 above a ground-level shot, while the shortest ceiling inside a tower is
 * only 6.1 above its own floor (both measured by scripts/gen-navmesh-surface.mjs and
 * printed in the generated file's header). So there is no threshold that separates
 * them. What separates them is the FLOOR: a shot crossing a room keeps that room's
 * floor beneath it the whole way no matter what hangs above, and a shot into a hillside
 * runs out of floor exactly where the hill begins.
 *
 * Two earlier versions of this were wrong in ways only measurement caught, so both are
 * recorded rather than quietly replaced:
 *   - asking for the surface NEAREST the ray, inside the ground snap's own window, was
 *     very nearly inert. The ridge sits ~15 over a shot between the two flag bases and
 *     the window is 4, so the single most obvious blocker on CTF-Face came back as "no
 *     data". The height profile along the flag-to-flag line is what showed it.
 *   - asking for the LOWEST surface fixed that but blocked shots across a tower alcove,
 *     where the fan navmesh has holes in the floor and the lowest thing under the
 *     sample is the deck 23 units up. That cost 14 nav-node pairs under 6 units apart,
 *     among them a defender standing at their own flag and the flag. Now handled by
 *     LOS_MAX_RISE inside groundRisesAbove — a blocker further up than any terrain on
 *     this map can rise is a roof, not rock, and counts as no evidence.
 *
 * HOW MUCH THIS ACTUALLY DOES, measured rather than hoped: of the 1,556 pairs of
 * walkable nav nodes that pass SIGHT and MAX_FIGHT_DY, 11 (0.7%) come back blocked. It
 * is not the reason the game got less lethal — HIT_DAMAGE, BASE_ACCURACY and
 * REACTION_MS are — and it should not be described as though it were. The engagement
 * envelope is why: at 40 units of sight and 6 of height difference you cannot span the
 * ridge, so within the range bots actually fight, CTF-Face is mostly open ground. What
 * this buys is that the cases which DO exist are now right, and that the envelope can
 * be widened later without bots shooting through the rock.
 *
 * WHAT IT DOES NOT. It is a height field: it knows floors, not walls, and it does not
 * see a floor BETWEEN two storeys either — a shot from a tower deck down at the floor
 * below reads as clear. MAX_FIGHT_DY is what keeps that pairing out, which is why that
 * gate stays even though this exists. Two players at the same height on opposite sides
 * of a tower wall also still see each other. Closing either needs the map mesh on the
 * server rather than the navmesh, which is a much larger thing than this.
 */
function canSee(from, fromY, to, toY) {
  const ox = from.x;
  const oz = from.z;
  const dx = to.x - ox;
  const dy = toY - fromY;
  const dz = to.z - oz;
  // Endpoints are skipped: both bodies are standing ON the surface, so a sample at
  // either end always finds the floor they are standing on and says nothing about what
  // is between them.
  for (let i = 1; i < LOS_SAMPLES; i++) {
    const t = i / LOS_SAMPLES;
    const rayY = fromY + dy * t;
    if (groundRisesAbove(ox + dx * t, oz + dz * t, rayY + LOS_CLEARANCE)) return false;
  }
  return true;
}

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
// three.js forward for a yaw of ry is (-sin ry, 0, -cos ry) — see the derivation on
// utYawToSceneDeg in src/shared/map-transform.js. This is its inverse: the yaw that
// looks along (dx, dz).
const headingOf = (dx, dz) => Math.atan2(-dx, -dz);
// Shortest signed angle from a to b, so a turn never takes the long way round.
const angleDelta = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/**
 * Wire the bots into a running server.
 *
 * @param {object} ctx everything the bots borrow from server.js. Passed in rather than
 *        required so this module holds no second copy of any rule: every field below is
 *        the server's own state or its own function.
 * @returns {{sweep: (now:number)=>void, stop: ()=>void, count: ()=>number}}
 */
function createBots(ctx) {
  const {
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
  } = ctx;

  // Bot ids, newest last. `players` is the only place a bot actually lives; this is just
  // the roster's ordering, which is how "remove the newest bot" is even a question.
  const roster = [];
  let nextRosterAt = 0;
  let timer = null;

  const liveBots = () => roster.map((id) => players.get(id)).filter(Boolean);
  const isBot = (p) => !!(p && p.bot);

  // ------------------------------------------------------------------ roster

  function takenNames() {
    const used = new Set();
    for (const p of players.values()) used.add(p.name);
    return used;
  }

  function pickName() {
    const used = takenNames();
    const free = BOT_NAMES.filter((n) => !used.has(n));
    if (free.length) return free[Math.floor(Math.random() * free.length)];
    // Every name is out (more bots than the roster has names, or a human took one).
    // Suffix rather than duplicate: the scoreboard is keyed by id, but two identical
    // names in a kill feed are unreadable.
    return `${BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)]}_${id4().slice(0, 2)}`;
  }

  // A bot record is field-for-field a human player record — every private field server.js
  // touches on a player is here, because applyHit, resetMatch and dropFlag all write to
  // them without asking whether there is a socket behind it. `ws` is the only thing
  // missing, and nothing in those paths reads it.
  function addBot(team) {
    const now = Date.now();
    const id = id4();
    const p = {
      id,
      name: pickName(),
      hp: PLAYER_HP,
      x: 0,
      y: 0,
      z: 0,
      ry: 0,
      kills: 0,
      speed: 0,
      animation: { idle: 1, walk: 0, run: 0 },
      dual: false,
      team,
      // A UT99 body, picked against everyone already on the map — humans included, via
      // the shared players map — so a full match is a room of different characters
      // ten identical soldiers. Fixed for the bot's life, like its name and team.
      character: pickCharacter([...players.values()].map((o) => o.character)),
      weapon: DEFAULT_WEAPON, // bots spawn with the Enforcer and take what they walk over
      armor: 0,
      udamageUntil: 0,
      flag: null,
      // --- private ---
      bot: true,
      session: null,
      sessionResumable: false,
      lastX: 0,
      lastY: 0,
      lastZ: 0,
      poseRejects: 0,
      // A bot has already taken the spawn the server picked for it — there is no client
      // to wait for. tryTouchFlag and the pose path both gate on this.
      spawned: true,
      shots: [],
      pendingHit: null,
      fireBucket: { tokens: FIRE_BURST, ts: now },
      hitBucket: { tokens: HIT_BURST, ts: now },
      flagBucket: { tokens: FLAG_BURST, ts: now },
      spawnTeam: null,
      respawnTimer: null,
      bx: null,
      by: null,
      bz: null,
      bry: null,
      banim: "",
      // --- bot only ---
      brain: {
        state: "attack",
        goal: null, // {x,y,z} the objective itself, not a nav node
        goalKind: "",
        waypoints: [], // nav node positions plus the goal as the last entry
        wpIdx: 0,
        planAt: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        px: 0, // where we believe we are, so a server-side teleport is detectable
        py: 0,
        pz: 0,
        movedAt: now,
        movedFrom: { x: 0, y: 0, z: 0 },
        targetId: null,
        targetSince: 0,
        fireAt: 0,
        touchAt: 0,
        loiterAt: 0,
        bornAt: now,
        flagSig: "",
        // Rolled once, for the life of this bot. Multiplies hitChance, so the roster
        // is a spread of opponents rather than one opponent five times over. It
        // survives death and respawn deliberately: a name you learn to respect should
        // still be the dangerous one after it kills you.
        skill: SKILL_MIN + Math.random() * (SKILL_MAX - SKILL_MIN),
      },
    };
    teamSpawn(p);
    p.brain.px = p.x;
    p.brain.py = p.y;
    p.brain.pz = p.z;
    p.brain.movedFrom = { x: p.x, y: p.y, z: p.z };
    players.set(id, p);
    roster.push(id);
    // Exactly the human join, minus the "except my own socket" (there isn't one).
    broadcast({ type: "join", player: publicPlayer(p) });
    broadcastHighscore();
    console.log(`[bots] ${p.name} joined the ${team} team (${roster.length} bots)`);
    return p;
  }

  // The ws close handler's cleanup, for a player that never had a ws. dropFlag FIRST:
  // a bot must never take the flag out of the match with it, which is also why the
  // roster prefers a bot that is not carrying anything (see removableOn).
  function removeBot(b, reason) {
    if (!b) return;
    dropFlag(b, "left the game");
    if (b.respawnTimer) {
      clearTimeout(b.respawnTimer);
      b.respawnTimer = null;
    }
    players.delete(b.id);
    lastPoseUpdate.delete(b.id);
    const i = roster.indexOf(b.id);
    if (i >= 0) roster.splice(i, 1);
    broadcast({ type: "leave", id: b.id });
    broadcastHighscore();
    console.log(`[bots] ${b.name} left the ${b.team} team (${reason})`);
  }

  function removeAll(reason) {
    for (const b of liveBots()) removeBot(b, reason);
    roster.length = 0;
  }

  function census() {
    const out = {
      red: { humans: 0, bots: [] },
      blue: { humans: 0, bots: [] },
    };
    for (const p of players.values()) {
      if (p.team !== "red" && p.team !== "blue") continue;
      if (isBot(p)) out[p.team].bots.push(p);
      else out[p.team].humans++;
    }
    // Newest last, so a "remove the newest" is a pop.
    for (const t of ["red", "blue"]) out[t].bots.sort((a, b) => roster.indexOf(a.id) - roster.indexOf(b.id));
    return out;
  }

  // The newest bot on this side that is not holding a flag. A carrier is never chosen —
  // yanking it would end a run nobody got to stop. If every candidate is carrying, this
  // returns null and the sweep simply tries again in a few seconds, by which time the
  // flag has been captured, dropped or returned.
  function removableOn(bots) {
    for (let i = bots.length - 1; i >= 0; i--) if (!bots[i].flag) return bots[i];
    return null;
  }

  /**
   * Roster maintenance. Called from server.js's 500 ms world sweep and throttled to
   * ROSTER_MS here, so there is no third timer in the process.
   */
  function sweep(now) {
    if (!BOTS_ENABLED) {
      if (roster.length) removeAll("bots disabled");
      return;
    }
    if (now < nextRosterAt) return;
    nextRosterAt = now + ROSTER_MS;

    const c = census();

    // The human gate. Census only counts teamed players, so spectators (the AR
    // view) do not summon bots — a match nobody can join is still a match for
    // the void.
    if (BOTS_NEED_HUMAN && c.red.humans + c.blue.humans === 0) {
      if (roster.length) removeAll("last human left");
      return;
    }

    // 1. Humans push bots out. Every human on a side is one bot that side does not need,
    //    so this drains down to BOTS_MIN_PER_TEAM total per team — newest bot first.
    for (const team of ["red", "blue"]) {
      const side = c[team];
      while (side.bots.length && side.humans + side.bots.length > BOTS_MIN_PER_TEAM) {
        const victim = removableOn(side.bots);
        if (!victim) break; // all carrying — never mid-run, try again next sweep
        removeBot(victim, "made room for a human");
        side.bots = side.bots.filter((b) => b !== victim);
      }
    }

    // 2. Global ceiling, in case BOTS_MAX was lowered under a running roster.
    let total = c.red.bots.length + c.blue.bots.length;
    while (total > BOTS_MAX) {
      const bigger = c.red.bots.length >= c.blue.bots.length ? c.red : c.blue;
      const victim = removableOn(bigger.bots);
      if (!victim) break;
      removeBot(victim, "over BOTS_MAX");
      bigger.bots = bigger.bots.filter((b) => b !== victim);
      total--;
    }

    // 3. Fill. One bot per side per sweep: a side that needs two gets them three seconds
    //    apart, which reads as players trickling in rather than a squad materialising.
    for (const team of ["red", "blue"]) {
      const side = c[team];
      if (side.humans + side.bots.length >= BOTS_MIN_PER_TEAM) continue;
      if (total >= BOTS_MAX) break;
      addBot(team);
      total++;
    }
  }

  // ------------------------------------------------------------------ brain

  // A cheap fingerprint of everything a bot's plan depends on. When it changes — a flag
  // taken, dropped, returned, captured — every bot re-plans on the next tick instead of
  // waiting out its 2 Hz timer, which is what makes them react to a run in progress.
  function flagSignature() {
    const f = flags;
    return `${f.red.state}:${f.red.carrier}:${f.blue.state}:${f.blue.carrier}:${match.state}`;
  }

  const flagPoint = (f) => ({ x: f.x, y: f.y, z: f.z });

  // A wander point near a position, for the defender. Real nav nodes only, so the
  // defender paces the room it is defending rather than walking into a wall.
  function loiterNear(p, radius) {
    const near = NODES.filter((n) => WALKABLE_MAIN.has(n.id) && dist3(n, p) <= radius);
    if (!near.length) return { x: p.x, y: p.y, z: p.z };
    const n = near[Math.floor(Math.random() * near.length)];
    return { x: n.x, y: n.y, z: n.z };
  }

  /**
   * Assign a role and a goal to every live bot on one team. Done per team rather than per
   * bot because the interesting roles are exclusive: exactly one interceptor, exactly one
   * returner, at most one defender.
   *
   * UT99 CTF, in the order the game actually cares:
   *   CARRY      I have the enemy flag. Run it home and touch our own stand.
   *   RETURN     our flag is lying on the floor somewhere. Nearest bot goes and touches it.
   *   INTERCEPT  an enemy is carrying our flag. Nearest bot chases them down.
   *   DEFEND     our flag is home. One bot paces near it.
   *   ATTACK     everyone else goes for the enemy flag, wherever it currently is.
   */
  function planTeam(team, now, side) {
    const bots = side.filter((b) => b.hp > 0);
    if (!bots.length) return;
    const own = flags[team];
    const enemy = flags[otherTeam(team)];
    const pending = [];

    for (const b of bots) {
      if (b.flag) setGoal(b, "carry", flagPoint(own.home), now);
      else pending.push(b);
    }

    const nearestTo = (point) => {
      let best = null;
      let bestD = Infinity;
      for (const b of pending) {
        const d = dist3(b, point);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      return best;
    };

    const claim = (b) => {
      const i = pending.indexOf(b);
      if (i >= 0) pending.splice(i, 1);
    };

    if (own.state === "dropped") {
      const b = nearestTo(own);
      if (b) {
        setGoal(b, "return", flagPoint(own), now);
        claim(b);
      }
    } else if (own.state === "carried") {
      const thief = players.get(own.carrier);
      const b = thief ? nearestTo(thief) : null;
      if (b) {
        setGoal(b, "intercept", { x: thief.x, y: thief.y, z: thief.z }, now);
        claim(b);
      }
    } else if (pending.length > 1) {
      // Own flag is home. Hold one back — but never the last one, or a lone bot would
      // spend the whole match standing next to a flag nobody is coming for.
      const b = pending[pending.length - 1];
      const brain = b.brain;
      const stale = brain.state !== "defend" || now >= brain.loiterAt || !brain.goal;
      if (stale) {
        brain.loiterAt = now + 4000 + Math.random() * 3000;
        setGoal(b, "defend", loiterNear(own.home, 25), now);
      }
      claim(b);
    }

    // ATTACK. The enemy flag "wherever it currently is" has a third case: only OUR side
    // can be carrying the ENEMY flag, so a carried enemy flag is on a team-mate's back —
    // and flags[].x/y/z was frozen at the moment of the take. Escort them home instead of
    // jogging to an empty stand.
    let target = flagPoint(enemy);
    if (enemy.state === "carried") {
      const mate = players.get(enemy.carrier);
      target = mate ? { x: mate.x, y: mate.y, z: mate.z } : flagPoint(own.home);
    }
    for (const b of pending) setGoal(b, "attack", target, now);
  }

  // Set the objective and re-path if it actually moved. Re-pathing every tick would be
  // 20 A* searches a second per bot for a goal that has not changed by a unit.
  function setGoal(b, state, goal, now) {
    const brain = b.brain;
    const moved = !brain.goal || dist3(brain.goal, goal) > 3;
    const changed = brain.state !== state;
    brain.state = state;
    brain.goal = goal;
    if (moved || changed || !brain.waypoints.length) repath(b, now);
  }

  /**
   * A route through Epic's own graph, from the node nearest the bot to the node nearest
   * the objective, with the objective itself appended as the last waypoint — nav nodes
   * sit a metre or two off things like flag stands, and the last metre is what decides
   * whether a touch lands.
   */
  function repath(b, now) {
    const brain = b.brain;
    brain.waypoints = [];
    brain.wpIdx = 0;
    brain.movedAt = now;
    brain.movedFrom = { x: b.x, y: b.y, z: b.z };
    if (!brain.goal) return;

    const from = nearestNode(b.x, b.y, b.z, { maxDist: 60 });
    const to = nearestNode(brain.goal.x, brain.goal.y, brain.goal.z, { maxDist: 60 });
    if (from && to) {
      const ids = aStar(from.id, to.id);
      if (ids) {
        for (const id of ids) {
          const n = NODES[id];
          // Node y IS the height a player stands at, to within the transform's own
          // accuracy: across all 20 PlayerStarts the nav node sits a mean 0.05 units
          // (worst 0.39) above the spawn point server.js hands a human. No offset to
          // apply, and nothing here snaps to a floor.
          brain.waypoints.push({ x: n.x, y: n.y, z: n.z });
        }
      }
    }
    brain.waypoints.push({ x: brain.goal.x, y: brain.goal.y, z: brain.goal.z });
    // Already standing on the first node? Then it is behind us, not ahead.
    while (brain.wpIdx < brain.waypoints.length - 1 && dist3(b, brain.waypoints[brain.wpIdx]) < ARRIVE_RADIUS) {
      brain.wpIdx++;
    }
  }

  // ------------------------------------------------------------------ combat

  function enemyInSight(b) {
    let best = null;
    let bestD = SIGHT;
    for (const p of players.values()) {
      if (p.id === b.id || p.hp <= 0) continue;
      // Never target a player that has not spawned: a client on the loading
      // screen is motionless (maximum hitChance) and cannot even see the shot.
      if (!p.spawned) continue;
      if (!p.team || p.team === b.team) continue;
      if (Math.abs(p.y - b.y) > MAX_FIGHT_DY) continue; // cheap storey gate, runs first
      const d = dist3(b, p);
      if (d >= bestD) continue;
      // Roughly in front, in the plane. The bot turns towards whoever it is engaging,
      // so this only excludes someone it has not come round to yet.
      const dx = p.x - b.x;
      const dz = p.z - b.z;
      const len = Math.hypot(dx, dz) || 1;
      const fx = -Math.sin(b.ry);
      const fz = -Math.cos(b.ry);
      if ((dx / len) * fx + (dz / len) * fz < AIM_CONE) continue;
      // Last, because it is the only expensive one: LOS_SAMPLES surface lookups. Every
      // gate above has already thrown out the pairs that cannot be a fight anyway.
      if (!canSee(b, b.y + EYE_HEIGHT, p, p.y + AIM_HEIGHT)) continue;
      bestD = d;
      best = p;
    }
    return best;
  }

  // Falls off with range and with how fast the target is moving. Both are the levers that
  // make a bot beatable: stand still at point-blank and it will kill you, keep moving and
  // circle out to range and it mostly will not.
  function hitChance(distance, targetSpeed, skill) {
    const byRange = 1 - 0.75 * clamp01((distance - 8) / (SIGHT - 8)); // 1.0 -> 0.25
    const byMotion = 1 - 0.55 * clamp01(targetSpeed / GROUND_SPEED); // 1.0 -> 0.45
    return clamp01(BASE_ACCURACY * skill * byRange * byMotion);
  }

  function fight(b, now) {
    const brain = b.brain;
    const target = enemyInSight(b);
    if (!target) {
      brain.targetId = null;
      return null;
    }
    if (brain.targetId !== target.id) {
      brain.targetId = target.id;
      brain.targetSince = now;
    }
    if (now - brain.targetSince < REACTION_MS) return target;
    if (now < brain.fireAt) return target;
    brain.fireAt = now + (b.dual ? DUAL_FIRE_MS : FIRE_MS);

    const ox = b.x;
    const oy = b.y + EYE_HEIGHT;
    const oz = b.z;
    let dx = target.x - ox;
    let dy = target.y + AIM_HEIGHT - oy;
    let dz = target.z - oz;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;
    // Generous spread on the TRACER. It is cosmetic: the roll below is what damages, and
    // a miss that flew straight at the target would look like the server cheating.
    dx += (Math.random() * 2 - 1) * SPREAD_RAD;
    dy += (Math.random() * 2 - 1) * SPREAD_RAD;
    dz += (Math.random() * 2 - 1) * SPREAD_RAD;
    const n = Math.hypot(dx, dy, dz) || 1;

    // Broadcast to everyone: a bot has no socket to exclude, and clients render a fire
    // from someone else's id as a purely visual tracer (reportHits false in network.js),
    // so this can never double-damage.
    broadcast({
      type: "fire",
      id: b.id,
      origin: { x: q2(ox), y: q2(oy), z: q2(oz) },
      dir: { x: q3(dx / n), y: q3(dy / n), z: q3(dz / n) },
      t: now,
    });

    // The damage path, unchanged: canHit is the same precondition set the clientHit
    // handler uses (alive, not myself, inside MAX_HIT_RANGE) and applyHit is the same
    // HIT_DAMAGE, kill award, flag drop, death broadcast and respawn timer a human's
    // shot goes through.
    if (!canHit(b, target.id)) return target;
    if (Math.random() < hitChance(len, target.speed || 0, brain.skill)) applyHit(b, target);
    return target;
  }

  // ------------------------------------------------------------------ movement

  function step(b, dt, now) {
    const brain = b.brain;

    // A pose we did not write: applyHit's respawn timer and resetMatch both call
    // teamSpawn on us. Drop the stale plan and the velocity with it, or the first tick
    // would try to carry a run at the far end of the map into a fresh spawn.
    if (Math.hypot(b.x - brain.px, b.y - brain.py, b.z - brain.pz) > 2) {
      brain.waypoints = [];
      brain.wpIdx = 0;
      brain.goal = null;
      brain.vx = brain.vy = brain.vz = 0;
      brain.planAt = 0;
      brain.targetId = null;
      brain.movedAt = now;
      brain.movedFrom = { x: b.x, y: b.y, z: b.z };
    }

    if (b.hp <= 0) {
      // A corpse waits for applyHit's timer. No movement, no fire, no plan.
      brain.vx = brain.vy = brain.vz = 0;
      b.speed = 0;
      b.animation = { idle: 1, walk: 0, run: 0 };
      brain.px = b.x;
      brain.py = b.y;
      brain.pz = b.z;
      return;
    }

    const engaging = fight(b, now);

    // Arrival. Consume every waypoint we are already standing on, so a tight corner does
    // not cost a whole tick per node.
    while (brain.wpIdx < brain.waypoints.length && dist3(b, brain.waypoints[brain.wpIdx]) < ARRIVE_RADIUS) {
      brain.wpIdx++;
    }
    const wp = brain.waypoints[brain.wpIdx] || null;

    // At the objective: act on it. tryTouchFlag owns every rule about whether this is a
    // take, a return, a capture or nothing at all — the bot only has to be standing close
    // enough, exactly like a client that sends touchFlag. The trigger is the server's own
    // FLAG_RADIUS and not the looser FLAG_RADIUS + FLAG_CLAIM_SLACK a client gets: the
    // slack exists to forgive a client position the server has not caught up with, and a
    // bot's position IS the server's.
    const kind = brain.state;
    const objective = kind === "attack" || kind === "carry" || kind === "return";
    // Which flag a touch from here would be about. A flag that is on someone's back is
    // never touchable (tryTouchFlag refuses it), and asking anyway would spend a bucket
    // token every 200 ms — so skip it: an attacker escorting a team-mate who is carrying
    // the enemy flag stands next to them, not on a stand.
    const wantFlag = objective && brain.goal ? flags[kind === "attack" ? otherTeam(b.team) : b.team] : null;
    if (wantFlag && wantFlag.state !== "carried" && dist3(b, brain.goal) <= FLAG_RADIUS && now >= brain.touchAt) {
      // Rate-limited on our side too: tryTouchFlag spends a flagBucket token per call,
      // and a 20 Hz bot standing on a flag would drain the bucket and then miss the
      // touch it actually wanted.
      brain.touchAt = now + 200;
      tryTouchFlag(b, kind === "attack" ? otherTeam(b.team) : b.team);
    }
    // Out of waypoints and nothing to touch: the loiter spot is reached, or the player we
    // were chasing has moved. Either way, ask for a new plan on the next tick.
    // Ask for a new plan on the normal brain cadence, not next tick: planAt = 0
    // here made ONE parked defender force a whole-team re-plan at 20 Hz for its
    // entire loiter window.
    if (!wp && !objective) brain.planAt = Math.min(brain.planAt || Infinity, now + BRAIN_MS);

    // Desired velocity: straight at the waypoint at running pace, in 3D — the graph's
    // edges are Epic's own walkable connections, so the line between two adjacent nodes
    // is a line a body can walk, stairs and drops included. Never faster than the
    // remaining distance over dt, so we cannot overshoot a waypoint we are on top of.
    let dvx = 0;
    let dvy = 0;
    let dvz = 0;
    if (wp) {
      const dx = wp.x - b.x;
      const dy = wp.y - b.y;
      const dz = wp.z - b.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > 1e-4) {
        const speed = Math.min(GROUND_SPEED, d / dt);
        dvx = (dx / d) * speed;
        dvy = (dy / d) * speed;
        dvz = (dz / d) * speed;
      }
    }

    // Ease, never snap. This is what keeps the broadcast pose stream velocity-continuous.
    const k = 1 - Math.exp(-STEER_LERP * dt);
    brain.vx += (dvx - brain.vx) * k;
    brain.vy += (dvy - brain.vy) * k;
    brain.vz += (dvz - brain.vz) * k;

    let sx = brain.vx * dt;
    let sy = brain.vy * dt;
    let sz = brain.vz * dt;

    // PLAUSIBILITY ASSERT. GROUND_SPEED (9.4) is a tenth of MAX_POSE_SPEED (100), so this
    // never fires — it is here so that a future change to the steering cannot quietly
    // start producing motion the server would reject from a human.
    const stepLen = Math.hypot(sx, sy, sz);
    const budget = MAX_POSE_SPEED * dt;
    if (stepLen > budget) {
      const s = budget / stepLen;
      sx *= s;
      sy *= s;
      sz *= s;
    }

    b.x = clampWorld(b.x + sx);
    b.y = b.y + sy;
    b.z = clampWorld(b.z + sz);

    // GROUND. The waypoints are snapped to the navmesh now, but the straight line
    // between two of them is not the rock between them — CTF-Face is all slopes, so a
    // lerp cuts into every rise and hangs over every dip. This is the correction, and
    // it is why bots stop wading through the surface.
    //
    // Eased rather than assigned: a hard write would pop on the wire at every step and
    // hand the pose validator a vertical jump. At GROUND_LERP the error is gone inside
    // two ticks, which is faster than anyone can see and slower than a teleport.
    //
    // Nothing happens where the navmesh has nothing to say — the fan model's holes,
    // and the lift shafts it never modelled. There the interpolated y stands, exactly
    // as it did before this existed.
    const ground = surfaceNear(b.x, b.z, b.y, GROUND_WINDOW);
    if (ground !== null) {
      const want = ground + GROUND_LIFT;
      b.y += (want - b.y) * (1 - Math.exp(-GROUND_LERP * dt));
      // The vertical steering term has done its job the moment the ground owns y.
      // Leaving it running would fight the snap and re-accumulate the same drift.
      brain.vy = 0;
    }

    // ROOF RULE. The pose validator refuses y above ROOF_AIRSPACE_Y away from a tower
    // roof, and the walkable graph tops out at 15.14 — two towers' worth below it — so
    // this is unreachable by construction. Clamped rather than asserted because the one
    // thing worse than a bot in illegal airspace is a bot the humans cannot shoot.
    if (b.y > ROOF_AIRSPACE_Y) b.y = ROOF_AIRSPACE_Y;

    // The plausibility baseline server.js keeps for humans. Kept in step so nothing that
    // reads it (or a future move of a bot onto a socket) sees a stale origin.
    b.lastX = b.x;
    b.lastY = b.y;
    b.lastZ = b.z;
    brain.px = b.x;
    brain.py = b.y;
    brain.pz = b.z;

    // Horizontal speed drives the animation blend, exactly as it does on a human rig
    // (character.js measures a horizontal delta and ignores the vertical one).
    const hspeed = Math.hypot(brain.vx, brain.vz);
    b.speed = hspeed;
    b.animation =
      hspeed > RUN_THRESHOLD
        ? { idle: 0, walk: 0, run: 1 }
        : hspeed > MOVE_THRESHOLD
          ? { idle: 0, walk: 1, run: 0 }
          : { idle: 1, walk: 0, run: 0 };

    // Face the fight if there is one, otherwise face where we are going. Turned at a
    // rate rather than assigned, so a bot rounding a corner does not spin on the spot.
    let want = b.ry;
    if (engaging) want = headingOf(engaging.x - b.x, engaging.z - b.z);
    else if (hspeed > MOVE_THRESHOLD) want = headingOf(brain.vx, brain.vz);
    const turn = angleDelta(b.ry, want);
    const maxTurn = TURN_RATE * dt;
    b.ry += Math.max(-maxTurn, Math.min(maxTurn, turn));
    if (b.ry > Math.PI) b.ry -= Math.PI * 2;
    if (b.ry < -Math.PI) b.ry += Math.PI * 2;

    // Stuck: no waypoint progress for STUCK_MS. Cheap insurance against a goal that sits
    // just off the graph, or a path whose last leg the straight-line steering cannot walk.
    if (dist3(b, brain.movedFrom) > STUCK_DIST) {
      brain.movedAt = now;
      brain.movedFrom = { x: b.x, y: b.y, z: b.z };
    } else if (wp && now - brain.movedAt > STUCK_MS) {
      brain.planAt = 0;
      repath(b, now);
    }
  }

  // ------------------------------------------------------------------ pose

  // Byte-for-byte the human pose broadcast in server.js, including the "did anything
  // actually change" suppression against the last sent values — so a standing bot costs
  // nothing on the wire and a moving one looks like any other player.
  function sendPose(b, now) {
    const qx = q2(b.x);
    const qy = q2(b.y);
    const qz = q2(b.z);
    const qry = q3(b.ry);
    const anim = b.animation || { idle: 1, walk: 0, run: 0 };
    const animKey = `${q2(anim.idle)},${q2(anim.walk)},${q2(anim.run)}`;
    if (qx === b.bx && qy === b.by && qz === b.bz && qry === b.bry && animKey === b.banim) return;
    const animChanged = animKey !== b.banim;
    b.bx = qx;
    b.by = qy;
    b.bz = qz;
    b.bry = qry;
    b.banim = animKey;
    const out = { type: "pose", id: b.id, t: now, x: qx, y: qy, z: qz, ry: qry, speed: q2(b.speed || 0) };
    if (animChanged) out.animation = anim;
    broadcast(out);
    lastPoseUpdate.set(b.id, now);
  }

  // ------------------------------------------------------------------ tick

  let lastTick = Date.now();
  let lastPoseAt = 0;

  function tick() {
    const now = Date.now();
    // Real elapsed time, clamped: a stalled event loop must not hand every bot a
    // half-second step, which is the one way this code could produce a teleport.
    const dt = Math.min(0.25, Math.max(0.001, (now - lastTick) / 1000));
    lastTick = now;
    if (!roster.length) return;
    const bots = liveBots();
    if (!bots.length) return;

    // Re-plan at 2 Hz, or immediately when a flag changed hands — that is the event the
    // whole state machine hangs off. Per team, because the roles are exclusive.
    const sig = flagSignature();
    for (const team of ["red", "blue"]) {
      const side = bots.filter((b) => b.team === team);
      if (!side.length) continue;
      const due = side.some((b) => now >= b.brain.planAt || b.brain.flagSig !== sig);
      if (!due) continue;
      for (const b of side) {
        b.brain.planAt = now + BRAIN_MS;
        b.brain.flagSig = sig;
      }
      planTeam(team, now, side);
    }

    for (const b of bots) step(b, dt, now);

    if (now - lastPoseAt >= BOT_POSE_MS) {
      lastPoseAt = now;
      for (const b of bots) sendPose(b, now);
    }
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    removeAll("server shutting down");
  }

  if (BOTS_ENABLED) {
    timer = setInterval(tick, BOT_TICK_MS);
    // unref so the bots' own timer can never be the reason the process refuses to exit —
    // the same courtesy server.js extends to its world sweep.
    timer.unref && timer.unref();
    console.log(`[bots] enabled — min ${BOTS_MIN_PER_TEAM}/team, max ${BOTS_MAX}`);
  } else {
    console.log("[bots] disabled (BOTS_ENABLED)");
  }

  return { sweep, stop, count: () => roster.length, enabled: BOTS_ENABLED };
}

// canSee is exported for server/test/bots-los.test.mjs, which pins it against known
// CTF-Face geometry. It is a pure function of the baked navmesh — no ctx, no roster —
// which is why it sits at module scope rather than inside createBots.
module.exports = { createBots, BOT_NAMES, canSee };
