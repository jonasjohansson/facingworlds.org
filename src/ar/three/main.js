import { ARDemo, encantar } from "../../../assets/libraries/encantar/plugins/three-with-encantar.js";
import { AR_CONFIG } from "../config/ar-config.js";
import { buildScene } from "./scene.js";
import { createMusic } from "./music.js";
import { getSpectatorUrl } from "./server-url.js";
import { createHud } from "./hud.js";

// Facing Worlds AR - a live spectator table, on pure Three.js.
//
// WHAT CHANGED, AND WHY IT MATTERS
//
//  * The map does not rotate. encantar returns a full 6DoF pose relative to the printed
//    marker, which means a model that holds perfectly still is one the viewer can walk
//    around, crouch beside and look behind. Spinning it throws all of that away and
//    announces "this is a rendering". The most important thing in this file is a line
//    that is not in it.
//  * No A-Frame. The page loads three r180 directly. That removes the VR button and
//    A-Frame's branding; removes the tug-of-war over the renderer (A-Frame's renderer
//    system owns tone mapping, and encantar overwrites A-Frame's renderer attribute
//    during init, so neither side wins cleanly); removes the two default lights A-Frame
//    injects into every scene behind your back; and takes a large dependency off a
//    phone already doing camera capture, feature tracking AND rendering.
//  * Live players standing on the map. See scene.js and players.js.
//
// This module owns the session: starting it, tracking state, music, and the HUD. The
// contents of the marker live in scene.js.

const AR = window.AR;

class FacingWorldsAR extends ARDemo {
  constructor() {
    super();
    this.hud = createHud();
    this.music = createMusic();
    this.scene = null;
    this.tracker = null;
    this.tracking = false;
    this.lastFrameMs = 0;

    this.onTargetFound = () => this.setTracking(true);
    this.onTargetLost = () => this.setTracking(false);
  }

  // ---------------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------------

  startSession() {
    if (!AR.isSupported()) {
      this.hud.fail("This device or browser cannot run the AR experience.");
      throw new Error("encantar: unsupported browser");
    }

    const render = AR_CONFIG.render;

    const tracker = AR.Tracker.Image({ resolution: render.trackerResolution });
    this.tracker = tracker;

    const image = new Image();
    image.crossOrigin = "anonymous";
    image.src = AR_CONFIG.tracker.image;

    return tracker.database
      .add([{ name: AR_CONFIG.tracker.name, image }])
      .then(() =>
        AR.startSession({
          mode: "immersive",
          viewport: AR.Viewport({
            container: this.hud.viewport,
            hudContainer: this.hud.container,
            resolution: render.viewportResolution,
            style: "best-fit",
          }),
          trackers: [tracker],
          sources: [AR.Source.Camera({ resolution: render.cameraResolution })],
          stats: AR_CONFIG.scene.stats,
          gizmos: AR_CONFIG.scene.gizmos,
        })
      )
      .catch((error) => {
        this.hud.fail(sessionErrorMessage(error));
        throw error;
      });
  }

  // ---------------------------------------------------------------------------
  // Scene
  // ---------------------------------------------------------------------------

  async init() {
    const ar = this.ar;

    // The renderer was built around encantar's own canvas, which encantar has ALREADY
    // sized to the viewport's virtual size (its first resize event fires during
    // startSession, before the plugin attaches its listener). three therefore starts at
    // exactly the right drawing buffer with pixelRatio 1.
    //
    // Do not raise it. setPixelRatio() immediately re-runs setSize(), so passing
    // devicePixelRatio here would multiply that buffer - 1.5x per axis, 2.25x the
    // fragments - on a phone that is also doing camera capture and feature tracking,
    // and it would silently snap back to 1 the first time the device is rotated. Cap
    // only; never raise.
    ar.renderer.setPixelRatio(Math.min(ar.renderer.getPixelRatio(), AR_CONFIG.render.maxPixelRatio));

    // The marker is what the user is hunting for, so say so as soon as the camera is
    // live rather than after a 3 MB download.
    this.hud.ready();

    // encantar's own tracker events are the authoritative "the marker is on screen"
    // signal - more reliable than inspecting frame results, and they cannot disagree
    // with the plugin's own visibility handling.
    //
    // Subscribed BEFORE the map downloads, on purpose. The tracker runs inside
    // encantar's own loop, which is already live, so a user who is pointing at the
    // print while the 3 MB glTF lands fires targetfound during the await. Subscribing
    // afterwards misses that edge and leaves the map stuck at reveal t=0 - a dot -
    // until the marker is lost and reacquired.
    this.tracker.addEventListener("targetfound", this.onTargetFound);
    this.tracker.addEventListener("targetlost", this.onTargetLost);

    this.scene = await buildScene(ar, {
      spectatorUrl: getSpectatorUrl(),
      onSpectatorStatus: (state, count) => this.hud.setSpectatorStatus(state, count),
      // The match. Both of these are pushed, never polled: the score changes on a
      // capture and the roster on a join or a death, and neither is per-frame work.
      onMatchState: (state) => this.hud.setMatch(state),
      onRoster: (rows) => this.hud.setRoster(rows),
    });

    if (this.scene.error) {
      this.hud.warn(this.scene.error);
    }

    // Already on the marker when the map arrived: play the entrance now.
    if (this.tracking) {
      this.scene.reveal.reset();
    }

    // Only now start buffering the soundtrack. The track is 12.7 MB against the map's
    // 3.2 MB, so warming it alongside the download - which is what the A-Frame page did
    // on `arready` - hands most of the phone's bandwidth to audio nobody can hear yet
    // and multiplies time-to-map. The user is still hunting for the print at this
    // point, which is all the head start the track needs.
    this.music.warm();
  }

  // ---------------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------------

  update() {
    const now = performance.now();
    // Clamped: a backgrounded tab or a long GC pause must not fast-forward the reveal.
    const deltaMs = this.lastFrameMs ? Math.min(now - this.lastFrameMs, 100) : 0;
    this.lastFrameMs = now;

    if (!this.tracking || !this.scene) {
      return;
    }

    this.scene.reveal.update(deltaMs);
    this.scene.table.update(deltaMs);
    // After the table, on purpose: a carried flag is parented to its carrier's
    // figure, so the figure has to have been moved for this frame before the
    // flag decides whether it is still attached to the right one.
    if (this.scene.flags) {
      this.scene.flags.update(deltaMs);
    }
  }

  setTracking(tracking) {
    if (this.tracking === tracking) {
      return;
    }
    this.tracking = tracking;
    this.hud.setTracking(tracking);

    if (tracking) {
      // The scene may still be downloading - init() replays the reveal when it lands.
      if (this.scene) {
        this.scene.reveal.reset();
      }
      this.music.start();
    } else {
      this.music.stop();
    }
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  release() {
    if (this.tracker) {
      this.tracker.removeEventListener("targetfound", this.onTargetFound);
      this.tracker.removeEventListener("targetlost", this.onTargetLost);
      this.tracker = null;
    }
    if (this.scene) {
      this.scene.dispose();
      this.scene = null;
    }
    this.music.dispose();
  }
}

function sessionErrorMessage(error) {
  const name = (error && (error.name || (error.constructor && error.constructor.name))) || "";
  const message = String((error && error.message) || "");
  if (/AccessDenied|NotAllowed|Permission/i.test(name) || /permission|denied|allow/i.test(message)) {
    return "Camera access was denied. Allow the camera and reload to see the table.";
  }
  if (/NotFound|Device/i.test(name) || /no camera|not found/i.test(message)) {
    return "No camera was found on this device.";
  }
  return "The AR session could not start on this device.";
}

const demo = new FacingWorldsAR();
encantar(demo).catch((error) => {
  console.error("[ar] session failed:", error);
});

export { demo, FacingWorldsAR };
