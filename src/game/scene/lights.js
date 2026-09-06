// lights.js — the lighting rig, as data.
//
// Every row below was an `<a-entity light="…">` in index.html, in markup order, with the
// markup's reasoning kept verbatim above it. Fourteen were live; five more sat inside
// HTML comments (three dead ambients, two dead directionals) and are not carried over.
//
// `intensity` values are unchanged from the markup. index.html ran the renderer with
// `physicallyCorrectLights: true`, i.e. A-Frame's `useLegacyLights = false`, which is the
// only mode r180 has — so these numbers mean the same thing here as they did there.
import * as THREE from "three";

// A-Frame's light component defaults, which the markup relied on wherever it left a
// property out. Note `decay`: A-Frame's default is 1 (illumination falling off as 1/d),
// three's own PointLight/SpotLight default is 2. The two glow lights built at runtime
// (ctf-flag.js, weapon-pickup.js) tune their intensity against 1/d explicitly, so 1 is
// the number makeLight has to keep.
const DEFAULTS = {
  intensity: 3.14,
  distance: 0,
  decay: 1,
  angle: 60, // degrees
  penumbra: 0,
  castShadow: false,
  shadowBias: 0,
  shadowRadius: 1,
  shadowMapWidth: 512,
  shadowMapHeight: 512,
  shadowCameraNear: 0.5,
  shadowCameraFar: 500,
  // Only the perspective shadow cameras (spot, point) read this; A-Frame's schema
  // default was 90 and its updateShadow() wrote it on every caster.
  shadowCameraFov: 90,
  shadowCameraLeft: -5,
  shadowCameraRight: 5,
  shadowCameraTop: 5,
  shadowCameraBottom: -5,
};

export const LIGHTS = [
  /*
    Sky/ground bounce. The reference calls out deliberate colour variation between
    inside and outside on CTF-Face, and the cheapest way to buy that globally is a
    hemisphere light with genuinely opposed hemispheres: warm sunlit sky above, cold
    starlight-and-shadow below. It used to be warm-over-warm-brown, which is why every
    surface in the map read as the same beige. (`decay` is not a hemisphere-light
    property and was doing nothing - removed rather than left as a decoy.)
  */
  {
    type: "hemisphere",
    color: "#ffd9ab",
    groundColor: "#1d2a4a",
    intensity: 0.75,
    position: [9.14829, 14.08152, 0],
  },

  // --- #map-lights ---------------------------------------------------------------

  /*
    Flat fill. A 0.6 *white* ambient is the single biggest enemy of team colour
    coding: it lifts every shadow to neutral grey and the red and blue lights below
    then have nothing dark to be coloured against. Same job, cold and dimmer, so the
    bases have somewhere to put their colour.
  */
  { type: "ambient", color: "#33456e", intensity: 0.5, position: [103.70468, 8.40799, -1.28974] },

  /*
    Bridge fill. distance:25 only covered a 25-unit bubble around the origin, which
    left most of the tower-to-tower span outside it entirely; widened to cover the
    bridge and lifted to compensate for physicallyCorrectLights.

    Everything here moved with the world scale (x2.33552, see
    src/shared/map-transform.js): 46 -> 107.43 and y 8 -> 18.68. INTENSITY moved too,
    and not by the same factor: a windowed point light falls off as 1/d^decay, so
    scaling both d and `distance` by k leaves the window term alone and divides the
    illumination by k^decay. Multiplying intensity by k^decay is what keeps the lit
    result identical rather than 1.7x darker. Here decay 0.6, so 9 -> 9*k^0.6 = 15.
  */
  {
    type: "point",
    intensity: 15,
    color: "#ffb04a",
    castShadow: false,
    distance: 107.43,
    decay: 0.6,
    position: [0, 18.68, 0],
  },

  /*
    Key light. The only shadow caster in the scene: one directional light is a single
    extra depth pass, whereas giving the point light at 0 8 0 castShadow would cost six
    (a cube shadow map). It aims at the world origin (three points a DirectionalLight at
    its untouched target, which sits at 0 0 0), so the ortho shadow frustum below is
    sized to cover the whole tower-to-tower span of CTF-Face.
    quality-tier turns castShadow off on the low tier.

    SHADOW FRUSTUM AT WORLD SCALE. The map is now 259 x 97 units across, so the old
    +/-70 ortho box (140 units) covered barely half of it and everything outside
    simply stopped casting. +/-165 covers the 259-unit span with room for the light's
    oblique angle; near/far and the light's own position moved by the same x2.33552 as
    the world, which keeps the light at the same standoff relative to the map
    (155 -> 363 units out, far 400 -> 935).

    The map stays at 2048 (here and in systems/quality-tier.js) ON PURPOSE, but be
    honest about what that buys: 330 units across 2048 texels is 161 mm per texel,
    against 68 mm before. That is the same effective sharpness a 869px map gave on the
    old scale - contact shadows are softer, and the fix if it reads badly is a
    follow-the-player frustum rather than a 4096 map (which costs 4x the memory to
    get back to where we were).

    shadowBias and shadowRadius are in texel/depth space, NOT world space, so they are
    deliberately unchanged - if acne or peter-panning shows up at the new texel size
    they need re-tuning by eye, not multiplying.
  */
  {
    // quality-tier finds this one by name to drop its shadow on the low tier, the way
    // it used to find #key-light by selector.
    name: "key-light",
    type: "directional",
    intensity: 3.1,
    color: "#ffe0b8",
    castShadow: true,
    shadowMapWidth: 2048,
    shadowMapHeight: 2048,
    shadowCameraLeft: -165,
    shadowCameraRight: 165,
    shadowCameraTop: 165,
    shadowCameraBottom: -165,
    shadowCameraNear: 2.34,
    shadowCameraFar: 935,
    shadowBias: -0.0007,
    shadowRadius: 2,
    position: [163.49, 221.87, -233.55],
  },

  /*
    Team lighting. Two rules from the CTF-Face reference drive the numbers here:
    the bases are unmistakably colour-coded, and there is deliberate colour variation
    between inside and outside. So each base gets a PALE, warm-shifted team tint at
    floor level (the "inside" - lamplit, closer to white, so you can still read the
    room) and a HARD, saturated team colour on the tower above it (the "outside" -
    this is the colour you identify from the far tower).

    #c8dcf4 and #f4c8c8 were, respectively, 4% and 8% away from plain white; at
    intensity 2 neither base was legibly coloured from more than a few metres. The
    light COUNT is unchanged - eight per base was already the perf budget - only the
    colours, intensities and reach are.

    Intensities are up roughly 3x across the board. That is not arbitrary: these were
    hand-tuned under useLegacyLights, and physicallyCorrectLights:true (the only mode
    r180 has) divides every punctual light by PI. Raising them here is the fix.

    Three numbers here are NOT symmetric between the bases, and the asymmetry is
    deliberate - all three were set by looking at the running game, not by arithmetic:

    1. BLUE IS ~1.4x RED. Blue exterior runs at 48 against red's 34. The map's stone is
       beige: high red channel, low blue channel. A blue light multiplied by a low-blue
       albedo lands dim, a red light multiplied by a high-red albedo lands hot, so
       matched intensities give a vividly red base facing a barely-tinted one. The blue
       is also cyan-shifted (#4aa8ff, was #2f86ff) so some of it rides the green channel,
       which the stone actually reflects.

       THERE IS A CEILING ON THIS, and it was overshot: at 105 (and it was 105, while
       this note still claimed 85) the blue tower's central ramp - the surface closest
       to these two lights - clipped to a flat, textureless white haze that read as fog,
       not stone, and was not even blue. A/B'd in Chrome from the bridge at x 28 and from
       the map centre, stepping 0 / 32 / 45 / 48 / 60 / 105: the wash appears well before
       the blue stops improving. 48 is the last value where the ramp still holds its
       stone texture while the flanks, buttresses, crown band and underpass all read as
       blue territory from the far tower. Do not push this back up without re-shooting
       the ramp: more intensity here buys white, not blue.

    2. THE CROWN LIGHTS ARE THE DIM ONES. 22-28 with decay 0.9 sat a couple of units off
       the merlons at the top of each tower and clipped them to flat white-hot bars with
       no texture left in them - the single most obviously-wrong thing in the frame.
       9-12 with decay 1.4 keeps the crown lit and hot on the inner faces while the
       stonework stays readable.

    3. THE INTERIOR SPOTS ARE 6x UP (5 -> 30). At 5 the tower interiors were near black
       - the red base especially - and the exterior point lights, which cast no shadows
       and so leak straight through the walls, were the only thing lighting them. That
       inverted the intended inside/outside contrast: saturated where it should be pale.
       At 30 each interior gets a visible pale lamp pool over the team wash, which is the
       colour variation the CTF-Face reference calls for.
  */

  // --- #blue-lights --------------------------------------------------------------

  // Blue base interior: pale, cool-white, readable.
  {
    type: "spot",
    angle: 70,
    color: "#8fc0ff",
    decay: 0.9,
    intensity: 64.4,
    penumbra: 0.6,
    position: [-91.14251, 13.44927, 1.07968],
    rotation: [-90, 0, 0],
  },

  /*
    Blue tower exterior: saturated, and with enough `distance` to actually reach the
    stonework.

    HEIGHT IS THE LOAD-BEARING NUMBER HERE, not intensity. These sat at y 14.6 while
    the red pair sit at y 10.7, and that one asymmetry was most of why the two bases
    did not read as equals: from the centre of the bridge the red tower was red from
    its crown down to and across its platform, while the blue tower was beige with a
    couple of blue smudges on it. At 14.6 the cone cleared the blue base's platform
    entirely and only washed the tower's midriff.

    That platform is the best tinting surface either base owns - it is PALE GREY rock,
    where the red side's is already tan. A blue light on grey stays blue; the same
    light on the beige stonework above is fought by the albedo's low blue channel
    (the reason the blue lights outrun the red ones 48-to-34 in the first place). So
    dropping them to 11.6 aims the strongest blue at the one surface that will
    actually carry it, and `distance` 40 with decay 1.1 still throws far enough up the
    tower to keep the midsection the lights used to own. Verified from a camera at the
    centre of the map, equidistant (45u) from both towers.
  */
  { type: "point", intensity: 122, color: "#4aa8ff", castShadow: false, distance: 93.42, decay: 1.1, position: [-56.75, 27.09, -9.34] },
  { type: "point", intensity: 122, color: "#4aa8ff", castShadow: false, distance: 93.42, decay: 1.1, position: [-56.75, 27.09, 9.34] },
  { type: "point", intensity: 39.3, color: "#2f6cff", castShadow: false, distance: 70.07, decay: 1.4, position: [-75.44, 76.84, -6] },
  { type: "point", intensity: 39.3, color: "#2f6cff", castShadow: false, distance: 70.07, decay: 1.4, position: [-75.44, 76.84, 4.79] },

  // --- #red-lights ---------------------------------------------------------------

  // Red base interior: pale, warm-white, readable.
  {
    type: "spot",
    angle: 70,
    color: "#ffb59b",
    decay: 0.9,
    intensity: 64.4,
    penumbra: 0.6,
    position: [98.02278, 13.44927, -11.90448],
    rotation: [-90, 0, 0],
  },

  // Red tower exterior.
  { type: "point", intensity: 86.4, color: "#ff3a22", castShadow: false, distance: 65.39, decay: 1.1, position: [80.34, 24.99, -24.29] },
  { type: "point", intensity: 86.4, color: "#ff3a22", castShadow: false, distance: 65.39, decay: 1.1, position: [80.34, 24.99, -1.4] },
  { type: "point", intensity: 29.5, color: "#ff1400", castShadow: false, distance: 60.72, decay: 1.4, position: [97.16, 76.14, -17.06] },
  { type: "point", intensity: 29.5, color: "#ff1400", castShadow: false, distance: 60.72, decay: 1.4, position: [97.16, 76.14, -6.66] },
];

// Scratch entity used to turn a markup `position`/`rotation` pair into the world-space
// transform A-Frame's <a-entity> gave the light. Reused; never added to a scene.
const entity = new THREE.Object3D();

/**
 * One `<a-entity light="…" position="…" rotation="…">`, as a three light.
 *
 * Two A-Frame behaviours have to be reproduced or the rig moves, and they are both in
 * A-Frame's light component (assets/libraries/aframe, src/components/light.js):
 *
 *  1. "HACK solution for issue #1624": for spot, directional and hemisphere lights the
 *     light object3D is `translateY(-1)`-ed inside the entity. That does NOT push the
 *     light a unit below the markup's `position` — it CANCELS a three default. three
 *     constructs DirectionalLight, HemisphereLight and SpotLight sitting at
 *     `Object3D.DEFAULT_UP`, i.e. local (0, 1, 0) (PointLight and AmbientLight are the
 *     exceptions: they start at the origin, which is why A-Frame leaves them alone).
 *     translateY(-1) puts those three back at local (0, 0, 0). Net effect: EVERY light
 *     in the rig sits exactly at its entity position, with no offset and no tilt — which
 *     is why nothing below rotates the light's own placement.
 *  2. A spot light's target is parented to the entity at local (0, 0, -1), so the cone
 *     aims down the entity's -z. For the two interior spots (rotation -90 0 0) that is
 *     world (0, -1, 0) from the light: straight down. A directional light's target is
 *     left untouched at the world origin, which is what the key light's comment above
 *     relies on.
 *
 * The returned light carries `.target` where it has one; the caller must add that target
 * to the same parent, or three reads an identity matrix for it.
 */
export function makeLight(spec) {
  const d = { ...DEFAULTS, ...spec };
  let light;

  switch (d.type) {
    case "ambient":
      light = new THREE.AmbientLight(d.color, d.intensity);
      break;
    case "hemisphere":
      light = new THREE.HemisphereLight(d.color, d.groundColor, d.intensity);
      break;
    case "point":
      light = new THREE.PointLight(d.color, d.intensity, d.distance, d.decay);
      break;
    case "spot":
      light = new THREE.SpotLight(d.color, d.intensity, d.distance, THREE.MathUtils.degToRad(d.angle), d.penumbra, d.decay);
      break;
    case "directional":
      light = new THREE.DirectionalLight(d.color, d.intensity);
      break;
    default:
      throw new Error(`unknown light type "${d.type}"`);
  }
  if (d.name) light.name = d.name;

  // Point (1) above: the translateY(-1) cancels the DEFAULT_UP three ships these lights
  // at, so the light lands on the entity origin whatever its type.
  light.position.set(...(d.position || [0, 0, 0]));

  if (d.type === "spot") {
    // The entity transform the markup gave this light, used only to place the target:
    // A-Frame's rotation component sets the Euler in three's default XYZ order, and the
    // only rotated lights in the rig turn about x alone, where the order cannot matter.
    entity.position.set(...(d.position || [0, 0, 0]));
    const [rx, ry, rz] = d.rotation || [0, 0, 0];
    entity.rotation.set(THREE.MathUtils.degToRad(rx), THREE.MathUtils.degToRad(ry), THREE.MathUtils.degToRad(rz));
    entity.updateMatrix();
    light.target.position.set(0, 0, -1).applyMatrix4(entity.matrix);
  }

  if (d.castShadow) {
    light.castShadow = true;
    light.shadow.bias = d.shadowBias;
    light.shadow.radius = d.shadowRadius;
    light.shadow.mapSize.width = d.shadowMapWidth;
    light.shadow.mapSize.height = d.shadowMapHeight;
    light.shadow.camera.near = d.shadowCameraNear;
    light.shadow.camera.far = d.shadowCameraFar;
    if (light.shadow.camera.isOrthographicCamera) {
      light.shadow.camera.left = d.shadowCameraLeft;
      light.shadow.camera.right = d.shadowCameraRight;
      light.shadow.camera.top = d.shadowCameraTop;
      light.shadow.camera.bottom = d.shadowCameraBottom;
    } else {
      // Spot and point casters get a perspective shadow camera, and A-Frame's
      // updateShadow() set its fov from the schema (default 90) as well. Nothing in the
      // rig casts from a spot or point today — the key light is the only caster — so
      // this branch is dormant, but leaving it out is how the next runtime-built caster
      // (ctf-flag's glow, say) would silently get a different frustum than it did on
      // A-Frame. Note three overwrites a SpotLightShadow's fov from the cone angle every
      // frame; the value below survives only on a PointLightShadow.
      light.shadow.camera.fov = d.shadowCameraFov;
    }
    light.shadow.camera.updateProjectionMatrix();
  }

  return light;
}
