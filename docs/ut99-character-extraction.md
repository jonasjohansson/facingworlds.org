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

### Which three sequences

The client binds clips by the names `Idle` / `Walk` / `Run`. Which UT99 sequence goes in
each is read out of `Botpack.TournamentPlayer`'s UnrealScript, which the package ships:

    PlayWalking()   LoopAnim(Weapon.Mass < 20 ? 'WalkSM' : 'WalkLG')
    PlayRunning()   LoopAnim(Weapon.Mass < 20 ? 'RunSM'  : 'RunLG')
    PlayFiring()    TweenAnim(Weapon.Mass < 20 ? 'StillSMFR' : 'StillFRRP')
    PlayWaiting()   ... bPointing: TweenAnim(Weapon.Mass < 20 ? 'StillSMFR' : 'StillFRRP')

Everyone here spawns with the Enforcer and never puts it down, and its `Mass` is under 20,
so the small-weapon variant is right everywhere: **`WalkSm`, `RunSm`, `StillSmFr`**.
`PlayWeaponSwitch` confirms the pairing from the other side — it rewrites `StillSMFR` to
`StillFRRP` and back as the carried weapon crosses `Mass` 20. `StillSmFr` is the *armed*
idle, a pawn standing with its gun up; `PlayWaiting`'s other branch
(`Breath1`/`Breath2`/`CockGun`) is the unarmed fidget. The old files used `StillFrRp` on the
humans and `StillLgFr` on the Skaarj, which are the heavy-weapon idles: right family, wrong
weight.

All eight meshes carry all three names, so there is no fallback. One oddity is Epic's and
is passed through: `TCowMesh`'s `WalkSm` and `RunSm` are the **same** sixteen frames
(250–265) at 15 and 27 fps, so the cow runs by walking faster.

Clips are emitted the way the weapons are — one morph target per unique frame, base = the
`Idle` clip's first frame with no target of its own, one-hot weights, **`LINEAR`** because
UE1 tweens between frames (the old files used `STEP`, which judders a ten-frame run cycle),
and one extra wrap keyframe on a loop.

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
