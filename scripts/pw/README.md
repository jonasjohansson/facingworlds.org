# Playwright probes

Headed Chromium (`launch.mjs`) against the static server on 8080 and the game server on
8081 — `npm run dev` and `npm run server:tls`. **Never headless:** the headless shell
renders through SwiftShader, whose frame times and rasterisation are not the GPU's.

| probe | what it measures |
|---|---|
| `parity.mjs` | runs the four below in one browser, one pass/fail table. ~3 min. |
| `walk.mjs` | speed (9.4 m/s best window), jump arc, floor contact, heading |
| `effects.mjs` | a shot's impacts, ejected shell, decal and shock beam, plus screenshots |
| `avatars.mjs` | remote bodies: clips, feet, facing, gun-on-hand, hp label, fire |
| `multiplayer.mjs` | the live server: hello, team, spawn, bots, fire, scoreboard, name, two tabs |
| `pickups.mjs`, `smoke.mjs` | pickups/CTF against the live server; console errors and frames |

Frame times and weapon motion live one level up: `node scripts/measure-frametimes.mjs`
and `node scripts/measure-weapon-motion.mjs`. Run one probe at a time — a second connected
client is two fewer bots, and the bot count is part of the measurement.
