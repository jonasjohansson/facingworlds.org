# Extracting the UT99 characters

The eight playable Unreal Tournament characters, out of the retail packages and into
`assets/3d/characters/` as glTF with `Idle`/`Walk`/`Run` animations.

The mesh extractor **is** in this repo now, at `scripts/build-ut-characters.mjs`. It used
to be throwaway tooling that ran once, and that cost a year: nobody could re-derive what
it had done, so a mistake baked into the geometry survived every check there was. See
[The 2026 rebuild](#the-2026-rebuild-six-of-eight-bodies-ran-backwards) at the end —
which is the section to read first if you are here about orientation, because the rule in
point 2 below is the mistake, kept for the record.

The rest of this file is the part that was always worth keeping: **what the format
actually does**, because almost none of it is guessable and every wrong guess renders as
something that looks nearly right.

The **package reader is** in the repo, at `scripts/lib/upkg.mjs`, because throwing it away
turned out to be a mistake: it was needed again for the projectile numbers and had to be
rebuilt from nothing. It reads the header, name, import and export tables, a class's
default properties, and the UnrealScript source UT99 ships inside each package. See
[the class defaults section](#reading-a-classs-default-properties) below.

## Where the characters live

| model | mesh | package | declared in |
|---|---|---|---|
| Male Commando | `Commando` | `System/BotPack.u` | `Botpack.int` |
| Male Soldier | `Soldier` | `System/BotPack.u` | `Botpack.int` |
| Female Commando | `FCommando` | `System/BotPack.u` | `Botpack.int` |
| Female Soldier | `SGirl` | `System/BotPack.u` | `Botpack.int` |
| Boss (Xan) | `Boss` | `System/BotPack.u` | `Botpack.int` |
| Skaarj Hybrid | `TSkM` | `System/epiccustommodels.u` | `multimesh.int` |
| Nali | `tnalimesh` | `System/epiccustommodels.u` | `multimesh.int` |
| Nali WarCow | `TCowMesh` | `System/epiccustommodels.u` | `multimesh.int` |

Skins are separate `Textures/*.utx` packages, palettized (P8 + a 256-entry palette).

## The four things that are not guessable

**1. Special vertices.** Every animation frame begins with 3 vertices that are not
geometry — UT anchors the weapon to them — and a wedge's vertex index counts from
AFTER them. `frameVerts` is 309 for the Soldier while the mesh has 306 points. Get
this wrong and the model renders as a shredded fan of triangles while every other
check passes: the bit layout, frame-major storage, and 99% manifold topology were all
correct the whole time it looked broken. `umodel` prints the count in its load log
(`spec faces: 1  verts: 3`); it can also be derived as `frameVerts - (maxWedgeVert+1)`.

**2. Orientation is per-mesh.** Six models carry `RotOrigin [0, 90deg, -90deg]` and
are authored with height on axis 1; the two bonus-pack models carry `[0,0,0]` and are
authored standing, on UE1's own Z-up. There is no single up axis.

> ⚠️ **What used to follow here was wrong, and is left in place because it is the bug.**
> "Modelling the rotator is a trap — applying it forwards stands the bonus models up and
> puts the other six on their heads, applying its inverse lays them on their side — so
> read the axis off `RotOrigin` and assert it matches the tallest axis of the idle pose."
>
> That rule fixes **up** and nothing else, which is why it looked right: every body stood
> at the correct height, and every body was free to be turned any way at all about that
> axis. Six of them ended up facing exactly backwards. The rotator is not a trap; it needs
> its **transpose**. See [The 2026 rebuild](#the-2026-rebuild-six-of-eight-bodies-ran-backwards).

**3. The name table has duplicates.** `BotPack.u` holds `"None"` at index 0 *and*
7454, and the meshes terminate their property list with the later one. Compare the
name, never the index.

**4. Palettes are RGBA.** Swapping R and B turns every UT99 character into a Smurf.

## Slot counts vary

A skin is a family's body parts plus one named face: `Gard1`, `Gard2`, `Gard3`,
`Gard4Wraith`. But `FCommando` has no part 3 and only three material slots, the Nali
has two, Xan has five. Fit the skin set to the mesh's slot count rather than assuming
four — assuming four silently gave FCommando no skins at all.

Team variants (`T_0` red, `T_1` blue, plus green and gold) exist for body parts 1 and 2
but not for faces. They are not used here; the game reads teams from the HUD and map.

## umodel on Apple Silicon

`umodel` (UE Viewer) is the reference implementation and worth having as ground truth —
its export let us prove the special-vertex offset by matching 504 of 504 wedges. It has
no macOS support at all (no `__APPLE__` anywhere) but builds natively on arm64 with:

- teach `libs/nvtt/nvcore/poshlib/posh.h` about `__aarch64__`, **including that it is
  little-endian** — it defaults unknown CPUs to big-endian, which loses `POSH_SwapU32`
- `sse2neon.h` shimmed in as `xmmintrin.h`/`emmintrin.h` for the 12 SSE intrinsics
- shim `GL/gl.h` to `<OpenGL/gl.h>`, and define `APIENTRY`, `GLAPI`, `APIENTRYP`
  (Apple does not) plus the BPTC/RGTC constants Apple's 4.1 headers lack
- `-Dstat64=stat -Dfopen64=fopen -Dfseeko64=fseeko -Dftello64=ftello`
- Apple clang reports `__GNUC__` 4.2, so `Core/Core.h`'s `staticAssert` falls into a
  pre-C++11 branch that pastes a string into an identifier — add `defined(__clang__)`
- zlib is K&R C: compile with the `clang` driver (language by extension), not `clang++`,
  and strip `-std=c++0x` from the C rules
- `operator new(size_t) throw()` is a C++11 mismatch in `libs/nvtt/nvcore/Memory.h`
- link `-framework OpenGL -framework Cocoa`, not `-lGL`

## Regenerating the roster

The assets are committed; the roster that indexes them is generated:

    node scripts/build-ut-characters.mjs   # re-extract the glTFs (needs a retail install)
    npm run gen:characters                 # rewrite src/shared/characters.js + server/characters.js
    npm run gen:characters:check           # fail if out of date

The extractor is dev tooling and is not part of any build: the glTFs it writes are
committed, and only the roster that indexes them is regenerated routinely. See
[The 2026 rebuild](#the-2026-rebuild-six-of-eight-bodies-ran-backwards).

## Licensing

These are Epic's assets, from a retail install. Shipping them is a deliberate choice
for this fan project, taken knowingly — see also the note in README.md.


## Reading a class's default properties

`scripts/lib/upkg.mjs` answers "what does UT99 say this class's numbers are", which is
where every projectile figure in `scripts/data/ut-projectiles.json` comes from. Two
things about it are not guessable either.

**The script cannot be skipped by its length.** `UStruct` writes a `ScriptSize`, but that
is how much room the bytecode takes *in memory*; on disk UE1 serializes it token by token
and the two differ. Skipping `ScriptSize` bytes works perfectly for a class whose script
is all in child functions (`ripper`, `RocketMk2` — `ScriptSize` 0) and lands mid-bytecode
for one with any class-level script (`UT_Eightball` — 22), where the parse reads garbage
and reports a class with **no defaults at all** rather than failing.

**Finding the properties by scanning is not enough.** They are last in the export and end
at the name `None`, so a scan for "a property list that ends exactly on the export
boundary" looks like the answer. It is not: a start a few bytes inside the bytecode can
resynchronise onto the real list part-way through and end in the same place. `RocketMk2`
has one that is *both earlier and longer* than the truth — it gains `ProcessTouch`, `Core`
and `Palette` and loses `speed` — so neither "first match" nor "longest match" picks
correctly, and both fail silently.

What works is structure. Between the bytecode and the properties sits a fixed UClass
tail: `UState`'s two masks, a label offset and state flags, then `ClassFlags`, a 16-byte
GUID, the dependency and package-import lists, `ClassWithin` and `ClassConfigName`. So
guess where the *script* ends rather than where the properties start, parse that tail, and
see where it delivers you. Only a real script end produces a tail that parses and hands
over a property list terminating exactly on the boundary.

**The source is in the package.** Each class carries a `TextBuffer` child named
`ScriptText` holding its `.uc` text, so numbers that live in code rather than in defaults
can be read instead of disassembled — `HurtRadius(Damage, 220.0, ...)` is how the rocket's
blast radius was obtained. Mind *which* call: `WarShell` has one radius in `Explode()` for
hitting something (300) and a larger one in `TakeDamage()` for being shot out of the air
(350).


## View weapons

The six first-person weapons — `assets/3d/viewmodels/<id>/` — come out of the same
packages by the same route, built by `scripts/build-ut-viewmodels.mjs`. They are not
characters, but almost everything that was hard about them is the same shape of problem,
and two of the answers are worth writing down because they were each got wrong first.

### Frame 0 is not the resting pose

Every one of these meshes begins with its `Select` sequence, which is the weapon swinging
up into view from off screen. So frame 0 is a gun caught mid-swing: tilted, displaced,
and measuring nothing you would want to measure.

| mesh | frame 0 extent (mesh units) | `Still` frame | rest extent |
|---|---|---|---|
| `Rifle2m` | x 7.51, y 2.19, z 1.78 | 17 | x 1.71, y 4.21, z 1.76 |

The long axis is not even the same one. Every derived number — which way the barrel
points, where the muzzle is, how big the weapon is — has to come from the first frame of
the mesh's own `Still` sequence (`Idle` where there is none), and the first version of
this extraction took all of them off frame 0. Nothing threw; the weapons simply pointed
at the player's face and the manifest was full of confident numbers about it.

### RotOrigin is the rule, applied as the inverse

A mesh's `RotOrigin` is an `FRotator` saying how the mesh's own frame sits inside the
actor's. UE1 turns it into a matrix whose **rows** are the rotated frame's axes expressed
in the parent frame (`FRotationMatrix`, unchanged through UE2 and UE3):

```
[  cp*cy               cp*sy              sp     ]
[  sr*sp*cy - cr*sy    sr*sp*sy + cr*cy  -sr*cp  ]
[ -(cr*sp*cy + sr*sy)  cy*sr - cr*sp*sy   cr*cp  ]
```

Vertices are stored in the *mesh* frame, so getting them into the actor frame is that
matrix **transposed** — `M^T v`, not `M v`. Five of the six meshes are yaw-only and
cannot tell the two apart; `WarHead` is the one with a pitch and a roll (22.5, 90,
-87.1875) and under `M` it renders upside down with its launch tube behind the player's
head.

Three independent measurements settle it, and all three are computed from the animation
the mesh already carries rather than by eye:

| check | what it says | result under `M^T` |
|---|---|---|
| a fired gun recoils | centroid at the peak of the fire sequence, against `Still` | all six move along **-X** (-0.45, -0.69, -0.90, -0.73, -0.88, -0.30), sideways under 0.2 |
| a holstered gun drops | last frame of `Down`, against `Still` | all six move along **-Z** (-2.20, -2.24, -0.99, -0.78, -1.11, -2.64) |
| a held gun is long | rest-pose extent | all six longest along **X** |

Under `M` the first two come out with the wrong sign. `build-ut-viewmodels.mjs` refuses
to write a mesh that fails the third.

The orientation is then **baked into the geometry**: everything is emitted in a view frame
with the barrel along -Z, up +Y and screen-right +X, so the client applies no rotation at
all and `rotationDeg` in the manifest is `[0, 0, 0]`. The UT-to-view swap has determinant
-1 (UE1 is left-handed, glTF is not), which reverses triangle winding; rather than reason
about that, the extractor builds both windings, measures the signed volume each encloses,
and keeps the positive one — then asserts the answer agrees with the determinant.

### Animation

UT99 weapons are vertex-animated like the characters, so the same glTF shape works: one
morph target per frame, one animation per clip stepping a one-hot weight vector. Three
differences from `gen-characters.mjs`:

* **LINEAR, not STEP.** UE1 interpolates between frames, and a linear ramp between
  adjacent one-hot vectors reproduces that exactly. A 10-frame recoil stepped at 15 fps
  judders.
* **The base pose is `Still`**, and no morph target is emitted for it — its delta is zero
  and an all-zero weight vector already means "at rest". Clips that reference that frame
  get a sampler output of zeros, which is right rather than degenerate.
* **The rate in the manifest is a multiplier, not an fps.** A sequence carries its own
  authored rate (`AnimSeq.Rate`) and that is what the keyframe times use; what
  `PlayAnim`/`LoopAnim` pass as their second argument multiplies it. Duration is
  `numFrames / (fps * rate)`. Fold the multiplier into the keyframes and the Enforcer's
  idle sway runs five times too fast the moment the clip is reused.

Which clip each weapon plays comes from the `.uc` source in the package, not from a list
anyone typed — `PlayFiring`, `PlayIdleAnim`, `TournamentWeapon.PlaySelect` and
`TweenDown`. The Sniper Rifle's five fire animations are its `FireAnims` default array;
the Rocket Launcher's is `FireAnim[0]`. One number in the whole manifest is a choice and
is labelled as one: the Redeemer's idle rate, because `TournamentWeapon.PlayIdleAnim` is
an empty function and `WarheadLauncher` does not override it, so UT99 plays no idle on the
Redeemer at all.

### Firing feel

The rest of what a shot does to the screen is read the same way, walking the superclass
chain across packages because UE1 only serializes what a class overrides:

* `ShakeView(ShakeTime, ShakeMag, ShakeVert)` — the Shock Rifle sets none of the three and
  takes Engine.Weapon's 0.1 / 300 / 5. Read only Botpack and it does not shake at all.
* `ClientInstantFlash(InstFlash, InstFog)` — a full-screen tint, drawn only when
  `InstFlash != 0`, with the fog through `PlayerPawn`'s `InstantFog = 0.001 * fog`. The
  Rocket Launcher has no default: its flash is written into `PlayRFiring` as
  `ClientInstantFlash(-0.4, vect(650, 450, 190))` and is read out of the class source.
* The muzzle flash is a **2D canvas icon**, not geometry: `Engine.Weapon.RenderOverlays`
  draws `MFTexture` at `FlashS * MuzzleScale * ClipX/640` pixels for `FlashLength`
  seconds at `Canvas.Style` 3 (translucent — brightness is opacity, so black is
  transparent and it should be blended additively). Only the Enforcer and the Sniper Rifle
  have an `MFTexture`; the other four draw nothing.

### Two Enforcers

`enforcer.SetHand` picks between two mirrored meshes, `AutoML` and `AutoMR`, and its
`RenderOverlays` forces `PlayerOwner.Handedness = 1` for a lone Enforcer — so a single
Enforcer is always the **left** one, and a dual pair needs both. Both are extracted, into
`enforcer.gltf` and `enforcer-right.gltf`, sharing one set of skins.

Every weapon's `PlayerViewOffset.Y` is negative, i.e. authored left of centre, and
`Engine.Weapon.SetHand` multiplies that Y by `Hand` to put it on the other side. So the
other five are left-hand-authored guns that the engine mirrors for a right-handed player.
Nothing is mirrored during extraction; the manifest says which hand each belongs in and
the client decides.

### Palettes are found by reference, never by name

UE1 auto-names palettes `Palette<N>` **per texture group**, and the counter restarts, so
`Botpack.u` holds four unrelated objects called `Palette75` and three called `Palette87`.
`utex.mjs` used to resolve a texture's `Palette` property through the name it had already
been turned into and take the first match. Every held weapon's skin came out of the wrong
group's palette — the Enforcer's `Muz1..5` flash was the *BoltHit* group's lightning
green, the guns were posterised — and nothing threw, because a palette is a palette. The
byte-exact check against umodel could not catch it: `JuRocket1`'s `Palette681` is the
only one of its name. `readProperties()` now keeps the raw object reference beside each
name (non-enumerable `$refs`), `pkg.refExport()` turns it back into an export, and
`server/test/utex.test.mjs` decodes `Muz1` and insists it is warm.

### Checking it later

`scripts/render-viewmodels.mjs` software-renders the **committed** glTFs — three
orthographic views per weapon, textured, with the manifest's own muzzle point marked —
and needs no retail install, because the whole failure mode here is invisible in numbers
and obvious in a picture. `--anim=Select@0.15` poses them partway through a clip, which is
how the morph data gets looked at too.


## The 2026 rebuild: six of eight bodies ran backwards

`scripts/build-ut-characters.mjs` replaced the throwaway extractor in September 2026 and
rewrote all eight `assets/3d/characters/<id>/<id>.gltf`. The skins were **not** touched.

### What was wrong

The old extractor never applied `Mesh.RotOrigin`. Point 2 above wrote that down as a rule
— read the axis off it, assert it matches the tallest axis, apply nothing — which fixes
**up** and leaves the body free to face anywhere. Measured off the committed geometry's own
`Run` clips by the planted-foot method below, in glTF space, where the rig's forward is
`-Z`:

| model | before | with the old `YAW_FIX` | after |
|---|---:|---:|---:|
| soldier | −179.6° | −179.6° | −0.9° |
| commando | −179.8° | −179.8° | −0.5° |
| fcommando | +179.6° | +179.6° | +0.2° |
| sgirl | +179.6° | +179.6° | +0.3° |
| boss | −179.6° | −179.6° | −1.1° |
| nali | +178.4° | +178.4° | +1.5° |
| skaarj | +90.0° | 0.0° | −0.0° |
| warcow | +92.0° | +2.0° | +2.0° |

Six bodies faced exactly `+Z` — backwards, at every moment, in the game. It was found by
photographing a commando bot head-on and seeing the back of his head; nothing else caught
it, because a backwards body is a valid glTF of the right height playing the right clips.

`gen-characters.mjs` carried `YAW_FIX = { skaarj: 90, warcow: 90 }`, and the middle column
is what that bought: it rescued the two models that were *not* facing backwards and did
nothing for the six that were. It had been fitted to a different measurement — the
direction the feet sit forward of the body — which reads **the stance, not the body**:
which boot is in front depends on where in the stride the sampled frame sits. The table is
empty now and every `yawDeg` is 0. The field and `modelYaw()` stay, because a future mesh
could genuinely need one; what must not come back is a fitted number standing in for a
transform that was never applied.

### The rule, which is the weapons' rule unchanged

Exactly what `scripts/build-ut-viewmodels.mjs` derived and verified three ways on the six
first-person weapon meshes:

1. mesh vertex × `Mesh.Scale`
2. × the **transpose** of UE1's `FRotationMatrix(RotOrigin)`. That matrix's *rows* are the
   rotated frame's axes expressed in the parent frame, so row *i* dotted with a mesh-frame
   vector gives its component along parent axis *i* — `Mᵀ` is what takes mesh components to
   **actor** components. This one sentence is the whole thing.
3. × `UT_TO_WORLD`: `x_world = UT y`, `y_world = UT z`, `z_world = −UT x`. Determinant −1
   (UE1 is left-handed, glTF is not), so face winding is re-derived from signed volume and
   asserted against that determinant rather than assumed.

Run on all eight pawn meshes' `RunSm` cycles this comes out Z-up in actor space with the
run direction along `+X` to within 2°, `TSkM` and `TCowMesh` included even though their
`RotOrigin` is `(0,0,0)` and there is nothing to apply. **UE1 pawns face `+X`**, so through
`UT_TO_WORLD` every character faces `−Z` with no per-model yaw at all. There is no fitted
table and no "Epic's rotation cannot be applied uniformly" caveat.

### The planted-foot method

A UT99 run cycle is a treadmill: the pawn stays at the origin and the ground is what moves,
so the foot in contact with the ground slides **backwards** through the mesh at exactly the
speed the body is going forwards. Take the bottom 6% of the standing height in the cycle's
first frame (the boots), keep the ones within 4% of the floor in the frame they are moving
out of (a foot in mid-swing is higher), sum their frame-to-frame displacement around the
cycle, negate. It never asks which boot is in front, which is the whole failure of the
heuristic it replaces.

It is used three times: to derive the rule, as a build-time self-check that refuses to
write a body more than 2° off `−Z`, and in `server/test/characters.test.mjs`, which
measures the committed geometry rather than reading any field.

### `Mesh.Origin`, and where the body stands

A pawn mesh carries a non-zero `Mesh.Origin` — `Soldier (−150, 40, 0)`, `TSkM (100, 0,
−72)` — that places it on the actor. UE1 subtracts it in **raw packed vertex units, before
`Mesh.Scale`**. That is measured, not assumed: a UT99 pawn's collision cylinder is 39 units
half-height, so its boots belong near actor `z = −39`.

| | Origin ignored | `(V − Origin) × Scale` |
|---|---:|---:|
| Soldier | −40.1 | −42.6 |
| Commando | −40.2 | −42.7 |
| FCommando | −50.3 | −43.1 |
| SGirl | −50.5 | −43.3 |
| Boss | −37.6 | −39.9 |
| TSkM | −51.5 | −43.1 |
| tnalimesh | −44.9 | −41.2 |
| TCowMesh | −43.2 | −43.2 (Origin is zero) |

Ignoring it scatters the feet over 14 units; applying it before the scale pulls all eight
into a 3.4-unit band just under the cylinder. Applying it *after* the scale
(`V × Scale − Origin`) throws the Skaarj 100 units off and is not a candidate. It fixes the
horizontal placement too: the three meshes authored at `(−150, 40, 0)` go from a feet
centroid about 10 units off the cylinder axis to within 1.4 of it.

The actor origin is the **centre** of the collision cylinder and the game's rig is the
**floor**, so the body is then lifted until the `Idle` clip's first frame touches `y = 0`
and left alone horizontally. Where Epic put a body over its own axis is information; the
old extractor re-centred on the bounding box and threw it away.

How far the planted foot then dips below `y = 0` during `Run` — the base pose is an idle
stance and a running stride reaches lower — is soldier 3.0 mm, skaarj 9.7 mm, warcow
11.5 mm, and exactly 0 for the other five.

### Height: 1.830 m is the cylinder, not the mesh

At true pawn scale (`UU_TO_M`, 0.0235 m/UU) the meshes stand 1.80 m (Soldier) to 2.07 m
(Skaarj). UT99 does not use that: every one of these pawns, cow included, walks around
inside the **same** 39-unit cylinder, and 2 × 39 × `UU_TO_M` = 1.833 m. The nameplates, the
AR figures and the hit feedback are all placed against a 1.830 m body, so each one is
scaled uniformly onto that — soldier ×1.0171, commando ×0.9319, fcommando ×0.9333, sgirl
×0.9896, boss ×0.9831, skaarj ×0.8839, nali ×1.0043, warcow ×0.9733. All within 8% of 1: a
nudge onto the shared cylinder, not a reshaping. It is the **one** number in the extractor
that is not Epic's, and it is written into each glTF's `extras.heightFit` beside the mesh's
own `extras.utHeightM` rather than hidden.

### Which six sequences, and why `Idle` is one frame

The client binds clips by name. Which UT99 sequence goes in each is read out of
`Botpack.TournamentPlayer`'s UnrealScript, which the package ships:

    PlayWalking()    LoopAnim(Weapon.Mass < 20 ? 'WalkSM' : 'WalkLG')
    PlayRunning()    LoopAnim(Weapon.Mass < 20 ? 'RunSM'  : 'RunLG')
    PlayWaiting()    ... Weapon.bPointing: TweenAnim('StillSMFR', 0.3)
    PlayFiring()     RunSM -> RunSMFR, WalkSM -> WalkSMFR, else TweenAnim('StillSMFR', 0.02)
    PlayRecoil(Rate) AnimSequence == 'StillSmFr': PlayAnim('StillSmFr', Rate, 0.02)

Everyone here spawns with the Enforcer and never puts it down, and its `Mass` is 15, so the
small-weapon variant is right everywhere and the `LG`/`FrRp` family is not shipped at all.
`PlayWeaponSwitch` confirms the pairing from the other side — it rewrites `StillSMFR` to
`StillFRRP` and back as the carried weapon crosses `Mass` 20. `StillSmFr` is the *armed*
idle; `PlayWaiting`'s other branch (`Breath1`/`Breath2`/`CockGun`) is the unarmed fidget.
The pre-2026 files used `StillFrRp` on the humans and `StillLgFr` on the Skaarj, which are
the heavy-weapon idles: right family, wrong weight.

| clip | UT99 sequence | played by |
| --- | --- | --- |
| `Idle` | `StillSmFr` frame 0 | `PlayWaiting` / `PlayFiring`, **held** |
| `Walk` | `WalkSm` | `PlayWalking` |
| `Run` | `RunSm` | `PlayRunning` |
| `Fire` | `StillSmFr`, in full | `PlayRecoil`, once per shot |
| `WalkFire` | `WalkSmFr` | `PlayFiring` while walking |
| `RunFire` | `RunSmFr` | `PlayFiring` while running |

**`TweenAnim` does not play a sequence.** It blends to that sequence's *first* frame over
its `time` argument and stops there with `AnimRate` 0. So a standing UT99 pawn holding a gun
is frame 0 of `StillSmFr`, motionless, and the frames after it are the **recoil** — the only
thing that ever plays them is `PlayRecoil`, one shot at a time.

An earlier build of `build-ut-characters.mjs` emitted `Idle` as the whole of `StillSmFr` on
a **loop**, so every standing avatar in the game twitched through a recoil forever, eight
frames a second, with nothing firing. `Idle` is now a one-keyframe clip (plus the duplicate
key every one-frame clip here gets, because a sampler with a single key has zero duration
and some importers reject it) and the recoil is `Fire`. `Idle`'s frame *is* the base frame,
so all six clips share a base pose and blending between any two of them is blending between
poses of the same body.

All eight meshes carry all six names, so there is no fallback. Three oddities are Epic's and
are passed through unchanged:

* `tnalimesh`'s `StillSmFr` is a **single frame**, so a firing Nali does not recoil.
* `TCowMesh`'s `WalkSmFr`/`RunSmFr` are the **same** sixteen frames (250–265) as its
  `WalkSm`/`RunSm`, and those two are each other at 15 and 27 fps. Four clips, one
  animation: the cow runs by walking faster and fires by not noticing.
* `TSkM`'s `WalkLg` is its `WalkSm`, which costs nothing here because no `LG` clip ships.

Per model, what comes out — frame counts and the `.bin` each ends up at:

| model | mesh | Idle | Walk | Run | Fire | WalkFire | RunFire | targets | bin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| soldier | Soldier | 1 | 15 @18 | 10 @17 | 8 @15 | 15 @18 | 10 @17 | 57 | 364K |
| commando | Commando | 1 | 15 @18 | 10 @17 | 8 @15 | 15 @18 | 10 @17 | 57 | 353K |
| fcommando | FCommando | 1 | 15 @18 | 10 @17 | 8 @15 | 15 @18 | 10 @17 | 57 | 388K |
| sgirl | SGirl | 1 | 15 @18 | 10 @17 | 8 @15 | 15 @18 | 10 @17 | 57 | 367K |
| boss | Boss | 1 | 15 @18 | 10 @17 | 8 @15 | 15 @18 | 10 @17 | 57 | 325K |
| skaarj | TSkM | 1 | 14 @18 | 10 @17 | 8 @15 | 14 @18 | 10 @17 | 55 | 488K |
| nali | tnalimesh | 1 | 20 @15 | 10 @18 | **1** @30 | 20 @15 | 10 @18 | 60 | 348K |
| warcow | TCowMesh | 1 | 16 @15 | 16 @27 | **12** @17 | 16 @15 | 16 @27 | 27 | 207K |

The three firing clips roughly doubled the morph targets and the `.bin` files with them
(the Skaarj's 707 wedges put it at 488K, the largest). The cow is the cheapest because four
of its six clips are the same sixteen frames.

Clips are emitted the way the weapons are — one morph target per unique frame, base = the
`Idle` clip's first frame with no target of its own, one-hot weights, **`LINEAR`** because
UE1 tweens between frames (the old files used `STEP`, which judders a ten-frame run cycle),
and one extra wrap keyframe on a loop. `Fire` does not wrap: it is one-shot.

### Skins are not re-extracted, and the slot mapping is checked

A pawn mesh's material textures are **empty names** — UT99 assigns them at runtime through
`MultiSkins` — so there is nothing to read out of the package and the mapping is positional:
material slot *i* is `s{i}.png`. `remote-avatar.js` depends on that (it matches
`/slot(\d+)$/` on the material name and hangs `urls[i]` on it), so before overwriting
anything the extractor re-reads the **old** glTF and refuses to write unless, for every
slot, the triangle count and the number of distinct vertices that slot touches are
identical. All eight matched exactly on the rebuild. A body that came out mis-skinned would
look like a body.

`PF_TWOSIDED` is now honoured as `doubleSided` (the Boss's visor, the Nali's eyes, one flap
of the cow). `PF_MASKED` is deliberately *not* turned into `alphaMode` — the committed
skins are palettized PNGs with neither an alpha channel nor a `tRNS` chunk, so a `MASK`
material would have nothing to cut against. Re-extracting the skins masked is a separate
job.

### Looking at it afterwards

    node scripts/build-ut-characters.mjs      # needs a retail install
    node scripts/gen-characters.mjs           # rewrite the roster
    node scripts/render-characters.mjs out.png
    node --test server/test/characters.test.mjs

`render-characters.mjs` needs no retail install: it draws the **committed** glTFs from the
side, Idle over Run, one column per model, with the rig's forward to the **right**. Every
body must run to the right. That picture is the check that would have caught this in five
seconds, and it is the reason it exists.


## Effects

Where a shot *lands*. `scripts/build-ut-effects.mjs` extracts four meshes into
`assets/3d/effects/<id>/` plus a handful of sprite sheets into `assets/3d/effects/fx/`,
writes `scripts/data/ut-effects.json`, and `scripts/gen-effects.mjs` turns that into
`src/shared/effects.js`. Same build-\*/gen-\* split as the weapons: the first needs a retail
install, the second is what the browser imports.

There is no `server/` twin, and that is on purpose. The server already tells the client
where a shot landed and what it hit; everything in the effects table is what the client
*draws* at that point, and a server importing it would be carrying sprite sizes it can
never use.

### The frame is the map's, not the view models'

A view model is emitted in a view frame because the client draws it with no rotation at
all. An impact effect is *placed and turned in the scene*, so it has to arrive in the axes
the map arrives in — `src/shared/map-transform.js`'s `uuToScene`, which is
`scene = (UT.x, UT.z, UT.y)`. So in every effect glTF **forward is +X and up is +Y**.

That is not decoration. UT99 spawns all four with `Rotator(HitNormal)` or
`rotator(fireDirection)`, so aligning model +X with that vector *is* the placement. The
swap is a single transposition, determinant −1, which is the UT-to-glTF handedness flip and
is why the winding is reversed. It is taken from the determinant rather than from a signed
volume, because `UTRingex` is a flat annulus and gives zero either way — the volume test is
kept only as a corroboration where it is decisive, and has to agree or the build stops.

`Mesh.Origin` is subtracted **before** `Mesh.Scale`, the rule the character rebuild
measured on eight pawns. Only `Shockbm` has a non-zero one, `(0, -400, 0)`, and it is a
third independent confirmation: subtracting first puts the beam segment at x = 0.1 .. 73.8
UU, starting at the actor and running *forward*, which is the only place a beam spawned at
the muzzle can be. Ignoring the origin centres it on the muzzle (−36.9 .. 36.9); adding it
puts the whole thing behind the player.

### DrawScale is already in the vertices

Each model is written at its class's own `DrawScale`, so the committed glTF is the size UT99
spawns it at. `drawScale` stays in the table because it is Epic's number and because one
instance overrides it — the Sniper Rifle sets `s.DrawScale = 2.0` on its shell case, so
`sniperDrawScale` is a multiplier on the committed model. A client that scales by
`drawScale` again gets a ring 3.3 m across at frame 0 and nothing throws.

### The shock beam is a particle system

`ShockBeam` carries `bParticles = true`, and Engine's `Actor.uc` says of that flag, in as
many words, *"Mesh is a particle system"*: UE1 draws the mesh's 40 **vertices** as
camera-facing sprites of the actor's `Texture` and never draws its triangles. So UT99's
beam segment is 40 blobs of `jenergy2`, each 0.44 × 64 = 28 UU across, strung along a
73.7 UU line. `UT_Sparks` is built the same way, which is the corroboration.

The 76 triangles are exported anyway — a textured tube is a cheap thing for a browser to
draw — but `shockBeam.particles.pointsM` carries the 40 points in model metres beside them,
so either way the client is drawing Epic's own geometry.

The beam is also a **chain, not a line**. `ShockRifle.SpawnEffect` spawns one segment at the
muzzle with `NumPuffs = VSize(DVector)/135 - 1`, and each segment's 50 ms `Timer` spawns the
next at `Location + MoveAmount`. 135 UU is the *spacing*, and a segment is only 73.7 UU
long: UT99's beam is a dotted streak, and drawing it as a solid cylinder is a different
picture.

### How long an effect lasts when it has no `LifeSpan`

`BulletImpact` has none — it destroys itself in `AnimEnd`. UE1's `PlayAnim` sets
`AnimRate = Rate * Seq->Rate / Seq->NumFrames` with `AnimFrame` running 0 → 1, so a sequence
lasts `NumFrames / (Seq.Rate * Rate)` seconds. That formula is *checked* rather than
asserted, against the one effect here that has both an animation and a declared life: the
ring's `Explo` is 9 frames at 30 fps played at 0.35 → 0.857 s, against `LifeSpan` 0.800.
Within 7% and on the right side — UT99 kills the ring a hair before its animation ends. The
bullet impact's `Hit` is one frame at rate 0.5 → 67 ms. A flashbulb.

### Sprites are sized by texel

A UE1 sprite (`DT_Sprite`, `DT_SpriteAnimOnce`) is drawn as a camera-facing quad whose world
size is the **texture's own pixel size × `DrawScale`** in Unreal Units — one texel per unit
at `DrawScale` 1, which is the relation `gen-weapons.mjs` already uses for the projectile
explosions. A 32 px smoke puff at `DrawScale` 2 is 64 UU = 1.50 m; a 32 px spark at 0.1 is
7.5 cm; a 32 px decal at 0.19 is 14 cm. All three read right for what they are.

`UT_SpriteSmokePuff` picks one of four sets at random (`SSprites[Rand(NumSets)]`) and each
set is an `AnimNext` chain on the texture itself. The class declares `NumFrames = 8`, which
is what is composed onto each strip; the chain in the package actually runs to 15 or 16, and
that number is recorded in `ut-effects.json` rather than acted on.

### Three things that were wrong before the script was read

1. **`shockexplo` is not a light.** It has one, but it is an `AnimSpriteEffect`: 15 frames of
   a 128 px sprite, `Pause` 0.05, `LifeSpan` 0.7. It is named in `shockRing.notDrawn`
   alongside `EnergyImpact` (a scorch decal) rather than quietly dropped.
2. **`UT_RingExplosion` is not "Style 0, normal".** The actor carries `STY_None`, but the
   *mesh's* polygon flags are `0x400104` — `PF_Unlit | PF_TwoSided | PF_Translucent` — and
   the actor is `bUnlit` too. Two separate things say "translucent" and both matter, the
   same way `bUnlit` did for the projectiles: the beam and the bullet impact have polygon
   flags of zero and get their blend from the *actor's* `Style`.
3. **`ricochet` is spelled `Ricochet` in the package.** UE1 names are case-insensitive and
   UnrealScript's spelling of one is not the package's, so `build-ut-sounds.mjs` now falls
   back to a case-insensitive sweep. Without it exactly one of the four wall-hit sounds
   fails to extract, which is the kind of failure that gets "fixed" by typing a name in.

### A chip costs a spark

`UT_WallHit.SpawnEffects` rolls `rand(MaxSparks)` for a spark count and then **decrements it
for every chip it spawns**, so the budgets trade against each other rather than adding up.
Three classes, three budgets: `UT_WallHit` (Enforcer) 3 sparks / 2 chips at 0.2,
`UT_HeavyWallHitEffect` (Sniper) 4 / 2 at 0.5, `UT_LightWallHitEffect` (a *dual* Enforcer)
1 spark and no chips. The sound is one `FRand()` over four buckets and a quarter of wall
hits are silent; the heavy one is 50/25/25 and never is.

### Looking at it afterwards

    node scripts/build-ut-effects.mjs         # needs a retail install
    node scripts/build-ut-sounds.mjs          # needs a retail install and ffmpeg
    node scripts/gen-effects.mjs              # rewrite src/shared/effects.js
    node scripts/render-effects.mjs out.png
    node --test server/test/effects.test.mjs

`render-effects.mjs` needs no retail install: it draws the **committed** glTFs, textured, in
three columns — along +X (the surface normal), from the side with forward to the right, and
from above. The beam must be a long thin streak, the ring a ring, the bullet impact a
starburst spraying to the *right* out of the wall, the shell a little cylinder.

The ring's side and top panels come up **empty**, and that is the check rather than a bug:
`UTRingex` is a flat annulus with exactly zero thickness, so edge-on every triangle is
degenerate. Anything drawn there would mean the pitch-90 `RotOrigin` had not been applied.
`--at=8` poses it at the last frame of `Explo`, where it is 4.71 m across against 0.37 m at
frame 0 — the base pose is the *small* ring, so all-zero morph weights are the start.

## Third-person weapons

The gun in somebody **else's** hands. UT99 ships two models per weapon and they are not
interchangeable — `Engine.Inventory`:

    var() mesh  PlayerViewMesh;     var() float PlayerViewScale;    // yours
    var() mesh  ThirdPersonMesh;    var() float ThirdPersonScale;   // everyone else's

The view mesh is a gun and a forearm framed for a camera 8 cm away, drawn through UE1's own
view projection; the six of them are 0.12–0.20 m across (see **View weapons** above). Putting
one in a remote avatar's hand would be putting a 12 cm toy there. The third-person mesh is
the same weapon authored at **world** scale with a whole arm on it. `Inventory`'s replication
block names exactly `ThirdPersonMesh` and `ThirdPersonScale`, `BecomeItem` sets
`bCarriedItem = true`, and UE1 draws the carried item on the **owner pawn's** `Location` and
`Rotation` — `Location` being the *centre* of the collision cylinder, so the mesh's own
`Origin`, `RotOrigin` and `Scale` are the entire placement.

`scripts/build-ut-thirdperson.mjs` extracts all six into `assets/3d/thirdperson/<id>/`.

### It is the characters' transform, unchanged

That is the point of doing it in a script rather than by eye in the client: the gun and the
body have to land in the same frame. Same three steps as **The rule, which is the weapons'
rule unchanged** above — `(V - Mesh.Origin) × Mesh.Scale`, then the **transpose** of
`FRotationMatrix(RotOrigin)`, then UT (x fwd, y right, z up) → world (x right, y up, z back)
— times `UU_TO_M × ThirdPersonScale`. `ThirdPersonScale` is 1 on all six and is *read*,
because an unset property reports 0 and would collapse a weapon to a point.

`Mesh.Origin` is not inert here the way it is on a view mesh. `AutoHand`'s is
`(0, 250, -60)` and `RifleHand`'s `(15, 170, -30)`, and it is what puts the gun at the end
of an arm instead of inside the pawn's chest.

| weapon | mesh | wedges | size (m) | box centre (m) | bin |
| --- | --- | --- | --- | --- | --- |
| enforcer | `AutoHand` | 149 | 0.066 × 0.210 × 0.393 | 0.000, 0.944, −0.185 | 14K |
| sniper | `RifleHand` | 331 | 0.064 × 0.362 × **1.727** | −0.024, 0.999, −0.418 | 8K |
| shock | `ASMD2hand` | 294 | 0.123 × 0.172 × 1.188 | −0.024, 0.967, −0.374 | 38K |
| rocket | `EightHand` | 142 | 0.438 × 0.309 × 1.314 | −0.008, 1.015, −0.206 | 3K |
| ripper | `Razor3rd2` | 156 | 0.149 × 0.400 × 1.082 | −0.005, 1.060, −0.394 | 4K |
| redeemer | `WHHand` | 371 | 0.407 × 0.441 × 1.146 | 0.004, 1.004, −0.382 | 10K |

Every one is longest along **Z**, which is the barrel, and that is enforced rather than
reported: a turned gun in a remote avatar's hand is the third-person version of the bug that
had six of eight bodies running backwards. Every box centre is within 3 cm of the body's
centre line, 0.94–1.06 m off the floor, and 0.19–0.42 m forward of it.

`RifleHand` really is **1.727 m** from muzzle to elbow. Epic authored the third-person meshes
big — the `SniperRifle` *pickup* mesh in this same repo is 1.15 m of gun with no arm at all —
so `server/test/thirdperson.test.mjs` allows up to 1.8 m rather than the 1.6 the other five
would fit in.

### The anchor: Epic's weapon triangle, per frame

After the transform both a body and a gun are in **actor** space, where y = 0 is the middle
of the collision cylinder — and that is not where a hand is. The first version of this
script lifted the weapon onto the nominal pawn (39 UU × `UU_TO_M` = 0.9165 m) and stopped
there, which left it at the pawn's **actor origin**: drawn against the Soldier, **42 cm
below and 43 cm behind his fist**, down at the hip where the hand hangs when the arm is
*down*. Tracking the Soldier's own fist vertices across all 700 frames of his mesh, the
poses whose fist sits at that spot are `Look`, `LookL` and `Dead4`.

**Epic's answer is in the pawn mesh.** Every UT99 player mesh carries three *special*
vertices ahead of its geometry — `scripts/lib/umesh.mjs` reports `specialVerts` = 3 on all
eight bodies and 0 on every one of these weapons. No wedge and no face references them,
because they are not geometry: they are the weapon attachment. UE1 draws a carried item **at
that triangle, with that triangle's orientation**. Put through the same transform as the
body they bracket the gun hand — V0 about a hand above the fist, V2 the same below it, V1
out along the aim:

    soldier   V0 (0.140, 1.528, -0.433)   V1-V0 (-0.018, -0.006, -0.645)   V2-V0 (0.031, -0.382, 0.000)

Grip-to-fist distance, measured against each body's own forward-most upper-body cluster, for
every rule that was tried:

| rule | soldier | commando | boss | fcommando | sgirl | skaarj |
| --- | --- | --- | --- | --- | --- | --- |
| actor origin (what shipped first) | 56.4 | 49.5 | 51.1 | 71.0 | 74.7 | 72.1 |
| V0 alone | 15.6 | 15.7 | 12.4 | 13.2 | 13.9 | 12.0 |
| **V0–V2 midpoint** | **5.4** | **4.8** | **5.6** | 7.8 | 8.6 | 7.1 |

`(V*S − O)` was 5.4 **m** out (the Origin is in raw vertex units, so subtracting it after the
scale throws the gun across the room), Origin-ignored 65–90 cm, `(V+O)*S` 80–105 cm, and
also applying the *pawn's* own `Mesh.Origin` made every one of them worse.

**And it moves.** The triangle is per-frame data, so the anchor is not a number on the model
— it is a track. Over one `Run` cycle the hand travels:

| model | swing | | model | swing |
| --- | --- | --- | --- | --- |
| soldier | 85.5 cm | | fcommando | 59.5 cm |
| commando | 78.3 cm | | nali | 58.4 cm |
| boss | 78.3 cm | | warcow | 44.4 cm |
| sgirl | 62.9 cm | | skaarj | 31.7 cm |

A weapon pinned to the base pose would float most of a metre from a sprinting body.

#### What each character glTF carries

A root-level empty node named **`weaponAnchor`** — a *sibling* of the mesh node, so its local
transform is already in the body's own space and there is nothing for a client to compose:

    scenes[0].nodes  [0, 1]
    nodes[0]         { mesh: 0, name: <UT mesh name> }
    nodes[1]         { name: "weaponAnchor", translation: [x,y,z], rotation: [x,y,z,w] }

and on **every** clip (`Idle`, `Walk`, `Run`, `Fire`, `WalkFire`, `RunFire`) three channels:

    channels[0]  sampler 0 -> node 0, "weights"       (the morph pose; FIRST, on purpose)
    channels[1]  sampler 1 -> node 1, "translation"   VEC3
    channels[2]  sampler 2 -> node 1, "rotation"      VEC4, glTF order [x, y, z, w]

All three samplers share one `input` accessor, so key *i* of the anchor is the hand in key
*i* of the pose, wrap key included. All are `LINEAR`. The node's own `translation`/`rotation`
are the base pose's, so a model shown with no clip playing still holds its weapon correctly.

The rotation is built basis-first rather than from Euler angles: `z = -forward`,
`x = normalise(up × z)`, `y = z × x`, with `forward = V1 - V0` and `up = V0 - V2`, and the
quaternion comes off that matrix by Shepperd's method. `z = -forward` because the weapon
geometry points **−Z**, so its +Z is backwards. Adjacent keys are kept in the same
hemisphere (`dot ≥ 0`): *q* and *−q* are the same rotation, but a LINEAR sampler interpolates
*components*, and a sign flip between keys is a hand spinning 300° in one frame. On a body
standing square the base quaternion comes out as the identity — the Soldier's is
`(-0.004, 0.014, 0.041, 0.999)` — which is the check that the basis was built the right way
round.

`extras.weaponAnchorM`, `extras.weaponAnchorQuat` and `extras.specialVertsM` record the base
pose, and the generated `src/shared/characters.js` carries `MODELS[m].weaponOffsetM` /
`weaponOffset(index)` — **the static fallback**, that node's base-pose translation, for a
renderer that cannot parent to a node inside a loaded glTF. It has no rotation and it is
right only for a standing body.

| model | base anchor (m) | | model | base anchor (m) |
| --- | --- | --- | --- | --- |
| soldier | 0.156, 1.337, −0.433 | | fcommando | 0.239, 1.284, −0.578 |
| commando | 0.143, 1.228, −0.397 | | sgirl | 0.247, 1.366, −0.613 |
| boss | 0.141, 1.212, −0.407 | | skaarj | 0.066, 1.501, −0.244 |
| nali | 0.128, 1.084, −0.190 | | warcow | 0.040, 1.556, 0.142 |

Two honest caveats. The Nali comes out 25 cm off its fist and the cow 61 cm, and neither is
a surprise: a Nali has four arms and a cow has none, so there is no fist for an anchor to
agree with. And the anchor is Epic's attachment triangle, not a fitted number — 5–9 cm on a
humanoid is as close as it gets.

#### The weapons carry no lift

Because the anchor supplies the whole placement, the third-person glTFs are the weapon's own
actor-frame geometry **about its own origin**, with the nominal lift removed:

    world = anchor.translation + anchor.rotation * vertex

which is UE1's own composition. Box centres are now 0.03–0.14 m from the origin instead of
0.92 m above the floor, and `third.bboxM` / `third.muzzleLocal` in the weapon table moved
down by 0.9165 m with them. `third.sizeM` and the geometry itself are unchanged.

### Which animations, and what plays them

Two of the six third-person meshes move at all. Every one carries an `All` sequence (UE1's
catch-all span over every frame) and five carry a one-frame `Still`; those two names are the
resting pose, not animation, so they are not emitted as clips. What is left:

    AutoHand    Shoot  frames 1-6 @ 30      shot2  frames 1-6 @ 30
    ASMD2hand   Fire1  frames 1-9 @ 24      Fire2  frames 1-9 @ 24

`RifleHand`, `EightHand`, `Razor3rd2` and `WHHand` are a single frame each, so their `anims`
is **`null`** rather than an empty object — a UT99 sniper rifle does not move in anyone
else's hands, and a client should get one answer rather than something to interrogate.

What plays them is not a second set of rules. A weapon actor has **one** `AnimSequence`, and
UE1 plays it on whichever mesh that actor is drawing: your `PlayerViewMesh` for you, its
`ThirdPersonMesh` for everyone else. So `enforcer.PlayFiring`'s
`PlayAnim('Shoot', 0.5 + 0.31 * FireAdjust)` is what onlookers see on `AutoHand`, at the same
multiplier, because the two meshes name their sequences the same way. The multipliers are
therefore taken from `scripts/data/ut-viewmodels.json` **by clip name** rather than restated:
one place holds "what UnrealScript passes to `PlayAnim`", and a name that stops matching is a
build error instead of two files quietly drifting apart.

`ASMD2hand`'s `Fire2` has no name in that plan — `ShockRifle.PlayFiring` only ever plays
`Fire1` — so it is written into the glTF and left out of `anims`. It exists; nothing plays
it. Inventing a rate for it is how the Redeemer once got an idle animation it never had.

The gun does not carry the recoil — the **body** does. See **Which six sequences** above:
`PlayRecoil` plays `StillSmFr` on the pawn and `PlayFiring` swaps `RunSm`→`RunSmFr` and
`WalkSm`→`WalkSmFr`. A firing avatar is a pawn clip plus, on two of six weapons, a gun clip.

### What the weapon table carries

`scripts/gen-weapons.mjs` attaches a `third` block to each weapon in `src/shared/weapons.js`,
and — like `view` — `server/weapons.js` omits it, because the server never draws anything:

    third: {
      model:       "assets/3d/thirdperson/<id>/<id>.gltf",
      sizeM, bboxM,
      anims:       { fire: [{ clip, rate }], fireRepeat?, fireLoops } | null,
      muzzleLocal: [x, y, z],   // barrel tip, the frontmost 6% of the mesh averaged
    }

### Looking at it afterwards

    node scripts/build-ut-characters.mjs      # needs a retail install; run this FIRST
    node scripts/build-ut-thirdperson.mjs     # needs a retail install and the bodies' extras
    node scripts/gen-characters.mjs           # picks up weaponOffsetM
    node scripts/gen-weapons.mjs              # attaches `third`
    node scripts/render-thirdperson.mjs out.png
    node --test server/test/thirdperson.test.mjs server/test/characters.test.mjs

The order matters once: `build-ut-thirdperson.mjs` reads `extras.feetLiftM` off the committed
character glTFs to compute the residual, and refuses to run if a body has not been rebuilt
with it.

`render-thirdperson.mjs` needs no retail install — it draws the **committed** glTFs, a grey
body with an orange gun parented through the body's own `weaponAnchor` node, read out of the
file by name exactly as a client would. One column per weapon, one row per pose per view.

`--views=side` looks down +X, so the rig's forward (−Z) is to the **right**: every barrel
must point right and sit in the hand the silhouette is holding out. `--views=front` looks
down +Z from in front of the pawn, where a correctly placed weapon is a short foreshortened
stub, because you are looking down the barrel. `--poses=Idle@0,Run@0.25,Run@0.5,Run@0.75,Fire@0.5`
is the one that matters: the gun has to stay welded to the hand as the arm swings back and
down through the stride and kicks up on the recoil. `--model=skaarj` swaps the body; `--raw`
ignores the anchor and draws each weapon on its own origin, which puts them all in a heap at
the pawn's feet — a useful reminder of how much of the placement the anchor is doing.
