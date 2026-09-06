# src/game/vendor

Third-party ES modules the game page loads directly. Nothing here is ours; do not edit the
code. To update, re-run the recipe below and re-run `node --test server/test/navclamp.test.mjs`.

The AR page keeps its own copies of the three.js addons it needs in `src/ar/vendor/`
(`loaders/GLTFLoader.js`, `loaders/DRACOLoader.js`, `draco/`, `utils/`); the game imports the
loaders from there rather than duplicating them. `assets/libraries/three/` holds three r180
itself, import-mapped as `"three"` by both pages.

## three-pathfinding.module.js

- **Version:** 1.3.0
- **Source:** https://www.npmjs.com/package/three-pathfinding (`package/dist/three-pathfinding.module.js`)
- **License:** MIT (Don McCurdy) — see the package's LICENSE
- **Imports:** the bare specifier `"three"`, resolved by the import map in `index.html`
  in the browser and by `node_modules/three` (a devDependency) in the Node tests.

```bash
npm pack three-pathfinding@1.3.0 && tar xzf three-pathfinding-1.3.0.tgz
cp package/dist/three-pathfinding.module.js src/game/vendor/three-pathfinding.module.js
```

Byte-identical to the published dist except for the trailing `//# sourceMappingURL=` comment,
which is dropped because we do not ship the `.map` (nothing else vendored in this repo carries
one either, and it would 404 with devtools open).

**Why it is here.** aframe-extras bundled this library inside its minified build and exposed it
only through the `nav` system + `nav-mesh` + `movement-controls constrainToNavMesh`. Leaving
A-Frame means losing that wrapper, and the player still has to be clamped to the navmesh every
frame — so the library it wrapped is now a direct dependency of `src/game/player/navclamp.js`.
It is the same version aframe-extras carried, so the clamp behaves exactly as it does today.
