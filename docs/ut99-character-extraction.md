# Extracting the UT99 characters

The eight playable Unreal Tournament characters, out of the retail packages and into
`assets/3d/characters/` as glTF with `Idle`/`Walk`/`Run` animations.

The extractor itself is not in this repo — it is throwaway tooling that ran once. This
file is the part worth keeping: **what the format actually does**, because almost none
of it is guessable and every wrong guess renders as something that looks nearly right.

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
