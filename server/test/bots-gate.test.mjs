// bots-gate.test.mjs — bots exist FOR humans (BOTS_NEED_HUMAN, default on).
//
// Its own server, because the main bots suite runs with the gate off and tells
// one long story on one roster. Three claims, in order, on one process:
//   1. an empty server (spectators included) stays empty — no bot ever joins
//   2. the first human summons the roster
//   3. the last human leaving drains it
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");
const SERVER_JS = path.join(REPO_ROOT, "server", "server.js");
const ROSTER_MS = 300;
let PORT = 8791;
let child = null;
const log = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort(from) {
  for (let p = from; p < from + 20; p++) {
    const ok = await new Promise((res) => {
      const s = net.createServer().once("error", () => res(false)).once("listening", () => s.close(() => res(true)));
      s.listen(p); // no host: bind the same wildcard the server binds, or IPv6 squatters slip past
    });
    if (ok) return p;
  }
  throw new Error("no free port");
}

function startServer() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    env.PORT = String(PORT);
    env.BOTS_ENABLED = "1";
    env.BOTS_NEED_HUMAN = "1"; // the subject under test — and the production default
    env.BOTS_MIN_PER_TEAM = "1";
    env.BOTS_ROSTER_MS = String(ROSTER_MS);
    delete env.SSL_CERT;
    delete env.SSL_KEY;
    child = spawn(process.execPath, [SERVER_JS], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => reject(new Error(`server never ready\n${log.join("")}`)), 10000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      log.push(d);
      if (/server on :/.test(d)) { clearTimeout(timer); resolve(); }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => log.push(d));
  });
}

function connect(name, spectate = false) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/${spectate ? "?spectate=1" : ""}`);
    const c = { ws, msgs: [], name };
    const t = setTimeout(() => reject(new Error(`${name}: no hello`)), 8000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "setName", name })));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      c.msgs.push(m);
      if (m.type === "hello") {
        c.hello = m;
        if (!spectate) { ws.send(JSON.stringify({ type: "spawn" })); }
        clearTimeout(t);
        resolve(c);
      }
    });
    ws.on("error", reject);
  });
}

const joinsIn = (c, from = 0) => c.msgs.slice(from).filter((m) => m.type === "join").map((m) => m.player.name);
const leavesIn = (c, from = 0) => c.msgs.slice(from).filter((m) => m.type === "leave").length;

let spec;

test("setup", async () => {
  PORT = await freePort(PORT);
  await startServer();
  spec = await connect("GATE_SPEC", true);
});

test("an empty server stays empty: a spectator alone summons no bots", async () => {
  await sleep(ROSTER_MS * 8);
  assert.deepEqual(spec.hello.players, [], "server was not empty at connect");
  assert.deepEqual(joinsIn(spec), [], "a bot joined with no human present");
});

test("the first human summons the roster", async () => {
  const from = spec.msgs.length;
  const human = await connect("GATE_HUMAN");
  const deadline = Date.now() + ROSTER_MS * 30;
  while (Date.now() < deadline && joinsIn(spec, from).length < 2) await sleep(50);
  const names = joinsIn(spec, from);
  // the human's own join is in there too; at least one bot must be
  assert.ok(names.length >= 2, `expected the human plus at least one bot to join, saw ${JSON.stringify(names)}`);
  test.human = human;
});

test("the last human leaving drains the roster", async () => {
  const from = spec.msgs.length;
  test.human.ws.close();
  const deadline = Date.now() + ROSTER_MS * 30;
  // every non-spectator should be gone: the human's leave plus every bot's
  while (Date.now() < deadline && leavesIn(spec, from) < 2) await sleep(50);
  assert.ok(leavesIn(spec, from) >= 2, "bots did not drain after the last human left");
  await sleep(ROSTER_MS * 6);
  const lateSpec = await connect("GATE_SPEC2", true);
  assert.deepEqual(lateSpec.hello.players, [], `players remained: ${JSON.stringify(lateSpec.hello.players.map((p) => p.name))}`);
  lateSpec.ws.close();
});

test("teardown", async () => {
  spec.ws.close();
  if (child) child.kill();
});
