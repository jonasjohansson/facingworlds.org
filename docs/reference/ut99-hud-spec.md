# UT99 (Unreal Tournament, 1999) default HUD — measured visual spec

Authoritative reference for the facingworlds.org HUD. Everything below was
measured from screenshots that were opened and inspected in a browser and
pixel-sampled with a canvas (`getImageData`), not recalled from memory. This is
the **ChallengeHUD** of retail UT99 (v436 era) — NOT UT2003/2004/UT3.

## Sources opened and viewed

| # | Image | Native size | Content |
|---|-------|-------------|---------|
| 1 | https://media.moddb.com/images/games/1/1/5/Screenshot_2023-09-09_015436.png | 1920×1080 | CTF-Face (DM rules), Enforcer held, blue HUD, HUD scale 3 |
| 2 | https://media.moddb.com/images/games/1/1/5/Screenshot_2023-09-08_005925.png | 1920×1080 | DM, Enforcer held, blue HUD |
| 3 | https://media.moddb.com/images/games/1/1/5/Screenshot_2023-08-30_145328.png | 1920×1080 | **CTF-Face, red team**, dual Enforcers, team-score/flag widgets, chat portrait |
| 4 | https://cdn.mobygames.com/screenshots/10455527-unreal-tournament-windows-testing-the-bio-rifle.jpg | 800×600 | Retail 4:3, damage flash, message box with portrait + kill feed + chat |
| 5 | https://cdn.mobygames.com/screenshots/10455530-unreal-tournament-windows-this-is-the-minigun.jpg | 800×600 | Retail 4:3, health 2, frag box flashing on kill, "You killed …" |
| 6 | https://cdn.mobygames.com/screenshots/292393-unreal-tournament-windows-the-redeemer-in-action.jpg | 800×600 | Retail 4:3, clean (no flash, no messages) — best colour reference |
| 7 | https://cdn.mobygames.com/screenshots/10455536-unreal-tournament-windows-attacking-the-train.jpg | 800×600 | Retail 4:3, red team (Assault), match timer visible |

Images 4–7 are the 640×480-native HUD drawn at 800×600 (HudScale 1.25).
Images 1–3 are drawn at 1920×1080 with HudScale 3, i.e. a 640×360 base. All
"base units" below are the 640-wide UT coordinate space; divide by 640 for %W.

## 1. Overall layout

UT99's HUD is four islands. There is no bottom strip; the world is visible
between the islands.

```
┌──────────────────────────────────────────────────────────────────────┐
│[portrait][ kill feed / chat  ─ only while messages exist ]   [ARM  ⛨][doll]
│                                                              [HP   ✚][    ]
│                                                                      [doll]
│                                                        (CTF)  0 [blue flag]
│                                                                      │
│                              ✛ crosshair                             │
│                                                        (CTF)  0 [red flag ]
│                                                                      │
│ Rank: 5 / 5                                                          │
│ Spread: -2                                                           │
│[☠ frags][1 ][2*][3 ][4 ][5 ][6 ][7 ][8 ][9 ][0 ]              [ammo ⁞⁞]│
└──────────────────────────────────────────────────────────────────────┘
```

Measured positions. "16:9" = image 1/3 (1920×1080, scale 3, base 640×360);
"4:3" = image 6 (800×600, scale 1.25, base 640×480).

| Element | Base units (640-wide) | 16:9 px (1920×1080) | 16:9 % | 4:3 px (800×600) | 4:3 % |
|---|---|---|---|---|---|
| Status panel (armour+health) | x 506–570, y 13–64, **64 × 51** | x 1518–1709, y 40–191 (192×152) | left 79.1%, top 3.7%, w 10.0%, h 14.1% | x 632–710, y 0–79 (79×80) | left 79.0%, **top 0%**, w 9.9%, h 13.2% |
| Number cell (each row) | 41 wide × 25 tall | 122 × 76 | w 6.4% | 49 × 39 | |
| Glyph cell (each row) | 23 wide × 25 tall | 70 × 76 | w 3.6% | 30 × 39 | |
| Paper doll | x 580–623, y 7–98, **44 × 92** | x 1739–1870, y 20–295 (132×276) | left 90.6%, top 1.9%, w 6.9%, h 25.6% | x 724–779, y 5–122 (56×118) | left 90.5%, top 0.8%, w 7.0%, h 19.7% |
| Gap panel→doll | 10 | 30 | 1.6% | 13 | |
| Doll right margin | 17 | 50 | 2.6% | 21 | |
| Frag box (skull + count) | x 0–64, bar height 28 | x 0–191, y 995–1079 (192×85) | w 10.0%, h 7.9% | x 0–78, y 561–599 (79×39) | w 9.9%, h 6.5% |
| Weapon slot pitch | **51.2 per slot, 10 slots, no gap** | 153.6 (slot N left edge = 192 + (N−1)·153.6) | 8.0% each | 64 (slot N = 79 + (N−1)·64) | 8.0% |
| Ammo box | x 574–640, **66 wide** | x 1725–1919 (195) | w 10.2% | x 721–799 (79) | 9.9% |
| Bottom bar top edge | y = H − 28 | 995 | 92.1% | 561 | 93.5% |
| Team score rows (CTF, image 3) | blue: digit x 582, y 118; flag x 606–636, y 116–135. red: digit y 192; flag y 188–217 | blue digit x 1746–1775 y 353–404, blue flag x 1818–1907 y 348–404 (90×57). red digit y 576–629, red flag y 564–650 | blue row centre y 35%, red row centre y 56%; right margin 0.7% | — | — |
| Crosshair | 9×9 base (27 px @ scale 3; 10 px @ 800×600) | x 953–979, y 531–557 | centred, 1.4%W | x 393–402, y 293–302 | 1.25%W |
| "Rank:/Spread:" text | bottom-left, above bar | y 1190–1230 (viewport) ≈ 6% above bar | | y 525–560 | |
| Message box (only when messages present) | x 0–556 @800 = **0–445 base**, y 0–62 base | image 3: x 0–1390, y 12–90 | w 70%, h 7% | x 0–555, y 0–77 | w 69.5%, h 12.8% |
| Portrait inside message box | 64 × 60 base (with 2 px bright border) | | | x 0–78, y 0–77 | |
| Match timer (image 7) | red 7-seg "06:39", bottom-left above frag box | | | x 40–150, y 520–545 | |

The whole HUD is drawn with **HudScale = round(W/640)**; nothing is fluid.
At 1920 wide UT uses ×3, so every element is exactly 3× its 640 size. Do the
same: pick an integer scale from viewport width and size everything in base
units × scale.

## 2. Numerals — seven-segment geometry

Measured on the health "100" of image 1 (scale 3) and "100" of image 6 (scale 1.25).

| Property | Image 1 (px) | Base units | Ratio to digit height |
|---|---|---|---|
| Digit height | 52 | 17.3 | 1.00 |
| Digit width ("0") | 32 | 10.7 | **0.62** |
| Segment thickness | 6 | 2 | **0.115** |
| Horizontal segment length (top bar) | 19–24 | 7 | 0.42 |
| Gap between digits | 10 | 3.3 | **0.19** |
| "1" width (b+c segments only) | 6 (occupies a full 32 cell, right-aligned) | | |
| Three-digit total width | 92 | 30.7 | |

- Ends are **mitred at 45°** (hexagonal bars). The corners where a horizontal
  and vertical bar meet are cut so the two bars do not touch — there is a
  visible 1 px (base) dark gap at every joint, exactly like an LCD.
- Digits are right-aligned in a 3-cell field. Leading cells are BLANK (not
  "000"), but the unlit ghost segments of blank cells are **not** drawn — a
  blank cell is empty.
- Number field is centred in the number cell; the "0" of armour sits in the
  right-most cell.

Colours (image 6, clean, over its own blue panel; image 1 over black space):

| Part | Measured | Spec |
|---|---|---|
| Lit segment | #a781ba (image 1, over navy), #c4b5cc (image 4) | **white at ~75% alpha** — it reads as pale lavender because the translucent navy panel shows through. Use `rgba(255,255,255,0.78)`. No glow, no bloom. |
| Unlit segment | #0e0b4d vs panel #07064b (image 1); #3c5572 vs #275b85 (image 6) | HUD colour lightened ~6–8% — barely there. Use `rgba(255,255,255,0.06)` over the panel. Not 16 %. |
| Low-health state (image 5, health 2) | the "2" is drawn dim grey (#8a8a9a-ish), mid-blink | UT99 **flashes** the health number by toggling it between lit and unlit every ~0.25 s when health < 25 (ChallengeHUD `if (Health < 25) … blink`). It does not turn orange or red. |

There is no font behind this — UT99 uses `BigNumbers`/`SmallNumbers` textures
(one bitmap per digit). Reproducing them as seven CSS bars with the ratios above
is correct as long as the mitre and joint gap are kept.

## 3. Panel styling

Every box (status panel, frag box, weapon slots, ammo box, message box) is the
same material: a **translucent tint of the HUD colour with a fine grid texture
and a 1 px (base) brighter border of the same hue.** Nothing is bevelled,
chamfered, gradient-lit or rounded.

| Property | Blue (measured) | Red (measured) | Spec |
|---|---|---|---|
| Fill over black (image 1 / 3) | #07064b | #4c0000 | HUD colour at **~30% alpha** (`rgba(0,0,255,.30)` blue / `rgba(255,0,0,.30)` red). Over image 6's brown wall it reads #275b85, i.e. the world clearly shows through. |
| Grid texture lines | #060593 (1 base px pitch ≈ 4 base px) | #8f0000 | same hue, ~+12% brightness, a 4×4 base-unit grid inside every box |
| Border | #030394 / #236198 (image 5) | #920404 | 1 base px, HUD colour at ~60% alpha, drawn INSIDE the box edge; at scale 3 it is 3 px |
| Divider between armour and health rows | #3a6b94 (image 6) | | same as border, full width of the panel |
| Divider between number cell and glyph cell | present, same as border | | vertical rule at x = 41 base |
| Corners | square | square | `border-radius: 0` |
| Shadow / glow | none | none | none |

The HUD colour is **pure blue (#0000ff family)** for the default/blue team and
**pure red (#ff0000 family)** for red — not steel-blue, not navy, not salmon.
Everything tinted (fill, border, grid, glyphs, doll, skull, bullets) is that one
hue at different alphas.

## 4. Colours

| Token | Value | Where seen |
|---|---|---|
| HUD blue (default & blue team) | `#0000ff` @ varying alpha; solid glyph faces #0706cc–#3f8ed6 | images 1,2,4,5,6 |
| HUD red (red team) | `#ff0000`; solid glyph face #df2421 | images 3, 7 |
| HUD yellow (only warm colour) | `#ffd700`-ish: slot number #d88600 (dim over tint), ammo bar #e5c733, bracket #b78d5b–#ffd21e, crosshair #f2b463 | images 1,3,6 |
| Lit numeral | white ~78% alpha | all |
| Kill-feed line | red text `#ff4040`-ish (measured #885154 under damage tint, #ff6060 in image 3) | images 3,4,5 |
| Chat name | green `#40ff40`; chat text same green dimmer | images 4,5 |
| "You killed X" centre message | light blue `#5c9be6` bold sans, centred at y ≈ 26% H | image 5 |
| "Name: X" target name | green `#40e040`, centred at y ≈ 75% H | images 4,5,6 |
| Rank/Spread | white `#fffaf2`, plain sans, bottom-left; "5 / 5" in red when last | images 1–5 |
| Match timer | HUD colour seven-segment, bottom-left above the bar | image 7 |
| Frag box on kill | flashes solid **gold** (#deae42) for ~0.5 s | image 5 |
| Damage flash | whole screen washed red (world + HUD), not a vignette | image 4 |
| Health thresholds | the number blinks below 25; there is **no** colour change for the number, the panel or the doll | image 5 |

## 5. Glyphs

- **Health cross** (glyph cell of the lower row): a fat plus with square arms,
  arm width ≈ 1/3 of the total, drawn as a **3D bevelled solid** — a lighter top
  face, darker right/bottom faces — in the HUD colour. Occupies 23×25 base
  cell with ~2 px margin (69×72 px at scale 3).
- **Armour shield** (upper row): a rounded shield / "U" shape with two vertical
  ridges, same bevelled 3D style, HUD colour. Drawn slightly darker/dimmer than
  the cross when armour = 0 (image 1: #030294 vs cross #0706cc). 69×76 px at
  scale 3.
- **Ammo glyph** (right of the ammo digits): the current weapon's ammo icon —
  for the Enforcer it is **two pointed bullets side by side**, HUD colour,
  #0504c9 / #6d9dd5, ~70×85 px at scale 3 (23×28 base). Each weapon has its
  own icon; this is the only one needed now.
- **Skull** (frag box): a front-facing skull drawn in the HUD colour at ~55%,
  fills the left ~60% of the frag box (0–55 px of 192 at scale 3 → 18 base).
- **Flag icons** (CTF only, image 3): a 30×19 base flag with pole on the left,
  **solid team colour** (blue #003567→#0060c0, red #7a0000→#c00000), not HUD
  tinted. The score digit to the left of each flag is seven-segment in that
  team's colour. When a flag is taken/dropped UT overlays an "X"/arrow — out of
  scope here.
- **Paper doll**: the player's own mesh is **not** rendered. It is a fixed
  bitmap of a generic armoured male figure (helmet, pauldrons, chest plate,
  segmented thighs, boots), drawn as **bright outlines with a grid/scan-line
  fill**, HUD colour. Measured: outline #206cb0 / #0403a4, fill #42729d @ ~40%
  (image 6), with a faint grid through it. Aspect **44 × 92 base = 0.48**.
  With armour > 0 the torso/legs region corresponding to the armour item is
  drawn brighter (thigh pads, body armour, shield belt = full body); with
  armour 0 (all images here) it is uniformly the dim wireframe. It has no
  glow, no drop shadow, and does not react to health.

## 6. Weapon bar

Measured on images 3, 4, 5, 6, 7:

- **Ten fixed slots**, keys 1…9, 0, each 51.2 base wide, left edge at
  64 + (N−1)·51.2; the bar starts immediately right of the frag box and ends at
  the ammo box. Slot height = bar height = 28 base.
- **Unowned slots are still drawn**, at a much lower alpha: a faint grid-tint
  box with the slot's weapon silhouette in near-transparent dark (image 6,
  unowned slot 3 avg #d1c6d2 over a bright wall = essentially the wall; image
  1 over black: invisible). Treat them as HUD tint at **~8% alpha** with the
  silhouette at ~15% black. With only the Enforcer, slot 2 is bright and slots
  1,3–0 are ghosts. (Image 1 also shows slot 1 = Impact Hammer, which every
  player spawns with in UT99.)
- **Owned slot**: tint at full panel alpha (~30%), slot number in **yellow** at
  the top-left corner (7 base px tall, seven-segment-ish small bitmap font),
  weapon silhouette in **solid black** filling the cell (Enforcer = pistol
  profile pointing right), and a **yellow ammo bar** along the bottom edge:
  2 base px tall, from x+2, length proportional to ammo/maxAmmo of the full
  cell width (image 3: Enforcer 43/199 → 20 px of 153; image 6: 28 px of 64).
- **Selected slot**: the same box plus **yellow corner brackets** OUTSIDE the
  cell: four L-shapes, arm length ≈ 6 base (18 px at scale 3), 1 base thick,
  inset 0 from the cell edge (bracket bbox 153×77 at scale 3 = the cell). The
  fill of the selected cell is slightly **darker/more opaque** than unselected
  owned cells (image 6: #213f55 vs #413d46 around it).
- No weapon names, no key hints, no chamfers, no icon glow.

## 7. Score / frags / CTF

- **DM**: the player's frag count is always visible, bottom-left, in the frag
  box: skull glyph + seven-segment count (2 cells; "3", "0", "2" in images).
  Digit height 22 px at 800×600 = 17.6 base, same as the status digits.
  On a kill the whole box flashes gold (image 5).
- **CTF** (image 3): the frag box stays. Team scores appear on the **right
  edge, mid-screen**: one row per team, `[7-seg score][flag]`, blue row at
  y ≈ 35% H, red row at y ≈ 56% H, right margin ≈ 4 base px. Each row is
  ~30 base tall. The player's own team row is not highlighted. Flag status
  (taken/home) is drawn by changing the flag icon — not by text.
- "Rank: n / m" and "Spread: ±n" in plain white sans sit bottom-left above the
  frag box (this is the "personal info" block; optional but authentic).

## 8. Fonts

UT99 draws all HUD text with bitmap fonts:

- Numerals: `BigNumbers` seven-segment bitmaps — see §2.
- Slot numbers: small yellow seven-segment-style bitmap (7 base px).
- Messages (kill feed, chat, "You killed", "Name:", Rank/Spread): a plain
  **medium-weight humanist sans** (the in-game `MedFont`/`SmallFont`, an Arial/
  Tahoma-like face with normal letter-spacing, ~9–11 base px, NOT condensed,
  NOT tracked-out capitals, no outlines). Centre messages are bold.
- There is no condensed/industrial display face anywhere on the in-game HUD —
  that is a UT2003/2004 thing.

Closest web substitutes: numerals → CSS seven-segment; text → `"Tahoma",
"Verdana", Arial, sans-serif` at 400/700, normal case, no letter-spacing.

## 9. What the current implementation gets wrong

File references: `src/game/components/hud/hud-root.js` (JS),
`styles.css` (CSS; UT99 pass starts at line 1432).

| # | Item | Current | Reference | Where |
|---|---|---|---|---|
| 1 | Bottom strip | one full-width translucent strip with a top border (`.ut-bar` 1587–1598; measured 100%W × 3.5%H) | **no strip** — frag box, ten slots and ammo box are separate islands, world visible between ghost slots | styles.css:1587, 1596–1597 (`background`, `border-top`) |
| 2 | Weapon slots | 5 slots, 36×26 px, centred (`WEAPON_SLOTS` hud-root.js:127–134; `.ut-weapons` 1600–1604) | 10 fixed slots, 8%W each, starting right after the frag box, ghosted when unowned | hud-root.js:127–134, styles.css:1600–1604, 1642–1643 |
| 3 | Slot contents | key text in Saira 9px + white SVG icon (`.ut-wslot__key` 512, `.ut-wslot__icon` 522) | yellow bitmap number top-left, **black** silhouette, yellow ammo bar along the bottom | styles.css:512–535, 551 |
| 4 | Selected bracket | 2 px `#ffd21e` L-corners at `inset:-3px`, 38 % arms (1623–1641) | 1 base px (3 px @×3), arms ≈ 6 base, flush with the cell; cell also darkens | styles.css:1623–1641 |
| 5 | Frag count | top-left chip with target-ring glyph and "FRAGS" caption (`makeChip` hud-root.js:293–302, 340; `.ut-chip--frags` 587, 1646) | **bottom-left** box with a **skull** and no caption; flashes gold on a kill | hud-root.js:76–81, 340; styles.css:587–613, 1646–1652 |
| 6 | TAB hint | present top-left (`.ut-hint` hud-root.js:343–344; styles.css:615, 1656–1660) | does not exist | hud-root.js:343–344, styles.css:1656–1660 |
| 7 | Status panel position | `top:14px; right:16px` (1524–1531), doll gap 10 px; measured left 77.9%, top 1.3%, 11.7%W × 7.6%H | top 0–3.7%H, panel 10.0%W × 14.1%H (16:9), gap 1.6%W, doll 6.9%W × 25.6%H | styles.css:1524–1531 |
| 8 | Panel internals | flex column with padding 6/10 px and a 1 px rule (1533–1547); number and glyph free-floating | 2×2 grid: number cell 41 base wide, glyph cell 23 base wide, both rows and the two columns separated by full rules; a 4-base grid texture inside | styles.css:1533–1574 |
| 9 | Panel material | `linear-gradient(rgba(18,20,78,.5), rgba(10,12,52,.5))` fill, `rgba(96,100,255,.85)` 1 px outer padding-border (1453–1463; tokens 107–109) | flat pure-blue tint ~30% alpha + grid texture, border = same hue ~60% alpha, no gradient, no periwinkle | styles.css:107–109, 1453–1463 |
| 10 | Seven-segment ratios | `.ut-seg` 0.62em × 1.06em, bars 0.10em thick, gap 0.14em (1465–1512); measured 16×28 px, bar 3 px | thickness 0.115 h ✓, width 0.62 h ✓, gap should be 0.19 h (it is 0.13 h), and bars must not touch at the joints (currently `top:0.06em` overlaps) | styles.css:1465–1512 |
| 11 | Lit segment colour | `#c3c3ff` + 6 px glow (114–116, 1481–1484) | white ~78% alpha, **no glow** | styles.css:114–116, 1481–1484 |
| 12 | Unlit segment | `rgba(90,95,200,.16)` (115) | HUD hue at ~6% over the panel — about a third as visible; blank leading cells draw nothing | styles.css:115 |
| 13 | Health colour bands | warn/crit recolour to orange/red + glow, doll follows (`paintHealth` hud-root.js:390–399; styles.css:1515–1518) | no colour change; number **blinks** below 25 | hud-root.js:390–399, styles.css:1515–1518 |
| 14 | Digit size | 26 px em → 28 px digit at 960 wide (2.7%H) | 17.3 base × scale → 52 px at 1920 (4.8%H), 22 px at 800 | styles.css:1468 |
| 15 | Glyphs | flat single-colour SVG plus/shield/cartridge at 26 px, `fill: var(--ut-hue-deep)` #4a4aff (hud-root.js:64–74; styles.css:1576–1577) | bevelled 3D solids in pure HUD blue, 23×25 base (69×76 px @×3); ammo glyph is two bullets | hud-root.js:64–74, styles.css:1576–1577 |
| 16 | Doll | 74×108 px hand-drawn polygon figure, fill `rgba(60,66,220,.55)`, `--ut-hue` highlights, drop-shadow glow, blinks on hit, recolours with health (1580–1585, 1664–1675; hud-root.js:94–122, 499–503) | 44×92 base wireframe-with-grid figure, HUD colour outline ~#206cb0, fill ~40%, no glow, no hit blink, no health colour; lights up only with armour | styles.css:1580–1585, 1664–1675; hud-root.js:94–122, 396–398, 499–503 |
| 17 | Ammo box | inside the strip, `margin-left:auto`, border-left only (1606–1610) | its own box, 66 base wide, full bar height, bordered on all sides, digits left + bullet icon right | styles.css:1606–1610 |
| 18 | Ammo reload blink | blinks digits while "reloading" (hud-root.js:401–408; styles.css:1520–1521) | UT99 has no reload; keep if wanted but it is not a UT99 behaviour | hud-root.js:401–408 |
| 19 | Crosshair | white 11×2 ticks with black outline and blue glow, gap driven by bloom (`.ut-crosshair` 732–757; first-person-weapon.js:101–116) | default UT99 crosshair is a small **yellow** (#f2b463-ish) cross ~9 base px (also a green "x" variant); no outline/glow, no bloom | styles.css:732–757, first-person-weapon.js:104–116 |
| 20 | Kill feed | top-left plain text under the frag chip, Saira condensed, white/50% verbs (`.ut-killfeed` 919–950) | top-left **message box**: translucent tinted box 70%W × 12.8%H (4:3) with the speaker portrait on the left and up to 3–4 lines; kill lines in red, chat in green, plain sans 9–11 base px; box only exists while there are messages | styles.css:919–950 |
| 21 | Fonts | Saira / Saira Condensed for everything (hud-root.js:53–54, 149–165; styles.css:87–89) | plain humanist sans (Tahoma/Arial-like), not condensed, not tracked; no Google Font needed | hud-root.js:53–54, styles.css:87–89 |
| 22 | Team colours | blue team `--ut-hue #7cb6ff / deep #2b6ff0`, red `#ff6b56 / #e02414` + salmon edge (130–146) | pure `#0000ff` / `#ff0000` at alphas; edge is the same hue, not a pastel | styles.css:96–97, 130–146 |
| 23 | Damage feedback | red edge vignette (`damageFlash` hud-root.js:492–504) | full-screen red wash over world and HUD | hud-root.js:492–504 |
| 24 | CTF team scores / flags | not present | right-edge rows at 35%H and 56%H: 7-seg score + solid flag icon | (missing) |
| 25 | HUD scaling | px sizes at any viewport (26 px em, 14/16 px offsets) | integer HudScale = round(W/640); everything is base units × scale | styles.css throughout |

Things the current build gets **right** and should keep: seven-segment digits
in principle (hud-root.js:195–258), armour above health with glyph to the right
of the number, doll standing right of the panel outside it, yellow being the
only warm colour, flat square corners, translucency over the world.
