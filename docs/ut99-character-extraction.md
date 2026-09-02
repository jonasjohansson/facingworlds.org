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
