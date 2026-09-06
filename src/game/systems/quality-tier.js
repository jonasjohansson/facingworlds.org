/**
 * Quality Tier
 *
 * Desktop-first. Picks a tier once and applies everything that can still be changed
 * after the WebGL context exists: pixel ratio, shadow map, image-based lighting strength,
 * texture anisotropy and post-processing.
 *
 * What it deliberately does NOT touch: `precision` and `antialias`. Both are baked into
 * the WebGL context at creation, so they live in engine/game.js's WebGLRenderer options
 * rather than here. `precision: "highp"` is kept everywhere because the previous `low`
 * setting gave lowp fragment shaders and visible banding on every platform.
 *
 * Override for testing with ?quality=low / ?quality=high in the URL.
 */
import * as THREE from "three";

const DEFAULTS = {
  // Cap on window.devicePixelRatio. Retina at 3x costs 9x the fill rate for a
  // barely visible gain.
  desktopPixelRatio: 2,
  mobilePixelRatio: 1.5,
  // Kept at 2048 across the x2.33552 world scale (src/shared/map-transform.js), which
  // means the same texel count now stretches over a 330-unit shadow frustum instead of
  // a 140-unit one: 161 mm per texel against 68 mm, i.e. the effective sharpness a
  // 869px map used to give. If contact shadows read badly, a follow-the-player frustum
  // on the key light is the fix — 4096 costs 4x the memory just to get back to par.
  desktopShadowMapSize: 2048,
  bloom: true,
};

/**
 * What A-Frame's utils.device.isMobile() answered. A-Frame ran the detectmobilebrowsers.com
 * pair of regexes and then OR-ed in `isIOS() || isTablet() || isR7()`. This keeps the
 * first regex (the substantive one) verbatim and drops the second, a table of
 * four-character device-code prefixes for pre-2010 feature phones that cannot run WebGL2
 * at all. The third regex below stands in for that `isIOS() || isTablet()` branch —
 * A-Frame's isTablet is `/Nexus (7|9)|xoom|sch-i800|playbook|tablet|kindle/i` plus its
 * iPad check — because the first regex only matches Android with a literal "mobile"
 * token in the UA and knows nothing about iPads, the PlayBook or Kindle Fire's Silk.
 * (isR7, one 2014 Android handset, is not worth a fourth test.) iPadOS gets its own
 * check because it reports a desktop Safari UA with no "iPad" in it at all.
 */
function isMobileBrowser() {
  const ua = window.navigator.userAgent || window.navigator.vendor || "";
  // eslint-disable-next-line no-useless-escape
  if (
    /(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|iris|kindle|lge |maemo|midp|mmp|mobile.+firefox|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows ce|xda|xiino/i.test(
      ua
    )
  ) {
    return true;
  }
  // iPad on iPadOS 13+ claims to be a Mac; the touch points give it away.
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  return /android|ipad|playbook|silk/i.test(ua);
}

/** A-Frame's utils.device.isMobileVR() — standalone headset browsers. */
function isHeadsetBrowser() {
  const ua = window.navigator.userAgent || "";
  return /OculusBrowser|Quest|Pico|Vive|SamsungBrowser.+VR|Wolvic/i.test(ua);
}

/**
 * "high" = desktop, "low" = mobile/tablet/headset browsers.
 *
 * A free function, not just a method, because the answer is needed BEFORE the class can
 * exist: QualityTier is registered last in buildWorld (it reads the key light and the env
 * map by then), while the map's textures are parsed several awaits earlier. scene/world.js
 * calls this to filter those textures at the right tier — see ANISOTROPY below.
 */
export function detectTier() {
  const override = new URLSearchParams(window.location.search).get("quality");
  if (override === "low" || override === "high") return override;

  if (isMobileBrowser() || isHeadsetBrowser()) return "low";
  // Very small logical viewports are almost always phones that lie in the UA string.
  if (Math.min(window.screen.width, window.screen.height) < 600) return "low";
  return "high";
}

/**
 * Anisotropic filtering per tier. It costs almost nothing on desktop and does a lot for
 * the grazing-angle floor and ramp textures.
 *
 * ORDERING CONSTRAINT: THREE.Texture.DEFAULT_ANISOTROPY is read in the Texture
 * CONSTRUCTOR, so it only reaches textures created after the constructor below runs.
 * Anything loading a texture before `game.register("quality-tier", …)` — today that is
 * the map itself — has to set `texture.anisotropy` from this table explicitly. See
 * scene/world.js.
 */
export const ANISOTROPY = { high: 8, low: 1 };

export class QualityTier {
  constructor(game, opts = {}) {
    this.game = game;
    this.opts = { ...DEFAULTS, ...opts };

    this.tier = detectTier();
    // What `el.setAttribute("data-quality-tier", …)` on <a-scene> did; styles.css has no
    // selector on it today, but the console and any future CSS can still read it.
    document.body.dataset.qualityTier = this.tier;
    // Other systems (and anything debugging in the console) can read the decision.
    game.qualityTier = this.tier;

    const isHigh = this.tier === "high";
    this.isHigh = isHigh;

    const renderer = game.renderer;
    if (renderer) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, isHigh ? this.opts.desktopPixelRatio : this.opts.mobilePixelRatio));
      this.setupShadows(renderer, isHigh);
    }

    // Everything loaded from here on (soldier, weapons, remote avatars, pickups) picks
    // this up in its Texture constructor. Textures that already exist do NOT — see the
    // ordering constraint on ANISOTROPY above.
    THREE.Texture.DEFAULT_ANISOTROPY = ANISOTROPY[this.tier];

    this.setupLights(isHigh);
    this.setupEnvironment(isHigh);
    // setupBloom is gone: bloom is a system registered last (it owns the render hook), so
    // it cannot exist yet when the world is built. It reads `game.systems.get(
    // "quality-tier").bloomSettings` at its own construction instead — same decision,
    // pulled rather than pushed.

    console.info(`[quality-tier] ${this.tier} (dpr cap ${renderer ? renderer.getPixelRatio() : "n/a"})`);
  }

  /**
   * engine/game.js turns renderer.shadowMap on with the pcfsoft filter that
   * <a-scene shadow="type: pcfsoft"> used to set. On the low tier we turn the master
   * switch back off — a shadow map is an extra full scene pass per frame per casting
   * light. (A-Frame needed a two-step dance here, a `shadow` component per entity plus
   * the scene system; the renderer flag is the whole of it now.)
   */
  setupShadows(renderer, isHigh) {
    if (isHigh) return;
    renderer.shadowMap.enabled = false;
  }

  /**
   * Before anyone "optimises" the scene by deleting lights: they are not the cost.
   *
   * Measured in Chrome on this machine at a 3200x1682 drawing buffer (dpr 2), timing 30
   * renders per configuration with a readPixels between runs to force the GPU to finish:
   *
   *   full composited frame                        5.54 ms
   *     scene render, 16 lights + shadow map       1.46 ms
   *     scene render, every light .visible = false 0.87 ms   -> all 16 lights ~= 0.59 ms
   *     scene render, shadow map off               0.98 ms   -> the shadow map is ~0.48 ms
   *                                                             of that 0.59
   *     UnrealBloomPass on its own                 1.24 ms
   *
   * So the 16 lights are ~11% of the frame and the 11 point lights are free: turning them
   * off measured SLOWER (1.73 ms) than leaving them on, because changing the light count
   * forces every material to recompile. The scene is 16 draw calls and 98k triangles - it
   * is not vertex or draw-call bound either.
   *
   * The ~4.1 ms that is NOT the scene render is full-resolution post-processing: two
   * RGBA16F targets at 5.4 megapixels, an MSAA resolve, and a fullscreen tone-map. The only
   * lever with real leverage is therefore `desktopPixelRatio` above - and that trades
   * sharpness, so it is left at 2 deliberately rather than tuned behind the artist's back.
   * The shadow map is the one honest saving in here, which is why the low tier drops it.
   */
  setupLights(isHigh) {
    // The one shadow-casting light in the scene, found by name where it used to be found
    // by the #key-light selector (scene/lights.js names it).
    const keyLight = this.game.scene.getObjectByName("key-light");
    if (!keyLight) return;
    this.keyLight = keyLight;

    // Dropping castShadow on the low tier also means nothing ever allocates the
    // 2048x2048 depth target.
    keyLight.castShadow = isHigh;
    if (isHigh) {
      keyLight.shadow.mapSize.width = this.opts.desktopShadowMapSize;
      keyLight.shadow.mapSize.height = this.opts.desktopShadowMapSize;
    }
  }

  setupEnvironment(isHigh) {
    // Image-based lighting is what makes the metallic-roughness map read as metal at all,
    // so it stays on everywhere - a 2k PMREM is a one-off cost, not a per-frame one.
    // Mobile gets a touch less of it because it has no bloom to carry the highlights.
    const envMap = this.game.systems.get("environment-map");
    if (envMap) envMap.setIntensity(isHigh ? 1.0 : 0.8);
  }

  /** What bloom.js should build itself with, or null when this tier gets no bloom. */
  get bloomSettings() {
    if (!this.isHigh || !this.opts.bloom) return null;
    return { enabled: true, threshold: 0.85, strength: 0.45, radius: 0.4, samples: 2 };
  }

  dispose() {
    delete document.body.dataset.qualityTier;
  }
}
