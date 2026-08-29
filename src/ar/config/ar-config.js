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
    scale: 4,
    // Body capsule, in game units before `scale`.
    radius: 0.34,
    height: 1.75,
    // Height of the name label above the figure's feet, in the same units.
    labelHeight: 2.6,
    // Label quad width in game units. Names are unreadable if this is small and
    // they smear across the map if it is large.
    labelWidth: 3.6,
    // Bob amplitude applied while a player is moving. Reads as motion at a size
    // where limbs never would.
    bob: 0.12,
    // Palette, cycled by player id. Bright and unlit-looking on purpose - these
    // are map pins, not characters.
    colors: ["#ff5a3c", "#37c7ff", "#ffd23f", "#7bff8f", "#c98bff", "#ff7ad9", "#8fd0ff", "#ffa14a"],
    deadColor: "#5a1f1f",
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
