# Extracting the UT99 characters

The eight playable Unreal Tournament characters, out of the retail packages and into
`assets/3d/characters/` as glTF with `Idle`/`Walk`/`Run` animations.

The mesh extractor itself is not in this repo — it is throwaway tooling that ran once.
This file is the part worth keeping: **what the format actually does**, because almost
none of it is guessable and every wrong guess renders as something that looks nearly
right.

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
authored standing, on UE1's own Z-up. There is no single up axis. Modelling the
rotator is a trap — applying it forwards stands the bonus models up and puts the other
six on their heads, applying its inverse lays them on their side — so read the axis off
`RotOrigin` and assert it matches the tallest axis of the idle pose.

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

    npm run gen:characters          # rewrite src/shared/characters.js + server/characters.js
    npm run gen:characters:check    # fail if out of date

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
