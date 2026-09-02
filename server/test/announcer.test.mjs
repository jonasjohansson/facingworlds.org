// announcer.test.mjs — UT99's voice, and the rules for when it uses it.
//
// Two halves, because they can be wrong independently:
//
//   THE MAPPING is pure and lives in server/announcer-rules.js. It encodes numbers read
//   out of Botpack — a three-second multi-kill window, spree announcements at exactly 5,
//   10, 15, 20 and 25 — and getting one of them wrong is silent: the announcer simply
//   never speaks, or speaks at the wrong moment, and nothing errors.
//
//   THE WIRING runs against a real server, because "the mapping is right" and "the
//   announcer works" are different claims and only the second one is worth having.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const rules = require("../announcer-rules.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(HERE, "..", "server.js");
const REPO_ROOT = path.join(HERE, "..", "..");

// ------------------------------------------------------------------ the mapping

test("a multi-kill climbs the ladder and then stays on the top rung", () => {
  // UT99's MultiKillMessage: 1 DoubleKill, 2 MultiKill, 3 UltraKill, and every switch
  // from 4 to 9 falls through to MonsterKill.
  assert.equal(rules.multiKillSound(0), null, "the first kill of a chain announces nothing");
  assert.equal(rules.multiKillSound(1), "doublekill");
  assert.equal(rules.multiKillSound(2), "multikill");
  assert.equal(rules.multiKillSound(3), "ultrakill");
  for (const n of [4, 5, 9, 40]) {
    assert.equal(rules.multiKillSound(n), "monsterkill", `level ${n} should still be monsterkill`);
  }
});

test("a spree speaks at five numbers and at no others", () => {
  // NotifySpree returns without a word for anything that is not exactly one of these.
  const expected = {
    5: "killingspree",
    10: "rampage",
    15: "dominating",
    20: "unstoppable",
    25: "godlike",
  };
  for (let n = 0; n <= 30; n++) {
    assert.equal(rules.spreeSound(n), expected[n] ?? null, `spree of ${n}`);
  }
});

test("only names the generator knows become URLs", () => {
  // The key arrives over the wire, so the client resolves it against the list rather
  // than pasting it into a path.
  assert.equal(rules.announcementUrl("firstblood"), "assets/audio/ut/announcer/firstblood.mp3");
  assert.equal(rules.announcementUrl("../../etc/passwd"), null);
  assert.equal(rules.announcementUrl("megakill"), null, "megakill is in the package but unused");
  assert.equal(rules.announcementUrl(""), null);
});

test("every announcement the rules can produce is a file the build wrote", async () => {
  const fs = await import("node:fs");
  for (const key of rules.ANNOUNCEMENTS) {
    const url = rules.announcementUrl(key);
    assert.notEqual(url, null, `${key} has no URL`);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, url)), `${url} is missing from the repo`);
  }
});

// ------------------------------------------------------------------- the wiring

let child = null;
// 8781: 8751 is the CTF suite, 8761 the bots suite and 8791 the bot gate. `node --test`
// runs these files in PARALLEL, so sharing a base port makes one suite's clients connect
// to another suite's server — which is how this file first broke five bot tests without
// touching a line of bot code.
let PORT = 8781;
const clients = [];

function freePort(from) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(from, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on("error", () => resolve(freePort(from + 1)));
  });
}

before(async () => {
  PORT = await freePort(Number(process.env.ANNOUNCER_TEST_PORT) || 8781);
  const env = { ...process.env, PORT: String(PORT), BOTS_ENABLED: "0" };
  delete env.SSL_CERT;
  delete env.SSL_KEY;
  const log = [];
  await new Promise((resolve, reject) => {
    child = spawn(process.execPath, [SERVER_JS], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => reject(new Error(`server never started\n${log.join("")}`)), 10000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      log.push(d);
      if (/server on :/.test(d)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => log.push(d));
  });
});

after(() => {
  for (const c of clients) try { c.ws.close(); } catch {}
  if (child) child.kill("SIGKILL");
});

function connect(name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
    const c = { name, ws, id: null, seen: [] };
    clients.push(c);
    ws.on("open", () => ws.send(JSON.stringify({ type: "setName", name })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      c.seen.push(m);
      if (m.type === "hello") {
        c.id = m.yourId;
        c.pos = m.spawn;
        ws.send(JSON.stringify({ type: "spawn" }));
        resolve(c);
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a kill makes the announcer speak, and first blood is said once", async () => {
  const a = await connect("Shooter");
  const b = await connect("Target");
  await sleep(200);

  // Enough Enforcer hits to kill: 100 hp at 17 a shot.
  const kill = async () => {
    for (let i = 0; i < 7; i++) {
      a.ws.send(JSON.stringify({ type: "fire", origin: { ...a.pos }, dir: { x: 1, y: 0, z: 0 } }));
      await sleep(30);
      a.ws.send(JSON.stringify({ type: "clientHit", victimId: b.id }));
      await sleep(95);
    }
  };
  await kill();
  await sleep(400);

  const heard = a.seen.filter((m) => m.type === "announce").map((m) => m.sound);
  assert.ok(heard.includes("firstblood"), `no first blood; heard ${JSON.stringify(heard)}`);
  // Everyone hears first blood, including the player who died to it.
  assert.ok(
    b.seen.some((m) => m.type === "announce" && m.sound === "firstblood"),
    "the victim did not hear first blood",
  );

  // And only once a match, however many more kills there are.
  await sleep(2600); // outside the 3s multi-kill window, so nothing else is triggered
  await kill();
  await sleep(400);
  const firstBloods = a.seen.filter((m) => m.type === "announce" && m.sound === "firstblood");
  assert.equal(firstBloods.length, 1, "first blood was announced more than once in a match");
});
