// AR Configuration
//
// Single source of truth for the AR experience. Both AR pages read from here:
// ar/index.html (pure Three.js, the live spectator table) and ar/aframe.html (the
// A-Frame fallback), so tuning the look is a one-file edit.
//
// Coordinate note: encantar places the AR root in *marker space*. The reference
// image lies in the XY plane and spans roughly 2 units across its longest side,
// with +Z pointing out of the print. So "up" is +Z here, not +Y.
//
// The Facing Worlds map, on the other hand, is authored Y-up, and the game places
// it at the identity transform (see #world in index.html). Game world coordinates
// are therefore *identical* to map-model coordinates - which is exactly why live
// player poses can be dropped into the same node the model hangs from and land on
// the right rooftop. See src/ar/three/players.js.
//
// That contract SURVIVED the x2.33552 world scale that brought the map up to UT99
// pawn scale, and only because the scale is baked into the .glb by
// scripts/optimize-assets.mjs rather than set as a `scale` attribute on #world. Both
// pages load the same scaled asset, so both agree. See src/shared/map-transform.js.
// If anyone ever moves that scale onto the entity instead, this file is the thing
// that breaks: poses would land 2.34x too far out and float off the rock, and the
// fix would be to divide incoming poses by k in src/ar/three/players.js.
export const AR_CONFIG = {
  // Scene settings
  scene: {
    stats: false,
    gizmos: false,
    loadingScreen: false,
  },

  // Tracker settings
  tracker: {
    image: "../assets/images/tracker.jpg",
    name: "tracker",
  },

  // Asset URLs, best first. Each list is tried in order and the first one that
  // loads wins, so the optimized build can be missing (it is gitignored) without
  // taking the page down.
  //
  // The optimized map is 3.2 MB of Draco + WebP against ~14 MB of glTF + PNG for
  // the original. That is the single biggest performance lever on this page: the
  // phone is already running camera capture, feature tracking and rendering.
  //
  // WARNING, since the world scale landed: the second entry is the UNSCALED source. The
  // x2.33552 correction is baked by scripts/optimize-assets.mjs into the .glb only, so if
  // the fallback is ever the one that loads, model-fit will still size the rock correctly
  // on the print (it measures whatever it is given) but live player poses — which arrive
  // in scaled game coordinates — will land 2.34x too far out and float off it. The
  // optimized tree is committed, so this should not happen; if the fallback is ever needed
  // for real, either regenerate it or divide incoming poses by the scale in
  // src/ar/three/players.js. See src/shared/map-transform.js.
  assets: {
    map: ["../assets-optimized/3d/map/FacingWorlds_tex_5.glb", "../assets/3d/map/FacingWorlds_tex_5.gltf"],
    // Where DRACOLoader fetches its decoder from. Only requested if a glTF that
    // actually uses KHR_draco_mesh_compression is loaded, so the plain .gltf
    // fallback path never pays for it.
    dracoDecoder: "../src/ar/vendor/draco/",
  },

  // The Facing Worlds map floating above the print
  model: {
    // Footprint width in marker units. The print is ~2 units wide. 2.2 kept the
    // towers inside the sticker's own footprint, which reads as small and
    // timid on a table; letting the rock overhang the print reads as an object
    // sitting there. The tracker only has to stay in frame, not stay uncovered.
    //
    // UNCHANGED by the world scale, and it must stay that way: model-fit.js measures
    // the loaded model's own bounding box and computes scale = size / footprint, so
    // this is the map's physical size ON THE TABLE regardless of what the .glb
    // contains. The map's footprint grew 111 -> 259 game units, so the fit scale it
    // produces fell from 0.0288 to 0.0123 and the print looks identical.
    size: 3.2,
    // Gap between the print and the underside of the model.
    hover: 0.16,
    // NOTE: there is deliberately no idle rotation any more. encantar gives a full
    // 6DoF pose relative to the print, so a model that holds still is one the user
    // can physically walk around; a model that spins is obviously a rendering.
    // Anisotropic filtering for the map's textures. The towers are almost always
    // seen at a grazing angle in AR, which is exactly where trilinear filtering
    // turns detail to mush. 4x is a visible win for very little GPU time; it is
    // clamped to whatever the device actually supports.
    anisotropy: 4,
    // Entrance animation played every time the marker is (re)acquired.
    reveal: {
      duration: 700,
      // How far below its resting height the model starts, in marker units.
      rise: 0.35,
    },
  },

  // Lighting. Deliberately two real lights + an image-based environment:
  // the phone is already busy with camera capture and tracking.
  lighting: {
    // Equirectangular source for the PMREM environment. This is what makes the
    // map's metallic-roughness materials read as metal instead of grey plastic -
    // metals have no diffuse term, so with no environment they render near-black.
    envMap: "../assets/graphics/space_environment_2k.png",
    envIntensity: 1.0,
    // Tone mapping. Applied straight to the renderer rather than through the
    // <a-scene renderer=""> attribute: encantar overwrites that attribute with
    // its own { alpha: true } during scene init, which silently drops anything
    // else declared there. One of "no", "ACESFilmic", "linear", "reinhard",
    // "cineon". ACES keeps the key light from blowing out polished metal;
    // exposure is nudged above 1 to offset the mid-tone dip it introduces.
    toneMapping: "ACESFilmic",
    exposure: 1.15,
    // Key light. Positioned in marker space: mostly overhead (+Z) but raked to
    // one side, because a shadow that falls straight down reads as a sticker and
    // an offset shadow reads as a real object under a real ceiling light.
    key: {
      color: "#fff2e2",
      intensity: 1.8,
      position: { x: 1.5, y: -1.7, z: 3.2 },
    },
    // Fill approximating a room: cool daylight from above, warm bounce off the
    // table the print is sitting on.
    fill: {
      sky: "#c9dcff",
      ground: "#6d6153",
      intensity: 0.55,
    },
  },

  // Grounding shadow on the marker plane.
  shadow: {
    // Side length of the shadow-catching plane, in marker units. Generous, so a
    // raked shadow never runs off the edge.
    size: 5,
    // Half-width of the key light's orthographic shadow frustum. Kept tight
    // around the model footprint plus its raked shadow: every unit of slack here
    // costs shadow-map resolution, which is what turns contact shadows to mush.
    extent: 2.2,
    // How dark the cast shadow gets over the camera feed.
    opacity: 0.38,
    // Soft contact blob directly under the model (sells the float).
    blobSize: 2.6,
    blobOpacity: 0.3,
    mapSize: 1024,
  },

  // Music. Starts on marker detection, not on model load.
  audio: {
    // The clean music track, NOT the "-gameplay-audio" mix. That mix has
    // recorded gunfire and announcements baked into it, so on a table with
    // nobody playing it sounds like a match is happening somewhere. It is also
    // 12.7 MB against 6.0 MB, on the one page that runs on a phone.
    src: "../assets/audio/110-van_den_bos--foregone_destruction-i.mp3",
    volume: 0.35,
    // Fade in/out duration in ms when the marker is found / lost.
    fade: 700,
  },

  // Live spectator table. The AR page joins the game server as a read-only
  // observer (?spectate=1) and draws every connected player standing on the map.
  spectator: {
    enabled: true,
    // Rendering delay, in ms, applied by the snapshot buffer. The server sends
    // poses every 100 ms (GAME_CONFIG.NETWORK.POSE_UPDATE_INTERVAL), so ~120 ms of
    // delay keeps at least one snapshot on each side of the sample point and turns
    // a 10 Hz feed into smooth 60 Hz motion.
    delayMs: 120,
    maxExtrapolationMs: 250,
    // How long a player keeps their "just died" look before the marker fades out.
    // Only cosmetic - the server's respawn message is what actually revives them.
    deathFadeMs: 900,
  },

  // Player markers on the table.
  //
  // Scale, honestly: the map is ~111 game units on its longest axis and is fitted
  // to 2.2 marker units, so one game unit is ~0.02 marker units. A print ~15 cm
  // wide is 2 marker units, i.e. ~7.5 cm per unit, which puts a life-sized 1.8 m
  // player at under 3 mm tall - invisible. `scale` below inflates the figure (not
  // its position) so it reads like a wargaming piece on a table. Positions still
  // go through the map's own fitted transform, so a figure always stands exactly
  // where the player stands.
  avatar: {
    // The actual player character, so a figure on the table reads as a
    // soldier rather than a pill. Ordered fallback; if none loads, players.js
    // falls back to a built-in capsule and the table still works.
    //
    // The model carries Idle/Walk/Run clips, and the poses already carry
    // `speed`, so figures walk and run on the rock rather than sliding.
    // Skinning one skeleton per player is the real cost here — cap it, and
    // fall back to capsules past the cap rather than dropping frames on a
    // phone that is also running camera capture and image tracking.
    modelUrls: ["../assets-optimized/3d/Soldier.glb", "../assets/3d/Soldier.glb"],
    maxSkinned: 8,
    // Clip names in the file, and the speeds (game units/s) they belong to.
    walkSpeed: 2.2,
    runSpeed: 6.5,
    clips: { idle: "Idle", walk: "Walk", run: "Run" },
    // Muzzle flash. A spectator is told WHO fired and when, but
    // never where the shot landed — hit resolution is a separate message
    // against a victim. So a tracer would have to be re-traced against
    // the map on the phone, and would be a few millimetres of smear at
    // table scale anyway. A bright pip at the shooter reads better and
    // costs nothing: you see who is shooting, which is what makes a
    // match legible from outside it.
    flash: {
      // Radius in game units, before `scale`.
      size: 0.42,
      color: "#ffd9a0",
      // Seconds to fade out over. Short enough to read as a shot rather
      // than a glow, long enough to survive a 10 Hz pose feed.
      fadeMs: 110,
      // Height above the figure's feet, in game units before `scale`.
      height: 1.5,
    },
    // How much the figures are inflated so a 1.75-unit body is legible on a table.
    // This is the ONE number in this file the world scale touches. Everything else in
    // `avatar` is quoted "in game units before scale" and rides inside `scale`, so it
    // self-corrects; `scale` itself is what stands between game units and marker units,
    // and the fit scale on the other side of it fell by exactly k when the map grew.
    // 4 -> 4 x 2.33552 = 9.34 keeps the spectator figures the same size on the print.
    scale: 9.34,
    // Body capsule, in game units before `scale`.
    radius: 0.34,
    height: 1.75,
    // Height of the name label above the figure's feet, in the same units.
    labelHeight: 2.6,
    // Label quad width in game units. Halved from 3.6 after seeing it on the real
    // print: at 3.6 a single name spanned an eighth of the whole map and two
    // players standing together were a wall of text over the thing you came to
    // look at. A name tag is an answer to "who is that", not signage - it only has
    // to be readable when you lean in, and the figure's team colour is what reads
    // from across the table. Tap the view to hide them entirely; see labelsVisible
    // in src/ar/three/players.js.
    labelWidth: 1.8,
    // Bob amplitude applied while a player is moving. Reads as motion at a size
    // where limbs never would.
    bob: 0.12,
    // Palette, cycled by player id. Bright and unlit-looking on purpose - these
    // are map pins, not characters. Only used for a player the server has NOT put
    // on a team - in CTF everyone has one, so this is the fallback, not the norm.
    colors: ["#ff5a3c", "#37c7ff", "#ffd23f", "#7bff8f", "#c98bff", "#ff7ad9", "#8fd0ff", "#ffa14a"],
    deadColor: "#5a1f1f",

    // Team tint. The match is Capture the Flag, so "which side is that figure on"
    // is the single most important thing a spectator has to read, and at a few
    // millimetres tall it has to be readable from colour alone.
    //
    // These are the two team colours as CSS rgb(), parsed through THREE.Color so
    // they go through colour management like every other colour on the page.
    // Applied as BOTH diffuse and emissive: diffuse alone loses the read whenever
    // a figure is on the shadowed side of the rock, and emissive alone washes the
    // soldier's own texture out.
    teamColors: {
      red: "rgb(239, 0, 0)",
      blue: "rgb(0, 120, 239)",
    },
    // How much of the team colour is added as emissive. High enough to survive the
    // rock's shadow, low enough that the model still reads as a soldier.
    teamEmissive: 0.42,
  },

  // The two flags, and the score.
  //
  // Same primitives as the game's own flag (src/game/components/ctf-flag.js): a
  // stand, a pole, a finial and a plane waved in the vertex shader. Deliberately
  // NOT the same module - that one is an A-Frame component and this page has no
  // A-Frame - so the construction is repeated in plain three here.
  //
  // Dimensions below are quoted in GAME UNITS BEFORE `scale`, exactly like the
  // avatar props, and ride inside `scale` for the same reason: positions come off
  // the wire in game world coordinates and go into the same node the map hangs
  // from, but a life-sized flag on a table-sized rock is invisible.
  //
  // NO POINT LIGHT, on purpose. The game's flag carries one because a dropped flag
  // out on the bridge has to be findable from the other tower; here the whole map
  // is in frame at once, so the light would buy nothing - and three.js recompiles
  // every material in the scene when the visible light count changes, which is a
  // hitch on every take and every return, on a phone that is also running camera
  // capture and image tracking. The cloth is emissive instead.
  ctf: {
    enabled: true,
    // Inflation, matching the figures so a flag reads as something a figure could
    // carry. Same number as avatar.scale; kept separate so it can be tuned alone.
    scale: 9.34,
    poleHeight: 2.4,
    poleRadius: 0.035,
    clothW: 1.1,
    clothH: 0.7,
    waveSpeed: 4.5,
    waveAmp: 0.09,
    // Emissive fraction of the team colour on the cloth, so a flag is legible
    // against the map's bright metal without a light of its own.
    clothEmissive: 0.55,
    // Where a carried flag rides on its carrier, in game units before scale. The
    // flag is parented to the carrier's figure, so this is inside that figure's
    // own scale and does not need inflating.
    carryOffset: { x: 0.0, y: 1.15, z: 0.32 },
    carryTiltDeg: -35,
    dropTiltDeg: 12,
    // A dropped flag bobs, so "come and get this" reads from across the table.
    bobHeight: 0.18,
    bobSpeed: 2.2,
  },

  // Renderer budget. Everything here exists because this is a phone doing camera
  // capture, image tracking and rendering at the same time.
  render: {
    // Ceiling on the renderer's pixel ratio. encantar already sizes its canvas to
    // the viewport resolution below at ratio 1, and the three plugin re-pins it to 1
    // on every resize, so this only ever caps - it must never be used to RAISE the
    // ratio, which would multiply the drawing buffer and then silently snap back on
    // the first device rotation. See src/ar/three/main.js.
    maxPixelRatio: 1.5,
    // encantar resolutions. These are the values the A-Frame page ran with and a
    // phone was confirmed to track at, so they are kept as-is.
    viewportResolution: "lg",
    cameraResolution: "md",
    trackerResolution: "sm",
  },

  // Portal settings (used by the optional portal component)
  portal: {
    radius: 1,
    skyTexture: "#sky",
    animated: false,
  },

  // Canvas settings
  canvas: {
    fps: 30,
  },
};
