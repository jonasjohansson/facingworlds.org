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
// SELECT sounds are the sixth set: TournamentWeapon.PlaySelect plays SelectSound in the
// same breath as PlayAnim('Select'), so raising a weapon is one event with a picture and
// a noise. All six name their own; see the SELECT table.
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
const ANNOUNCER = path.join(SYSTEM, "..", "Sounds", "Announcer.uax");
const loaded = PACKAGES.map((f) => ({ name: f, pkg: loadPackage(fs.readFileSync(path.join(SYSTEM, f))) }));
if (fs.existsSync(ANNOUNCER)) {
  loaded.push({ name: "Announcer.uax", pkg: loadPackage(fs.readFileSync(ANNOUNCER)) });
}
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
// The noise a weapon makes as it comes UP in your hands. Every one of the six names its
// own SelectSound, and TournamentWeapon.PlaySelect plays it beside PlayAnim('Select'):
//
//     simulated function PlaySelect()
//     {
//         ...
//         PlayAnim('Select',1.0,0.0);
//         Owner.PlaySound(SelectSound, SLOT_Misc, Pawn(Owner).SoundDampening);
//     }
//
// so the sound and the animation are one event, and the client should start them
// together. Read off the weapon class, not listed: Cocking, RiflePickup, TazerSelect,
// Selecting, beam, WarheadPickup.
const SELECT = [
  { id: "enforcer", cls: "enforcer" },
  { id: "sniper", cls: "SniperRifle" },
  { id: "shock", cls: "ShockRifle" },
  { id: "rocket", cls: "UT_Eightball" },
  { id: "ripper", cls: "ripper" },
  { id: "redeemer", cls: "WarheadLauncher" },
].map((s) => ({ ...s, key: "SelectSound" }));

const out = { source: "UT99 retail", fire: {}, select: {}, explode: {}, pickup: null };
const jobs = [];

for (const f of FIRE) {
  const name = defaults(f.cls)[f.key];
  if (!name) throw new Error(`${f.cls} has no ${f.key}`);
  out.fire[f.id] = { sound: name, file: `assets/audio/ut/${name.toLowerCase()}.mp3`, from: f.cls };
  jobs.push(name);
}
for (const f of SELECT) {
  const name = defaults(f.cls)[f.key];
  if (!name) throw new Error(`${f.cls} has no ${f.key}`);
  out.select[f.id] = { sound: name, file: `assets/audio/ut/${name.toLowerCase()}.mp3`, from: f.cls };
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

// ---------------------------------------------------------------------------
// THE ANNOUNCER
// ---------------------------------------------------------------------------
// The rules for WHEN each of these fires are UT99's, read out of the same packages:
//
//   FIRST BLOOD  DeathMatchPlus guards it with a bFirstBlood flag — once a match, on the
//                first kill, broadcast to everyone.
//
//   MULTI-KILL   DeathMessagePlus: `if (Level.TimeSeconds - LastKillTime < 3)` then
//                MultiLevel++ and announce, else MultiLevel = 0. A THREE SECOND window
//                between kills, and MultiKillMessage maps the level 1 -> DoubleKill,
//                2 -> MultiKill, 3 -> UltraKill, 4 and up -> MonsterKill. It goes to the
//                killer alone, not the room.
//
//   SPREE        DeathMatchPlus calls NotifySpree once Spree passes 4, and NotifySpree
//                itself only speaks at EXACTLY 5, 10, 15, 20 and 25 — anything else
//                returns without a word. The five sounds are read from
//                KillingSpreeMessage's own SpreeSound array rather than typed. Everyone
//                hears it, and dying resets the count.
//
// megakill and triplekill are in the package and are NOT used: UT99's MultiKillMessage
// never reaches for them. They are left out rather than pressed into service.
const spreeSounds = defaults("KillingSpreeMessage").SpreeSound;
if (!Array.isArray(spreeSounds) || spreeSounds.length !== 5) {
  throw new Error(`KillingSpreeMessage.SpreeSound is ${JSON.stringify(spreeSounds)}, expected 5 names`);
}
out.announcer = {
  firstBlood: "firstblood",
  // Index by MultiLevel; 4 and beyond all use the last one.
  multiKill: ["doublekill", "multikill", "ultrakill", "monsterkill"],
  multiKillWindowMs: 3000,
  spreeAt: [5, 10, 15, 20, 25],
  spree: spreeSounds,
  match: { start: "prepare", won: "winner", lost: "lostmatch" },
  capture: "capture",
  // Both the Sniper Rifle and the Ripper decide a headshot with the same line —
  // HitLocation.Z - Other.Location.Z > 0.62 * Other.CollisionHeight — so one word covers
  // both. It goes to the shooter, the way a multi-kill does.
  headshot: "headshot",
  dir: "assets/audio/ut/announcer",
};
const announcerJobs = [
  out.announcer.firstBlood,
  ...out.announcer.multiKill,
  ...out.announcer.spree,
  out.announcer.match.start,
  out.announcer.match.won,
  out.announcer.match.lost,
  out.announcer.capture,
  out.announcer.headshot,
];

fs.mkdirSync(path.join(OUT_DIR, "announcer"), { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "utsnd-"));
let bytesIn = 0;
let bytesOut = 0;
for (const name of [...new Set([...jobs, ...announcerJobs])]) {
  const { wav, from } = findWav(name);
  const wavFile = path.join(tmp, `${name}.wav`);
  fs.writeFileSync(wavFile, wav);
  const isAnnouncer = announcerJobs.includes(name);
  const mp3 = path.join(isAnnouncer ? path.join(OUT_DIR, "announcer") : OUT_DIR, `${name.toLowerCase()}.mp3`);
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
  `wrote ${new Set([...jobs, ...announcerJobs]).size} sounds — ${(bytesIn / 1024).toFixed(0)}K of WAV as ` +
    `${(bytesOut / 1024).toFixed(0)}K of MP3, and ${path.relative(ROOT, OUT_JSON)}`,
);
