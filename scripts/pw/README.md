# Playwright probes

Headed Chromium (`launch.mjs`) against the static server on 8080 and the game server on
8081 — `npm run dev` and `npm run server:tls`. **Never headless:** the headless shell
renders through SwiftShader, whose frame times and rasterisation are not the GPU's.

| probe | what it measures |
|---|---|
| `parity.mjs` | runs the four below in one browser, one pass/fail table. ~4 min. |
| `walk.mjs` | speed, jump arc, floor contact, heading — play.html beside index.html |
| `effects.mjs` | a shot's impacts, ejected shell, decal and shock beam, plus screenshots |
| `avatars.mjs` | remote bodies: clips, feet, facing, gun-on-hand, hp label, fire (`--legacy` shoots the A-Frame page instead) |
| `multiplayer.mjs` | the live server: hello, team, spawn, bots, fire, scoreboard, name, two clients |
| `pickups.mjs`, `smoke.mjs`, `screenshot-both.mjs` | per-task checks from the migration |

Frame times and weapon motion live one level up: `node scripts/measure-frametimes.mjs`
and `node scripts/measure-weapon-motion.mjs`, each with `--legacy` for index.html. Run the
two pages back to back, never at once — a second connected client is two fewer bots.
