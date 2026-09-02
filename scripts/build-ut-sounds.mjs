#!/usr/bin/env node
// build-ut-sounds.mjs — UT99's own weapon sounds, out of the packages and into the game.
//
//   node scripts/build-ut-sounds.mjs [path-to-UT-System]
//
// DEV TOOLING: needs a retail install and ffmpeg, so it is not part of any build. It
// writes assets/audio/ut/*.mp3 and scripts/data/ut-sounds.json, both committed, and
// gen-weapons.mjs reads the JSON — the same arrangement as the meshes and the numbers.
//
// Until now the game had ONE weapon sound, assets/audio/fire.wav, played by all of them.
//
// ---------------------------------------------------------------------------
// WHICH SOUND IS WHICH, AND WHY IT IS NOT A LIST OF NAMES I TYPED
// ---------------------------------------------------------------------------
// Four of the six weapons name their FireSound in their class defaults and are simply
// read. The other two do not have one at all, because they play their PROJECTILE's spawn
// sound instead, from code:
//
//     UT_Eightball  PlayOwnedSound(class'RocketMk2'.Default.SpawnSound, ...)
//     ripper        PlayOwnedSound(class'Razor2'.Default.SpawnSound, ...)
//
// so those two are followed to the projectile rather than guessed. Explosions use their
// class's EffectSound1, and the pickup blip is the PickupSound every weapon shares.
//
// A USound holds a format name and a lazy array of bytes which, for format WAV, is a
// complete RIFF file. scripts/lib/upkg.mjs finds it by its own header rather than by
// modelling a serialization that shifted across engine versions — a RIFF declares its
// length, and a wrong offset cannot produce one that lands back inside the export.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPackage, classDefaults, soundWav } from "./lib/upkg.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OUT_DIR = path.join(ROOT, "assets", "audio", "ut");
const OUT_JSON = path.join(ROOT, "scripts", "data", "ut-sounds.json");
const SYSTEM =
  process.argv[2] || path.join(os.homedir(), "Downloads", "Unreal Tournament", "System");

// Sounds are spread across three packages; which one holds a given name is not something
// the weapon class records, so all three are searched.
const PACKAGES = ["BotPack.u", "UnrealShare.u", "UnrealI.u"];
const loaded = PACKAGES.map((f) => ({ name: f, pkg: loadPackage(fs.readFileSync(path.join(SYSTEM, f))) }));
const botpack = loaded[0].pkg;

function findWav(soundName) {
  for (const { name, pkg } of loaded) {
    const wav = soundWav(pkg, soundName);
    if (wav) return { wav, from: name };
  }
  throw new Error(`${soundName}: not a Sound in ${PACKAGES.join(", ")}`);
}

const defaults = (cls) => classDefaults(botpack, botpack.findClass(cls));

// weapon id -> the class that names its fire sound, and where to look on that class.
const FIRE = [
  { id: "enforcer", cls: "enforcer", key: "FireSound" },
  { id: "sniper", cls: "SniperRifle", key: "FireSound" },
  { id: "shock", cls: "ShockRifle", key: "FireSound" },
  { id: "redeemer", cls: "WarheadLauncher", key: "FireSound" },
  // No FireSound of their own: both play their projectile's SpawnSound from code.
  { id: "rocket", cls: "RocketMk2", key: "SpawnSound" },
  { id: "ripper", cls: "Razor2", key: "SpawnSound" },
];
const EXPLODE = [
  { id: "rocket", cls: "UT_SpriteBallExplosion", key: "EffectSound1" },
  { id: "redeemer", cls: "WarExplosion", key: "EffectSound1" },
];

const out = { source: "UT99 retail", fire: {}, explode: {}, pickup: null };
const jobs = [];

for (const f of FIRE) {
  const name = defaults(f.cls)[f.key];
  if (!name) throw new Error(`${f.cls} has no ${f.key}`);
  out.fire[f.id] = { sound: name, file: `assets/audio/ut/${name.toLowerCase()}.mp3`, from: f.cls };
  jobs.push(name);
}
for (const e of EXPLODE) {
  const name = defaults(e.cls)[e.key];
  if (!name) throw new Error(`${e.cls} has no ${e.key}`);
  out.explode[e.id] = { sound: name, file: `assets/audio/ut/${name.toLowerCase()}.mp3`, from: e.cls };
  jobs.push(name);
}
const pickupName = defaults("enforcer").PickupSound;
if (!pickupName) throw new Error("enforcer has no PickupSound");
out.pickup = { sound: pickupName, file: `assets/audio/ut/${pickupName.toLowerCase()}.mp3` };
jobs.push(pickupName);

fs.mkdirSync(OUT_DIR, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "utsnd-"));
let bytesIn = 0;
let bytesOut = 0;
for (const name of [...new Set(jobs)]) {
  const { wav, from } = findWav(name);
  const wavFile = path.join(tmp, `${name}.wav`);
  fs.writeFileSync(wavFile, wav);
  const mp3 = path.join(OUT_DIR, `${name.toLowerCase()}.mp3`);
  // Mono at 64k: every one of these is already mono, and they are short. -y to overwrite,
  // -loglevel error so a real problem is not buried in banner output.
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wavFile, "-ac", "1", "-b:a", "64k", mp3]);
  const rate = wav.readUInt32LE(24);
  const bits = wav.readUInt16LE(34);
  const seconds = (wav.length - 44) / (rate * (bits / 8));
  bytesIn += wav.length;
  bytesOut += fs.statSync(mp3).size;
  console.log(
    `  ${name.padEnd(14)} ${from.padEnd(14)} ${rate}Hz ${String(bits).padStart(2)}bit ` +
      `${seconds.toFixed(2)}s  ${(wav.length / 1024).toFixed(0)}K wav -> ${(fs.statSync(mp3).size / 1024).toFixed(0)}K mp3`,
  );
}
fs.rmSync(tmp, { recursive: true, force: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2) + "\n");
console.log(
  `wrote ${[...new Set(jobs)].length} sounds — ${(bytesIn / 1024).toFixed(0)}K of WAV as ` +
    `${(bytesOut / 1024).toFixed(0)}K of MP3, and ${path.relative(ROOT, OUT_JSON)}`,
);
