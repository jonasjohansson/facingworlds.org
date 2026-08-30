# UT99 ChallengeHUD / ChallengeCTFHUD -- exact implementation spec (from source)

Derived from the UnrealScript in `ut99-ref/scripts/` (ChallengeHUD.uc, ChallengeTeamHUD.uc,
ChallengeCTFHUD.uc, CTFMessage*.uc, MultiKillMessage.uc, KillingSpreeMessage.uc, Engine
Canvas.uc/HUD.uc, FontInfo, LocalMessagePlus, CriticalEventPlus), the class default
properties read straight out of `BotPack.u` / `Engine.u`, `DefUser.ini`, and pixel dumps
of the PNGs in `ut99-ref/textures/`. Nothing here is eyeballed from screenshots. Where a
value could not be verified from the extracted material it is marked UNVERIFIED.

The PNGs are Epic's assets: they are measured here so we can REDRAW every glyph as our
own SVG. None of them ships.

--------------------------------------------------------------------------------
## 0. The one rendering model everything hangs on

### 0.1 Scale
`ChallengeHUD.HUDSetup`:
```
Scale     = HUDScale * ClipX / 1280        (HUDScale default 1.0)
StatScale = Scale * StatusScale            (StatusScale default 1.0)  == Scale
WeapScale = Scale * WeaponScale            (WeaponScale default 0.8)  == 0.8 * Scale
```
Everything is in **S = ClipX / 1280**. It is continuous, not an integer step, and it
depends on WIDTH only. `1 S = 0.078125 vw`. Vertical positions are `ClipY - k*S`, i.e.
bottom-anchored in vw units, NOT vh.

| viewport | S | 1 S in px |
|---|---|---|
| 1920x1080 | 1.5 | 1.5 px |
| 640x480 | 0.5 | 0.5 px |

So a "128 S" tile is 10 vw wide at every resolution (192 px @1920, 64 px @640).

### 0.2 Fresh-install configuration (DefUser.ini `[Botpack.ChallengeHUD]`, class defaults)
```
bUseTeamColor=true   FavoriteHUDColor=(R=0,G=0,B=16)   CrosshairColor=(R=0,G=16,B=0)
HudScale=1.0  Opacity=15  StatusScale=1.0  WeaponScale=0.8
bHideAllWeapons=false bHideStatus=false bHideAmmo=false bHideTeamInfo=false bHideFrags=false
[Engine.HUD] Crosshair=0  -> Botpack.CHair1
Level.bHighDetailMode = true on any real machine
```
Consequences (HUDSetup): `Opacity != 16` -> **Style = STY_Translucent**;
`BaseColor = (16*15+15) * UnitColor = (255,255,255)`; `SolidHUDColor = FavoriteHUDColor*15.9`.

### 0.3 Colour: the atlas is GREYSCALE; DrawColor tints it; STY_Translucent is a SCREEN blend
Every HUD texture (HudElements1, HUDWeapons, Man, ManBelt, I_Home/I_Capt/I_Down, Use*, FacePanel*)
is grey. The on-screen colour is `texel_luminance * DrawColor`, composited with
STY_Translucent, which in UE1 is `dst = src + dst * (1 - src)` (black texels are invisible,
nothing ever darkens the world). That is CSS `mix-blend-mode: screen` -- or, as a close
approximation on dark backgrounds, an alpha of `luminance/255`.

So the "translucent blue panel" is literally: a grey grid tile (background luminance 66/255 = 0.26,
grid lines 84/255 = 0.33, 3 px border 124/255 = 0.49) multiplied by the HUD colour, screened
over the world. The digits are a 127/255 = 0.50 grey glyph times white, screened -- which is
why lit numerals read as pale lavender over the blue box and mid grey over black space.

### 0.4 HUD colour (the actual values)
| Context | Formula (ChallengeHUD / ChallengeTeamHUD.HUDSetup) | Result |
|---|---|---|
| DM / non-team | `HUDColor = FavoriteHUDColor * (Opacity + 0.9) = (0,0,16)*15.9` | **(0, 0, 254)** |
| Team game, red (team 0) | `HUDColor = Opacity*0.0625 * TeamColor[0] = 0.9375*(255,0,0)` | **(239, 0, 0)** |
| Team game, blue (team 1) | `0.9375 * TeamColor[1] = 0.9375*(0,128,255)` | **(0, 120, 239)** |
| SolidHUDColor (team) | `TeamColor[team]` unscaled | (255,0,0) / (0,128,255) |
| TeamColor[2] green, [3] gold | (0,255,0), (255,255,0) | |
| AltTeamColor | (200,0,0) (0,94,187) (0,128,0) (255,255,128) | ID text only |

**Blue team is NOT pure blue. It is (0,128,255) -- azure.** Only the DM default is pure blue.
Other constants (ChallengeHUD defaults): WhiteColor (255,255,255), RedColor (255,0,0),
GreenColor (0,255,0), CyanColor (0,255,255), GoldColor (255,255,0), PurpleColor (255,0,255),
TurqColor (0,128,255), GrayColor (200,200,200), FaceColor (50,50,50), UnitColor (1,1,1).

Colour arithmetic in UnrealScript is per-byte with saturation (clamps 0..255). This matters
for the low-health formula below.

--------------------------------------------------------------------------------
## 1. Layout (default config, one weapon owned)

Notation: `(x, y, w, h)` in S; `W = ClipX`, `H = ClipY`. Draw order is PostRender:
messages -> crosshair -> ammo -> status (doll, health, armour) -> weapons -> frags ->
team synopsis (CTF scores) -> CTF flag icons.

### 1.1 Status doll (DrawStatus, `bHasDoll` true when ClipX >= 400)
| item | source | S units | 1920x1080 px | 640x480 px | CSS |
|---|---|---|---|---|---|
| Doll tile `Icons.Man` (0,0,128,256) | `SetPos(W-128*StatScale, 0)`, size 128x256*StatScale, colour HUDColor, STY_Translucent | (W-128, 0, 128, 256) | (1728, 0, 192, 384) | (576, 0, 64, 128) | `right:0; top:0; width:10vw; height:20vw` |
| Visible figure inside the tile | bbox of non-black texels: x 8..104, y 8..197 (of 128x256) | | (1740..1884, 12..296) | | figure is 75% of tile width, 74% of tile height, starting at 6% / 3% |
| Shield belt overlay `ManBelt` (128x256) | only if UT_ShieldBelt: DrawIcon(DollBelt, StatScale), colour = BaseColor with B=0 -> **(255,255,0) yellow** outline | same rect | | | belt = white outline of the whole silhouette, drawn yellow |
| Chest armour overlay | `Man` sub-rect (128,0,128,64) at (X, 0), size 128x64 StatScale, colour `HUDColor * min(ChestAmount/100, 1)` | (W-128, 0, 128, 64) | (1728,0,192,96) | | overlay brightness = armour/100 |
| Thigh pads overlay | `Man` (128,64,128,64) at (X, 64 StatScale), colour `HUDColor * min(ThighAmount/50,1)` | (W-128, 64, 128, 64) | | | |
| Jump boots overlay | `Man` (128,128,128,64) at (X, 128 StatScale), HUDColor | (W-128, 128, 128, 64) | | | |
| Damage markers | up to 4 minus-sign tiles (HudElements1 0,64,25,64) at `X + HitPos.X*StatScale, HitPos.Y*StatScale`, size 25*HitDamage x 64*HitDamage (HitDamage = clamp(dmg*0.06, 2, 4)), for 1 s; colour: if HUD is blue-ish (G>100 or B>100) RedColor, else `(White - HUD) * min(1, 2t)`; R forced to `255*min(1,2t)` | | | | red dashes appear ON the doll where you were hit; NOT a screen vignette |
| DamageScaling > 2 (amp) | doll drawn PurpleColor | | | | |

Body Armor on Face is `armor2` -> ChestAmount. Thighs/boots/belt do not exist on CTF-Face.

### 1.2 Armour box + digits (top right, ABOVE health)
| item | source | S | 1920x1080 | 640x480 | CSS |
|---|---|---|---|---|---|
| Shield tile HudElements1 (0,192,128,64) | `X = W - 128*StatScale - 140*Scale; Y = 0`, colour HUDColor | (W-268, 0, 128, 64) | (1518, 0, 192, 96) | (506, 0, 64, 32) | `right: 10.9375vw; top: 0; width: 10vw; height: 5vw` |
| Digits | `DrawBigNum(min(150, Armor), X+4S, Y+16S, 1)` colour WhiteColor (GoldColor only if bHideStatus && belt) | origin (W-264, 16) | (1524, 24) | (508, 8) | see section 3 for field layout |

### 1.3 Health box + digits
| item | source | S | 1920x1080 | 640x480 | CSS |
|---|---|---|---|---|---|
| Cross tile (128,128,128,64) | `Y = 64*Scale`, same X | (W-268, 64, 128, 64) | (1518, 96, 192, 96) | (506, 32, 64, 32) | `right:10.9375vw; top:5vw; width:10vw; height:5vw` |
| Digits | `DrawBigNum(max(0,Health), X+4S, Y+16S, 1)` | origin (W-264, 80) | (1524, 120) | (508, 40) | |

There is **no gap and no divider** between the armour and health tiles: two 128x64 tiles
stacked flush; each tile carries its own 3 px (2.3%) border so the seam reads as a double rule.
There is a **12 S gap** (W-140S .. W-128S) between the boxes and the doll tile.

### 1.4 Ammo box (bottom right)
`Y = H - 63.5*S` because `HudScale*WeaponScale*ClipX (=0.8W) <= ClipX - 256*S (=0.8W)` is true.
| item | S | 1920x1080 | 640x480 | CSS |
|---|---|---|---|---|
| Bullets tile (128,192,128,64), HUDColor | (W-128, H-63.5, 128, 64) | (1728, 984.75, 192, 96) | (576, 448.25, 64, 32) | `right:0; bottom:-0.039vw; width:10vw; height:5vw` |
| Digits `DrawBigNum(AmmoAmount, X+4S, Y+16S)` white | origin (W-124, H-47.5) | (1734, 1008.75) | (580, 464.25) | |
The tile overhangs the bottom edge by 0.5 S (the texture's own 3 px border is cut off there).
No digits if the weapon has no AmmoType.

### 1.5 Frag / score box (bottom left) -- drawn in DM **and** CTF (bHideFrags=false)
| item | S | 1920x1080 | 640x480 |
|---|---|---|---|
| Skull tile (0,128,128,64), HUDColor, `X = 0` (uninitialised local int) | (0, H-63.5, 128, 64) | (0, 984.75, 192, 96) | (0, 448.25, 64, 32) |
| Digits `DrawBigNum(PRI.Score, X+40S, Y+16S)` white | origin (40, H-47.5) | (60, 1008.75) | (20, 464.25) |
Score flash: for 3 s after `ScoreTime` (set when your score changes; setter lives in
TournamentPlayer, UNVERIFIED) the tile colour is `Gold + (HUDColor - Gold) * frac(4t)` -- a
4 Hz sawtooth from gold back to HUD colour -- and a soft glow (HUDWeapons 0,128,256,128 at
256Sx128S centred on the box, gold, translucent) sits behind it. Gold flashes WHITE if the
HUD colour is already gold. In CTF `Score` = frags + capture bonuses.

### 1.6 Weapon bar (DrawWeapons)
```
BaseX        = 0.5 * (W - 0.8W) = 0.1 W          (= 128 S)
WeaponOffset = 0.1 * 0.8 * W    = 0.08 W         (= 102.4 S)  slot pitch
BaseY        = H - 63.5 * WeapScale = H - 50.8 S
slot tile    = 128*WeapScale x 64*WeapScale = 102.4 S x 51.2 S  (= 8vw x 4vw)  -> no gap between slots
```
Row is therefore `[frag 0..10vw][slot1 10..18vw] ... [slot10 82..90vw][ammo 90..100vw]`. The
frag/ammo boxes are 5 vw tall, the slots only 4 vw, so the two corner boxes stand 1 vw
(12.7 S) taller than the bar and 0.4 S lower (H-63.5S vs H-50.8S).

| slot i | x | 1920 px | 640 px |
|---|---|---|---|
| i = 1..10 | `0.1W + (i-1)*0.08W` | 192 + 153.6(i-1), y 1003.8, 153.6x76.8 | 64 + 51.2(i-1), y 454.6, 51.2x25.6 |

What each slot draws (all ten always drawn, `WeaponSlot[i]==None` included):
* **Empty slot** (no weapon in group i): HUDWeapons cell `((i-1)%4*64, (i-1)/4*32, 64, 32)` scaled 2x to the slot, colour `0.5 * HUDColor`, translucent. The cell art (see 4.6) is a dark grid box (lum 21..41) with a faint outline of that group's weapon and a 1-texel lighter border -- so empty slots are **very dim boxes with a ghost silhouette**, ~half the brightness of the corner boxes and with no number.
* **Owned, not held, not pending**: exactly the same cell at `0.5*HUDColor` (unless `bSpecialIcon`, then its StatusIcon) PLUS the gold slot number PLUS the ammo bar.
* **Owned and pending (switching to)**: cell drawn `SolidHUDColor`, STY_Normal (opaque), plus a glow tile HUDWeapons (0,128,256,128) at `(slotX - 64 WeapScale, H - 96 WeapScale)` = `(slotX - 51.2S, H - 76.8S)`, size 204.8 S x 102.4 S, GoldColor, translucent -- a soft yellow rounded blob twice the slot size behind it.
* **Held weapon**: `W.StatusIcon` (the `Use*` 128x64 texture, e.g. `UseAutoM` for the Enforcer) at slot size, colour SolidHUDColor, **STY_Normal** (Opacity 15 > 8) -> the held slot is OPAQUE: tinted grid box, black silhouette. Then the gold slot number, then the bracket tile HUDWeapons (128,64,128,64) at slot size in GoldColor translucent (geometry in 4.7). The ammo bar is drawn for it too (it has AmmoType).
* **Slot number** (owned slots only): HudElements1 digit `i` (0 for slot 10), size `0.75*WeapScale*25 x 0.75*WeapScale*64` = 15 S x 38.4 S tile (glyph 13 S x 21.6 S), at `(slotX + 4 WeapScale, BaseY + 4 WeapScale)` = `(slotX + 3.2 S, BaseY + 3.2 S)`, GoldColor, STY_Normal (opaque gold at 50% luminance = (128,128,0)).
* **Ammo bar** (owned slots with AmmoType): HudElements1 (64,64,128,8) drawn `AmmoScale x 8 WeapScale` where `AmmoScale = clamp(88 WeapScale * ammo/max, 0, 88)` -> **max 70.4 S wide, 6.4 S tall**, at `(slotX + 3.2 S, BaseY + 52 WeapScale = BaseY + 41.6 S)`, colour BaseColor (white) -> the texture's own orange->yellow gradient, translucent. The full 128-texel gradient is always mapped onto the current width (it squashes, it does not clip).

### 1.7 Rank / Spread (DM only)
`ChallengeTeamHUD.DrawGameSynopsis` replaces it in team games, so **CTF never shows Rank/Spread**.
DM: big font, white, `SetPos(0, H - 64S - 2*YL)`, "Rank: 3 / 8" then "Spread: +2" on the next line (red rank when tied). Hidden when PlayerCount == 1.

### 1.8 CTF team scores (ChallengeCTFHUD.DrawTeam) -- right edge, mid-height, **red BELOW blue**
| team | digits origin `(W - 144S, H - 336S - 150S*TeamIndex)` | 1920 | 640 | flag icon `(W - 70S, H - 350S - 150S*i)` size 64S | 1920 | 640 |
|---|---|---|---|---|---|---|
| 0 red | (W-144, H-336) | (1704, 576) | (568, 312) | (W-70, H-350, 64, 64) | (1815, 555, 96, 96) | (605, 305, 32, 32) |
| 1 blue | (W-144, H-486) | (1704, 351) | (568, 237) | (W-70, H-500, 64, 64) | (1815, 330, 96, 96) | (605, 230, 32, 32) |
Digits: `DrawBigNum(score, ..., 1)` in **TeamColor[team] at full strength** (255,0,0) / (0,128,255), NOT the opacity-scaled HUDColor, translucent. A one-digit score's tile spans `origin + 28S .. +53S` (1746..1783 @1920), glyph rows origin..+36S (576..630 red, 351..405 blue) -- this matches the earlier screenshot measurement exactly (blue digit y 353-404).
Flag icons: `DrawIcon(I_Home | I_Capt | I_Down, Scale*2)` = 32x32 texture at 64S, colour `TeamColor[Flag.Team]`, style translucent; drawn only if `!bHideTeamInfo`. State: `bHome` -> I_Home (flag on pole, solid cloth); `bHeld` -> I_Capt (dark cloth with a light "!"-shaped figure); else -> I_Down (dark cloth with a down arrow). Section 4.8 has the geometry.
CSS: `right: 5.47vw` (70S) for icons, `bottom: 27.34vw` / `39.06vw` (350S/500S) for icon tops... simplest: `bottom: calc(350*0.078125vw - 5vw)` for the red icon bottom edge, etc. Digits `right: 11.25vw` field origin.
No team icon (I_TeamR/B tab) is drawn in CTF -- ChallengeCTFHUD.DrawTeam overrides the base team HUD's icon+text version.

### 1.9 Crosshair (DrawCrossHair)
```
XScale  = ClipX < 512 ? 0.5 : max(1, int(0.1 + ClipX/640))     -> 1 @640, 2 @1280, 3 @1920
XLength = 64 * XScale ; pos = 0.5*(W - XLength), 0.5*(H - XLength)   (Handedness 0)
colour  = 15 * CrosshairColor = 15*(0,16,0) = (0, 240, 0)  GREEN ; STY_Translucent ; bNoSmooth off (bilinear)
pickup pulse: for 0.4 s after any pickup, XScale *= 1+5t (t<0.2) then 3-5t  -> grows to 2x and back
```
Default texture `CHair1` (64x64, greyscale): a **plus with a hollow centre and a centre dot**:
vertical arm x=32, rows 26..30 and 34..38 (with the pixel at 27 and 33 missing -> a
dashed feel: rows 26, 28,29,30 and 34,35,36, 38); horizontal arm y=32, cols 27..29 and
35..37 (plus isolated pixels at 25 and 39); centre pixel (32,32) lit; everything else black.
Arm pixels are 255 white, a few 96..159 anti-alias pixels. In screen px at 1920 (XScale 3,
integer scaled): 3 px-thick green ticks, ~9-12 px long, centre 3x3 dot, gaps of 3 px. **No
outline, no glow, no bloom, green not white.** CHair1 was verified; the "yellow" in the
screenshot spec was a user-configured colour.

### 1.10 Message area (top left) -- kill feed, chat, pickups
* Font: `MyFonts.GetSmallFont(ClipX)`: `SmallFont` (<640), `UTLadder10` (640-799), `UTLadder14` (800-1023), `UTLadder16` (>=1024). Plain bitmap sans, roughly 10/14/16 px cap height; NOT condensed, NOT tracked.
* Position: `SetPos(6, 2 + YL * line)`, up to 4 messages / 4 lines total, clip width `768*S - 10` (60 vw). Left-aligned. Lifetime 3 s (LocalMessage default) then purged on the 1 s Timer.
* Colours: death messages (`RedSayMessagePlus` / `DeathMessagePlus`) **(255,0,0)**; Say / TeamSay (`SayMessagePlus`) **(0,255,0)** with the speaker name; pickups / generic `StringMessagePlus` white; LocalMessagePlus GreenColor (0,255,0), LightGreen (0,128,0), Cyan (0,128,255).
* Death message strings: "<killer> killed <victim>" style from `DeathMessagePlus.DeathString = "was killed by"` (+ KillerMessagePlus for your own kills). First blood: `FirstBloodMessage` "<name> drew first blood!" red, centre.
* Backdrop (DrawSpeechArea, only when `!bHideFaces`): FacePanel1/2/3 tiles (256x128 grey: top 70 rows lum 33 = 0.13, a 1-texel 57 line at row 68, black below; FacePanel1 has a lighter left edge column), drawn `2*YPos` tall where `YPos = max(4*YL + 8, 70*S)`, from x = `YPos + 7S + FaceAreaOffset` to about `768 S` wide, colour `HUDColor * MessageFadeTime`, translucent. Visible band = top 55% of the stretched tile = ~1.1*YPos = **77 S (~6 vw) tall, 60 vw wide**, i.e. a very faint (13% of HUD colour) tinted strip with a hairline lower edge. It fades IN over 1/8 s when a message exists and OUT over 1/2 s, 2 s after the last one expires. Talk face (portrait) at `(FaceAreaOffset + 4S, 4S)`, size `YPos - S` square, opaque, with a static-noise tile tinted TeamColor/FaceColor over it -- only while someone talks (3 s).
* Typing prompt: green `(> text_`, small font, at origin `(FaceAreaOffset + 15S + YPos, YPos + 7S)`.

### 1.11 Centre messages (LocalMessages)
`YPos` is in a 768-tall virtual space: `y = YPos/768 * ClipY` (+YL for MultiKill). Centred horizontally (`0.5*(W - XL)`). Fonts: FontSize 1 -> `GetBigFont` (UTLadder16 <640, 18 <800, 20 <1024, 22 >=1024); FontSize 2 -> `GetHugeFont` (16 / 20 / 22 / 30 by the same breaks). `bFadeMessage` -> drawn translucent with `DrawColor * remaining/Lifetime` (linear fade to black over the whole 3 s life; no fade-in, no scale punch).

| message | class | y | colour | font | text |
|---|---|---|---|---|---|
| kill / capture / return / first blood / spree | CriticalEventPlus family | `0.2552 * H` | (0,128,255) unless overridden; FirstBlood & Decapitation red | Big | see 6 |
| MultiKill switch 1 (Double) | MultiKillMessage | `0.2552*H + YL` | (255,0,0) | Big | "Double Kill!" |
| MultiKill switch 2 / 3 / 4+ | | same | red | **Huge** | "Multi Kill!" / "ULTRA KILL!!" / "M O N S T E R  K I L L !!!" |
| Killing spree | KillingSpreeMessage (CriticalEventLowPlus) | `0.2552*H` | (0,128,255) | Big | "<name> is on a killing spree!" etc. -- third person, includes the name |
| Head shot | DecapitationMessage | 0.2552H | red | Big | "Head Shot!!" |
| Pickup | PickupMessagePlus | `64/768 * H = 0.0833 H` | white | Big | "You got the Rocket Launcher." |
| You have the flag | CTFMessage2 sw 0 | `H - 2*YL - 0.0833*H` | **(255,255,0)** | Big | "You have the flag, return to base!" |
| Enemy has your flag | CTFMessage2 sw 1 | `H - 3*YL - 0.0833*H` | **(255,0,0)** | Big | "The enemy has your flag, recover it!" |
CTFMessage2 has Lifetime 1 and is re-sent by `ChallengeCTFHUD.Timer` every second while the
condition holds, with bFadeMessage -> it **pulses**: full brightness every second, fading to
black in between. bIsUnique messages sharing an offset replace each other (a new kill
message replaces a spree message on the same line).

--------------------------------------------------------------------------------
## 2. Colours and their modulation

### 2.1 Per element
| element | DrawColor | style | on screen (blue team, over black) |
|---|---|---|---|
| Box tiles (skull/cross/shield/bullets), doll, flag icons? | HUDColor (0,120,239) | translucent | fill 0.26 -> (0,31,62); grid 0.33 -> (0,40,79); border 0.49 -> (0,58,116); glyph highlights up to 1.0 -> (0,120,239) |
| Same, red team | (239,0,0) | | fill (62,0,0), border (116,0,0) |
| Same, DM default | (0,0,254) | | fill (0,0,66), border (0,0,124) -- the earlier screenshot values (#05044b / #030394) were this, i.e. a DM screenshot |
| Digits (health, armour, ammo, frags) | WhiteColor | translucent | glyph 0.50 white screened: over black #7f7f7f, over the blue box lighter lavender |
| Team score digits | TeamColor (255,0,0)/(0,128,255) | translucent | 50% of team colour screened |
| Slot numbers | GoldColor | STY_Normal (opaque) | (128,128,0) |
| Held-weapon icon | SolidHUDColor (0,128,255) | STY_Normal (opaque) | opaque tinted box, black silhouette |
| Selection bracket, pending glow, frag flash glow | GoldColor | translucent | (128,128,0) bracket |
| Empty / owned-unselected slots | 0.5 * HUDColor | translucent | half brightness of the boxes |
| Ammo bars | BaseColor (white) | translucent | the texture's own orange-yellow |
| Shield belt overlay | (255,255,0) | translucent | yellow outline of the doll |
| Chest armour overlay | HUDColor * armour/100 | translucent | brightens with armour |
| Crosshair | (0,240,0) | translucent | green |

### 2.2 Health thresholds -- `Health < 50`, not 25, and nothing goes orange/red
`TutIconBlink` is a sawtooth 0 -> 0.5 s that resets every 0.5 s (2 Hz). With
`H1 = 1.5*TutIconBlink` (0 -> 0.75) and `H2 = 1 - H1`:
* Cross tile colour = `White*H2 + (HUDColor - White)*H1`. `(HUDColor - White)` clamps to (0,0,0) for every HUD colour, so the cross becomes **white** and its brightness ramps DOWN from 100% to 25% over each half second, then snaps back -- the cross flashes white at 2 Hz instead of being blue.
* Digit colour = `C*H2 + (White - C)*H1` with `C = White*H2` -> `White*(H2^2 + H1^2)`: brightness 100% -> 50% (at t=0.25 s) -> 62.5% (t=0.5 s) then snap to 100%. The digits dim to half and recover, 2 Hz sawtooth. They never switch off and never change hue.
* Health >= 50: cross = HUDColor, digits = white, no animation. `Health < 25` does nothing special.
* Armour digits: always white (gold only in bHideStatus mode with a belt). Armour 0 draws "0" in the same white -- no dimming.

### 2.3 Fades
* Centre messages: linear `DrawColor * remaining/Lifetime`, 3 s, translucent.
* Message backdrop: `MessageFadeTime` +8/s in, -2/s out (after a 2 s hold).
* Weapon name (only with weapon bar hidden): `WeaponNameFade` 1 -> 0 at 1/s.
* Identify ("Name: X" under the crosshair at `H - 256S`): green `(0, 255*fade/3, 0)`, 3 s.
* MOTD block at `64S` down, white * 0.5..0.6, fades at 55/s from 350 (network) -- ~6 s.
* Frag flash: 3 s, 4 Hz gold->HUD sawtooth (2.1).

--------------------------------------------------------------------------------
## 3. Digits (HudElements1 rows 0..63)

### 3.1 Cell and glyph metrics (pixel dump of digit 0 / 1 / 8)
* Atlas cell: 25 x 64 texels; the glyph occupies **cols 0..21 (22 wide), rows 0..35 (36 tall)**; rows 36..63 are empty (transparent). So a digit drawn at `25S x 64S` has a visible glyph of `22S x 36S` sitting at the TOP of its cell; the number's visual baseline is 36S below the DrawBigNum origin, not 64S.
* **Unlit segments are NOT drawn.** Alpha is 0 everywhere outside the lit strokes (the texture is masked; index 0 = transparent). There are no ghost bars. A blank leading cell draws nothing.
* Stroke: horizontal bars 5 texels tall (rows 1..5 top, 15..19 middle, 31..35 bottom) plus a 1-texel darker rim; vertical bars **5 texels wide** (cols 0..4 left, 15..19 right) plus a 1-texel darker rim on the right (col 5 / col 20 at lum 93). Effective thickness incl. rim = 6 = **0.167 of glyph height**, solid core 5 = 0.139.
* Ends are **45-degree mitres**, and every joint is broken: a 1-2 texel diagonal dark gap between the end of a horizontal bar and the neighbouring vertical bar (e.g. digit 0 rows 4-5 / cols 4-5). Middle bar of 8 spans cols 3..17 with mitred ends, rows 15..19; the verticals stop at row 14 / start at row 19-20, so the joints are notched exactly like an LCD.
* Luminance: core 127 (0.50), rim 93 (0.36), the very top row of a top bar 58 (0.23). Drawn white + screen -> lit strokes are 50% white, with a 36% darker edge on the right/bottom of each stroke (a subtle drop-bevel). Redraw: stroke fill `rgba(255,255,255,.5)` with a 1-unit `rgba(255,255,255,.36)` rim on the right and bottom.
* Digit 1: cols 15..21 only (the right vertical pair), i.e. right-aligned in the cell.
* Minus: rows 80..85 of the atlas = a single mitred bar 15 texels wide (cols 2..17), 6 tall, at glyph mid-height (rows 16..21 of the 64 cell).
* Shape per digit: the standard 7-segment set (0 = a b c d e f, 1 = b c, 2 = a b g e d, 3 = a b g c d, 4 = f g b c, 5 = a f g c d, 6 = a f g e d c, 7 = a b c, 8 = all, 9 = a b c d f g -- verified 0/1/8, the rest by the row image).

### 3.2 DrawDigit / DrawBigNum kerning (the real pitch is 28 S, and "1" only moves itself)
```
Step = 16 * UpScale
per digit:  CurX -= (d == 1 ? 0.625 : 0.25) * Step      // -10S or -4S
            DrawTile 25S x 64S  (Canvas advances CurX by 25S)
            CurX += 7 * UpScale                          // +7S
```
Advance from one tile's left edge to the next = `25 - 4 + 7 = 28 S` (a following "1" starts 6 S
earlier, at `22 S`, but it still leaves CurX at the same place so the pitch after it is 28 S again).
Field start (relative to the DrawBigNum origin X):
* 1 digit: `+16 +16 -4 = +28 S` (tile 28..53)
* 2 digits: `+16 -4 = +12 S` (12..37, 40..65)
* 3 digits: `-4 S` (-4..21, 24..49, 52..77)
* 4 digits: `-20 S`
So the number is neither left- nor right-aligned: each extra digit moves the start 16 S left and the end 12 S right. Health "100" spans origin-4S..+77S = W-268S..W-187S (1518..1639 @1920), inside a tile that ends at W-140S; the cross glyph occupies the tile's right 30%.
A leading "1" tile starts at `start - 6 S`; since its strokes are at cols 15..21 the visible ink still lands 6 S left of where a "0" would begin, so "100" reads slightly tighter.
CSS translation: `.digit { width: 1.953vw (25S); height: 5vw (64S) }` with a glyph box of 1.72vw x 2.8125vw at the top; `margin-left: -0.3125vw` for non-1 digits, `-0.78125vw` for "1", `margin-right: 0.547vw`; a flex row whose left edge is `origin + 1.25vw * (3 - ndigits)` (Step per missing digit) -- i.e. pad the field with `1.25vw` per absent leading digit, and put `1.25vw` extra before a 1-digit number (the code adds Step twice).

--------------------------------------------------------------------------------
## 4. Glyphs and tiles -- measurable descriptions for SVG redraw
All four status tiles share one 128x64 box (4.1); the glyph sits inside. Coordinates are
texels in the 128x64 tile; multiply by `S` (0.078125 vw) for screen size.

### 4.1 The box (background of skull / cross / shield / bullets tiles)
* Outer border: 3 texels all round, lum 124 (0.49).
* Fill: lum 66 (0.26).
* Grid: 2-texel lines at lum 84 (0.33), **pitch 17 texels**, at x = 12-13, 29-30, 46-47, 63-64, 80-81, 97-98, 114-115 and y = 14-15, 31-32, 48-49 (measured on row 131 / col 100). So 7 vertical and 3 horizontal lines, cells 17 texels = 1.33 vw.
* No gradient, no bevel, square corners.
CSS: `background: rgba(hue, .26)`; `box-shadow: inset 0 0 0 0.234vw rgba(hue,.49)`;
grid `repeating-linear-gradient(90deg, rgba(hue,.33) 0 0.156vw, transparent 0.156vw 1.328vw)` offset by 12 texels (0.9375vw), same vertically offset 14 texels -- all under `mix-blend-mode: screen`.

### 4.2 Skull (tile 0,128) -- LEFT side of the box, cols 8..40, rows 133..184 (of 128..191)
* Front-facing skull, bbox ~33 wide x 52 tall (26% x 81% of the tile), centred on x = 24, i.e. its left edge sits 8 texels in, leaving cols 40..127 for the digits.
* Cranium: dome from row 5 to row 26, widest 30 texels at row 14-18, lum 110-150 (0.43-0.59) body with 200+ (0.8-1.0) highlights on the brow ridge (rows 17-22, two bright patches over the sockets) and forehead top-right.
* Eye sockets: two dark cavities rows 20..30, each ~10 wide, inner edge 4 texels from the centre line; they read as the box fill (lum 66) showing through -- draw as holes.
* Nasal cavity: inverted V rows 29..33, 4 wide, dark.
* Cheekbones: bright blocks rows 33..37 either side (lum 200+), 8 wide.
* Teeth: rows 38..46 an arc of 8 upper teeth, alternating lum 120/200; lower jaw rows 47..56 narrower (14 wide) with 6 teeth, brightest at the bottom row 56 (lum 200+, 8 wide) -- the jaw is separated from the upper row by a 1-texel dark gap at row 46.
* Silhouette edge: 1-texel lum 84-93 outline all round.

### 4.3 Health cross (tile 128,128) -- RIGHT side, cols 90..118, rows 136..181 (of 128..191)
* A fat plus, bbox 29 wide x 46 tall (23% x 72% of the tile), NOT square: arms 13 texels thick (0.45 of width), the vertical bar runs rows 136..181, the horizontal bar rows 152..162 (11 tall) from col 90 to col 118; centre at (104, 158). So the vertical stem is 3.5x taller than the horizontal arm is wide-to-tall.
* 3-D: it is an isometric slab with a **light top-left and a dark right/bottom**. Top face of the vertical bar (rows 136..139) lum 200-255; front faces lum 150-200 (0.6-0.8); the right side faces lum 100-150; there is a 1-texel highlight column at x = 111 running the whole height (lum 255) and a bright cap on the right arm (rows 152..156, cols 105..118, lum 200-255). The horizontal arm's bottom edge (rows 163..167) fades 150 -> 110 -> 66 in three steps (a soft shadow).
* Redraw: plus polygon `M96 0h13v16h16v11H109v19H96V27H80V16h16z` (in a 29x46 box scaled), fill hue at .7, a top-left face at .9 (2-3 texel bands along the top and left edges of each arm), right/bottom faces at .45 (3-4 texel bands), a 1-texel .95 highlight line 2/3 across the stem.

### 4.4 Armour shield (tile 0,192) -- centred-right, cols 84..123, rows 196..250 (of 192..255)
* Heraldic shield, bbox 40 wide x 55 tall (31% x 86%), flat-topped with a small peak: top edge rows 196..201 rises to a point at x = 103; sides straight down to row ~232 then curve to a point at (103, 250).
* Outline: 2-texel lum 110-150 rim; interior lum 66-110 (so it is mostly the box fill showing -- a dark shield with a light edge).
* Two vertical bright bosses / ridges inside: left ridge cols 92..99, right ridge cols 106..114, rows 201..228, lum 200-255 (0.8-1.0) with lum 150 shading -- these read as two tall pale bars, like a "II"; between them a narrow dark channel (cols 100..105, lum 66-84).
* Lower third (rows 229..250): darker (lum 84-110) with a lighter chevron at rows 240..247, cols 88..118 (lum 150-200), forming the shield's bottom point.
* Redraw: outer path `M84 197 H103 L106 196 L123 197 V232 Q123 245 103 250 Q84 245 84 232 Z` stroke hue .5, 2 units; fill hue .3; two rounded-end bars 8x28 at x=92 and x=106, y=201, fill hue .9; chevron at the bottom hue .65.

### 4.5 Ammo bullets (tile 128,192) -- RIGHT side, cols 88..126, rows 198..249
* Two identical upright cartridges side by side, each 17 texels wide, at x = 88..105 and x = 108..126 (3-texel gap), pointing UP.
* Each: bullet tip rows 198..205 (a pointed ogive 7 wide -> 1 wide), neck rows 206..217 (9 wide), case rows 218..247 (13 wide, straight), rim/base rows 248..249 (17 wide, 2 tall, brightest lum 200+).
* Shading: a **1-texel highlight column at lum 255 at the left third** (x = 89 / 109) plus the right 3-4 columns at lum 200-255 (the case highlight), body lum 110-150, a lum 84 groove between neck and case.
* Redraw per cartridge (17x52 box): `M8 0 L13 7 V19 H15 V50 H2 V19 H4 V7 Z` fill hue .55, base rect 0..17 x 50..52 hue .9, highlight line x=1..2 full height hue .95, right band x=13..16 y=19..50 hue .8.

### 4.6 Weapon bar cell (HUDWeapons 64x32 cells, drawn 2x)
* 1-texel border lum 41-59 (0.2) all round, fill lum 21 (0.08), a 2-texel grid at lum 26-31 pitch ~8 texels; inside, a thin outline (lum 41-59, 1 texel) of the group's weapon silhouette occupying roughly cols 12..60, rows 1..17, and a small "v" caret (rows 26..28, cols 50..56) below it. At `0.5*HUDColor` these cells are ~4-10% of the HUD colour: barely there. Group order (slot -> cell): 1..4 = row 0, 5..8 = row 1, 9..10 = row 2 cols 0..1. Slot 2 (Enforcer) cell = (64,0).
* The held weapon's `UseAutoM` (128x64): border lum 122-125 (0.48, 2 texels) around a lum 67 (0.26) grid box, black (lum 1) Enforcer silhouette pointing right, occupying cols 30..110, rows 8..48, with a lum 83-96 highlight along its top edge. Drawn OPAQUE in SolidHUDColor -> a solid (0,33,66)-ish box with a (0,61,122) border and a **black** pistol.

### 4.7 Selection bracket (HUDWeapons 128,64,128,64) -- four gold corners, drawn at slot size
* Line thickness 3 texels (2.3% of width) -> 2.4 S = 0.19 vw.
* Horizontal arms 12 texels (9.4% of width = 9.6 S = 0.75 vw) along rows 0..2 and 61..63.
* Vertical arms 14 texels (21.9% of height = 11.2 S = 0.875 vw) along cols 0..2 and 125..127.
* Luminance 110-150 (~127 = 0.5) -> gold at half strength (128,128,0), translucent. Nothing else in the tile.

### 4.8 CTF flag icons (I_Home / I_Capt / I_Down, 32x32, drawn at 64 S = 5 vw)
Common: pole = cols 1..2, rows 3..31, lum 61 (0.24) with a lum 99 cap at row 3; cloth outline lum 128 (0.5) rectangle cols 1..30 x rows 6..24 (30x19), 1 texel thick, with a 3-texel thick left post (cols 1..3, rows 6..24) and a 3-texel-tall notch (rows 9..21, col 7 vertical line) forming an inner panel cols 8..29 x rows 10..20; the top and bottom bands rows 7..8 / 22..23 are cloth.
* I_Home: cloth filled lum 99 (0.39) -> flag at 39% of team colour, the frame at 50%.
* I_Capt: cloth lum 61 (0.24, nearly invisible) with a light (lum 128) exclamation figure: block cols 15..20 x rows 9..17 (with 1-texel lum 78 shoulders at rows 15..17), gap row 18..19, dot cols 16..19 x rows 20..22.
* I_Down: cloth lum 61 with a lum 128 down-arrow: shaft cols 16..20 x rows 10..13, head a triangle from cols 11..25 at row 14 narrowing to col 18 at row 21.
Screen size: 32 texels = 64 S, so 1 texel = 2 S = 0.156 vw. Team colour (255,0,0) / (0,128,255), translucent.

### 4.9 Status doll (Icons.Man 128x256, left half) and belt
* Figure bbox x 8..104, y 8..197 of the 128x256 tile: 96 wide x 190 tall. Frontal heroic-armour soldier, arms akimbo-ish (elbows out, hands on hips at rows ~96..128), legs apart, boots at rows 176..197.
* Fill lum 90 (0.35); a **4x4-texel-pitch grid** of lum 138 (0.54) lines drawn over the whole fill (the "wireframe" look); outline lum 255 (1.0), 2 texels; panel lines (pauldron edges, chest plate, belt, knee/boot edges) also lum 255.
* Head rows 8..30 (helmet 20 wide, a 2-texel visor gap at rows 19-21), pauldrons rows 28..46 spanning cols 18..90 (widest point), torso rows 32..96 tapering from 60 to 34 wide, belt rows 96..104, thighs rows 104..148, shins rows 148..180, boots rows 180..197 flaring to 20 wide each.
* Armour overlays at (128,0)/(128,64)/(128,128): the chest plate (rows 30..64, cols 16..80 of the sub-tile: a breastplate with pauldron caps), thigh plates (rows 94..126, two 9x32 pads), shin/boot plates (rows 146..190). Fill lum 150-200 (0.6-0.8), outline 255. Redraw as the same silhouettes at fill .7.
* ManBelt (128x256): a 2-texel white (255) outline of the whole figure, nothing inside -> drawn yellow with a belt.

--------------------------------------------------------------------------------
## 5. Gap list -- current build vs source (file:line -> corrected value)

Scale / units
1. `styles.css:1320-1333` `--ut-u` steps at integer `round(W/640)` -> source is continuous `S = W/1280` with everything in `0.078125vw`. Replace the media-query ladder with `--ut-s: 0.078125vw` (bar section already does `--ut99-px: 0.15625vw` for a 640 base; keep ONE unit = S).
2. `styles.css:1671-1690` bar height `4.375vw` (28 base) -> corner boxes are 64S = **5vw** tall at `bottom:-0.039vw`; slots are 51.2S = **4vw** tall at `bottom: -0.03vw` (`H - 50.8S` with a 51.2S tile).

Colour
3. `styles.css:1349-1365` `--ut-rgb: 0,0,255` for blue and `255,0,0` red, and `1697-1706` -> blue team is **0,128,255** (x0.9375 = 0,120,239); red 239,0,0; only the no-team DM default is 0,0,254. Alpha model: fill .26, grid .33, border .49 (not .30/.16/.60) and the border is 3 texels = **0.234vw** wide (not 1 base px), grid pitch 17 texels = **1.328vw** (not 4 base), grid lines 2 texels = 0.156vw.
4. `styles.css:1359-1360` `--ut-seg-on: rgba(255,255,255,.78)`, `--ut-seg-off: .06` -> lit stroke = white at **.50** with a .36 rim on right/bottom, and **no unlit strokes at all** (`.ut-seg i { display:none }` unless `.is-on`; delete `--ut-seg-off`). Prefer `mix-blend-mode: screen` on the whole HUD layer.
5. `styles.css:1938-2000` flag rows use ad-hoc colours (#2a6fd0, #0060c0, #c82828) -> TeamColor (0,128,255)/(255,0,0) at .5 for digits and icon frame, .39 for the cloth (I_Home), translucent.
6. `hud-root.js:525-535` + `styles.css:1476-1481` blink below 25 by switching strokes off -> threshold is **< 50**; digits dim to 50% and recover in a 2 Hz sawtooth (never off), and the CROSS turns white and ramps 100% -> 25% at the same 2 Hz. Cross stays HUD-colour above 50.
7. `styles.css:1613-1615` armour 0 at `opacity:.55` -> source draws "0" in full white; remove.
8. `styles.css:596-635` + `first-person-weapon.js:99-123, 645-656` crosshair: white 11x2 ticks with black outline, hue pip, bloom -> **green (0,240,0)** plus with 3-texel gap, no outline/glow/bloom, size `64 * max(1, int(0.1 + W/640))` px square (integer nearest-neighbour), only a 0.4 s 2x pulse on pickup.

Layout: top right
9. `styles.css:1497-1512` vitals bay `top:13u; right:17u`, 64x51 panel with one border and internal rules -> two flush 128Sx64S tiles at `right:10.9375vw`, `top:0` and `top:5vw`, each `10vw x 5vw` with its own 0.234vw border; no divider rule, no 41/23 split -- the glyph is part of the tile art at the tile's right 30%.
10. `styles.css:1592-1594` digits `17.3u` tall -> glyph 36S = **2.8125vw** tall, 22S = 1.72vw wide, cell 25S x 64S with the glyph at the top; origin `(tile.left + 4S, tile.top + 16S)`; pitch **28S = 2.1875vw** with the Step/1 rules in 3.2, not `gap:.19em` right-aligned cells.
11. `styles.css:1649-1652, 2010-2025` doll 62-74px hand-drawn, glow, recolour -> tile `right:0; top:0; 10vw x 20vw`, figure fill hue .35 with a 4-texel (0.3125vw) grid at .54 and a 1.0 outline; no glow, no health tint, no hit blink; instead red minus-dashes ON the doll at hit positions for 1 s (`SetDamage`), and a yellow outline when belted; chest plate brightens with Body Armor / 100.
12. `styles.css:1580-1609` glyph cell 23u with custom bevel SVGs -> redraw per 4.3/4.4 at the tile coordinates (cross cols 90..118 rows 8..53; shield cols 84..123 rows 4..58).

Layout: bottom
13. `styles.css:1729-1756` frag box `width:10vw` ok, skull `2.9vw` at left -> skull bbox cols 8..40 rows 5..56 of the 128x64 tile = `left:0.625vw; top:0.39vw; 2.58vw x 4.06vw`; digits origin `left:3.125vw (40S); top:1.25vw (16S)`, same 2.8125vw glyph as health, 1-digit at +28S.
14. `styles.css:1758-1770` kill flash on the frag box: gold at .9 for 520 ms -> 3 s, 4 Hz sawtooth gold->HUD tint plus a gold glow blob 20vw x 10vw centred on the box.
15. `styles.css:1783-1800` empty slot `fill .09`, owned `.3` -> BOTH empty and owned-unselected slots draw the same HUDWeapons cell at `0.5*HUDColor` (fill ~.04, border ~.1, with the ghost weapon outline); the held slot is OPAQUE SolidHUDColor with a black silhouette (`Use*` art), not `fill .42`.
16. `styles.css:1804-1820` slot number `1.35vw` top-left -> gold (128,128,0) opaque, glyph 21.6S = **1.6875vw** tall, 13S wide, at `(3.2S, 3.2S)` = `0.25vw`. Drawn for every OWNED slot, including the held one.
17. `styles.css:1841-1852` ammo bar `left/bottom .31vw, height .32vw, gold` -> at `left:0.25vw; top:3.25vw (41.6S)`, height **0.5vw (6.4S)**, max width **5.5vw (70.4S)**, an orange->yellow gradient `(255,108,0) -> (255,244,0)` left to right with a 2/8 lighter top band (255,236,0), the whole gradient squashed to the current width. `hud-root.js:550-554` uses `%` of the slot; use `% of 5.5vw`.
18. `styles.css:1854-1899` bracket clip-path (arms 11.7%/22%, 1 base thick) -> thickness 2.34% of slot width (0.19vw), horizontal arms 9.4% (0.75vw), vertical arms 21.9% (0.875vw), gold at .5, screen blend; no `fill-sel` background.
19. `styles.css:1915-1930` ammo bay `margin-left:auto; 10vw` inside the flex strip -> its own absolutely positioned tile `right:0; bottom:-0.039vw; 10vw x 5vw`, digits origin `left:0.3125vw; top:1.25vw`; bullets glyph cols 88..126 rows 6..57. `hud-root.js:56-61, 537-545, 1483-1484` reload blink: UT99 has no reload; keep or drop, but it is not a source behaviour.
20. `hud-root.js:179-197` slot 2 = Enforcer, `ACTIVE_SLOT` fixed -> fine for one weapon; when the pickups (Rocket Launcher group 9, Sniper, Shock, Ripper, Redeemer) arrive they claim slots 9/8/4/5/10 (`InventoryGroup`), and the pending-glow/opaque-held rules in 1.6 apply.

CTF
21. `styles.css:1948-1963` rows at `top:35%` / `56%` with `right:.63vw` and `gap 2.2vw` -> bottom-anchored in S: red icon `(right:5.47vw, bottom:22.34vw, 5vw square)` [H-350S..H-286S], blue icon `bottom: 34.06vw`; digits origin red `(right: 11.25vw, bottom: 26.25vw - 5vw)` i.e. glyph top at `H-336S` = `bottom:26.25vw` minus 64S cell..., blue `+11.72vw` (150S) higher. **Red is the lower row, blue the upper** (current CSS has blue at 35% = upper: correct by accident; keep).
22. `hud-root.js:136-142` flag SVG (pole left, two bands) -> 4.8 geometry, three states with different interiors (solid / "!" / down-arrow), frame at .5, cloth .39, never "blink" or "opacity .45" (`styles.css:2003-2013`).
23. `hud-root.js:489-498` listens on `document` for `ctf-score` with `detail.blue/red` and `ctf-flag` with `detail.team/state`; `network.js:377-405` emits `ctf-score` with `detail.scores.{red,blue}` and `flag-update` (not `ctf-flag`) with `state`. Scores never reach the HUD and flag state never changes. Fix: read `d.scores`, and listen for `flag-update` mapping `state` -> home/held/dropped (source names: bHome / bHeld / else).
24. Missing: the "You have the flag, return to base!" (yellow) / "The enemy has your flag, recover it!" (red) bottom-centre lines at `H - 0.0833H - 2YL` / `- 3YL`, big font, pulsing once per second.
25. Missing: frag/score box is still drawn in CTF (`bHideFrags=false`); Rank/Spread is NOT (team HUD overrides DrawGameSynopsis).

Messages / type
26. `styles.css:783-825` kill feed at `top:60px; left:18px`, condensed caps, hue names -> `left:6px; top:2px`, plain bitmap-sans at 10/14/16 px by width, red (255,0,0) death lines, green chat, white pickups, 4 lines max, 3 s life, no slide-in; a faint 13%-hue backdrop 60vw x ~6vw that fades in/out.
27. `styles.css:710-780` announcements: uppercase condensed, glow, rule, punch-in at 19%/30% -> Big/Huge plain sans, centred at `0.2552*H` (+1 line for multikill), red for multikill/first blood/head shot, (0,128,255) for kills/captures/sprees; linear fade-out over 3 s, no scale, no glow, no rule. Spree lines are third-person with the player name ("X is on a killing spree!"), not "KILLING SPREE".
28. `first-person-weapon.js:854-866` labels "DOUBLE KILL / MULTI KILL / ULTRA KILL / MONSTER KILL", spree "KILLING SPREE / RAMPAGE / DOMINATING / UNSTOPPABLE / GODLIKE" -> exact strings: "Double Kill!", "Multi Kill!", "ULTRA KILL!!", "M O N S T E R  K I L L !!!"; "<name> is on a killing spree!", "... is on a rampage!", "... is dominating!", "... is unstoppable!", "... is Godlike!" at 5/10/15/20/25. Double at 2 kills, Multi 3, Ultra 4, Monster 5+.
29. `hud-root.js:53-54, 212-228` + `styles.css:87-89` Saira Condensed via Google Fonts -> UT uses LadderFonts bitmap sans; use a plain system sans (Arial/Helvetica/Tahoma) at the FontInfo sizes, no tracking, no uppercase transform.
30. `styles.css:509-525` + `hud-root.js:658-673` damage vignette + doll blink -> source: red dashes on the doll (1.1); no screen wash at all in ChallengeHUD (the red flash is the engine's `PlayerPawn.ClientFlash`, a full-screen additive fog, not HUD -- keep a brief full-screen red tint if wanted, not an edge vignette).
31. `styles.css:198-230, 1369-1381` `.ut-panel` gradient/edge tokens still `--ut-edge-top` etc. -> everything is the 4.1 tile; delete the plate/edge/glow token family.

--------------------------------------------------------------------------------
## 6. Announcer (Announcer.uax, 38 lines) -- which words exist and what triggers them

Multi-kill (`MultiKillMessage.ClientReceive`, switch = kills in the streak - 1):
| kills | switch | text | sound |
|---|---|---|---|
| 2 | 1 | Double Kill! | `doublekill` |
| 3 | 2 | Multi Kill! | `multikill` |
| 4 | 3 | ULTRA KILL!! | `ultrakill` |
| 5..10 | 4..9 | M O N S T E R  K I L L !!! | `monsterkill` |
`triplekill` exists as a WAV and "Triple Kill!" as a string but stock UT99 never plays/shows them. The multikill window is in TournamentPlayer (not extracted; commonly cited 3 s -- UNVERIFIED, the build's 3000 ms is consistent).

Spree (`DeathMatchPlus.NotifySpree`, only at exactly 5/10/15/20/25 kills without dying):
| kills | text | sound |
|---|---|---|
| 5 | <name> is on a killing spree! | `killingspree` |
| 10 | <name> is on a rampage! | `rampage` |
| 15 | <name> is dominating! | `dominating` |
| 20 | <name> is unstoppable! | `unstoppable` |
| 25 | <name> is Godlike! | `godlike` |
Ending a spree (victim had Spree > 4): "<killer>'s killing spree was ended by <victim>" / "<name> was looking good till he killed himself!" (female variant "she ... herself"), no announcer line. Others hear a generic `SpreeSound` (not announcer).

CTF (`CTFGame` / `CTFFlag` BroadcastLocalizedMessage `CTFMessage`, centre, (0,128,255), Big):
| event | switch | text |
|---|---|---|
| capture | 0 | <name> captured the red flag!  The blue team scores! / ... the blue flag! The red team scores! |
| returned by player | 1 | <name> returns the red flag! / ... the blue flag! |
| dropped | 2 | <name> dropped the red/blue flag! |
| auto-returned (timeout) / was returned | 3, 5 | The red flag was returned! / The blue flag was returned! |
| picked up (from base or stray) | 4, 6 | <name> has the red/blue flag! |
Sounds actually played by CTFGame: on capture, teammates hear `CaptureSound[team]` = BotPack `CaptureSound2`/`CaptureSound3` (ctf9/ctf10 wav); on return `ReturnSound` (returnf1). The Announcer words that exist for CTF are `capture`, `assist`, `nicecatch`, `failed` -- none is referenced in the extracted CTFGame/CTFFlag/CTFMessage source (they belong to the voice-pack/TournamentPlayer paths, UNVERIFIED), so for a text announcer use the CTFMessage strings above and, if a spoken cue is wanted, "Capture!" / "Assist!" / "Nice catch!" / "Failed!".

Match / other: `firstblood` ("<name> drew first blood!", red), `headshot` ("Head Shot!!", red, DecapitationMessage), `takenlead`, `lostlead`, `lastplace`, `winner`, `lostmatch`, `prepare`, `proceed`; countdown `cd1`..`cd10`, `cd30sec` ("30 seconds left!"), `cd1min`, `cd3min`, `cd5min` ("5/3/1 minutes left in the game!", then "10 seconds left!", "9..." ... "5 seconds and counting...", ..., "1...") via TimeMessage at 0.2552H.

--------------------------------------------------------------------------------
## 7. Quick CSS constant sheet (S = 0.078125vw)
```
--s: 0.078125vw;
box:            width 10vw; height 5vw; border 0.234vw @ hue .49; fill hue .26; grid 2px/17px -> 0.156vw / 1.328vw @ .33
armour tile:    right 10.9375vw; top 0
health tile:    right 10.9375vw; top 5vw
doll tile:      right 0; top 0; width 10vw; height 20vw
ammo tile:      right 0; bottom -0.039vw
frag tile:      left 0;  bottom -0.039vw
slot i:         left calc(10vw + (i-1)*8vw); bottom -0.03vw; width 8vw; height 4vw
slot number:    left +0.25vw; top +0.25vw; glyph 1.6875vw tall
slot ammo bar:  left +0.25vw; top +3.25vw; height 0.5vw; max-width 5.5vw
bracket:        0.19vw thick; arms 0.75vw (h) / 0.875vw (v)
digit cell:     1.953vw x 5vw, glyph 1.72vw x 2.8125vw at top; pitch 2.1875vw; '1' shifts -0.469vw
digit origin:   tile +0.3125vw, +1.25vw (health/armour/ammo); frag +3.125vw, +1.25vw
field start:    +2.1875vw (1 digit) / +0.9375vw (2) / -0.3125vw (3)
CTF red icon:   right 5.47vw; bottom 22.34vw; 5vw square       (H-350S .. H-286S)
CTF blue icon:  right 5.47vw; bottom 34.06vw
CTF red digits: origin right 11.25vw, glyph top at bottom 26.25vw (H-336S); blue +11.72vw
crosshair:      64 * max(1, floor(0.1 + W/640)) px square, green (0,240,0), no smoothing
messages:       left 6px; top 2px; font 10/14/16 px by width; centre msgs at 25.52% H
```
