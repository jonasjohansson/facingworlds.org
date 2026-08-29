/* global AFRAME, THREE */
import { bloomReady } from "./lighting/bloom.js";

/**
 * Quality Tier
 *
 * Desktop-first. Picks a tier once and applies everything that can still be changed
 * after the WebGL context exists: pixel ratio, shadow map, image-based lighting strength,
 * texture anisotropy and post-processing.
 *
 * What it deliberately does NOT touch: `precision` and `antialias`. A-Frame reads those
 * from the <a-scene renderer="..."> attribute inside setupRenderer(), which runs during the
 * element's connectedCallback - at HTML parse time, long before any component initialises -
 * and they are baked into the WebGL context at creation. So index.html carries them
 * statically. `antialias: auto` is already device-aware on A-Frame's side (it resolves to
 * `!isMobile`), and `precision: high` is kept everywhere because the previous `low` setting
 * gave lowp fragment shaders and visible banding on every platform.
 *
 * Override for testing with ?quality=low / ?quality=high in the URL.
 */
AFRAME.registerComponent("quality-tier", {
  schema: {
    // Cap on window.devicePixelRatio. Retina at 3x costs 9x the fill rate for a
    // barely visible gain.
    desktopPixelRatio: { type: "number", default: 2 },
    mobilePixelRatio: { type: "number", default: 1.5 },
    desktopShadowMapSize: { type: "number", default: 2048 },
    bloom: { type: "boolean", default: true },
    keyLight: { type: "selector", default: "#key-light" },
  },

  init: function () {
    const el = this.el;
    const renderer = el.renderer;

    this.tier = this.detectTier();
    el.setAttribute("data-quality-tier", this.tier);
    // Other components (and anything debugging in the console) can read the decision.
    el.qualityTier = this.tier;

    const isHigh = this.tier === "high";

    if (renderer) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, isHigh ? this.data.desktopPixelRatio : this.data.mobilePixelRatio));
      this.setupShadows(renderer, isHigh);
    }

    // Anisotropic filtering costs almost nothing on desktop and does a lot for the
    // grazing-angle floor and ramp textures.
    THREE.Texture.DEFAULT_ANISOTROPY = isHigh ? 8 : 1;

    this.setupLights(isHigh);
    this.setupEnvironment(isHigh);
    this.setupBloom(isHigh);

    console.info(`[quality-tier] ${this.tier} (dpr cap ${renderer ? renderer.getPixelRatio() : "n/a"})`);
  },

  /**
   * "high" = desktop, "low" = mobile/tablet/headset browsers.
   */
  detectTier: function () {
    const override = new URLSearchParams(window.location.search).get("quality");
    if (override === "low" || override === "high") return override;

    const device = AFRAME.utils.device;
    if (device.isMobile() || device.isMobileVR()) return "low";
    // Very small logical viewports are almost always phones that lie in the UA string.
    if (Math.min(window.screen.width, window.screen.height) < 600) return "low";
    return "high";
  },

  /**
   * A-Frame turns renderer.shadowMap.enabled on via the `shadow` *component* (there is one
   * on #world and one on every remote avatar); the `shadow` *system* on <a-scene> owns the
   * filter type and the master switch. On the low tier we turn the master switch off - a
   * shadow map is an extra full scene pass per frame per casting light.
   *
   * Note the system's update() only reacts to `enabled`, so the filter type has to come
   * from the static <a-scene shadow="type: pcfsoft"> attribute (applied in the system's
   * init) rather than from a runtime setAttribute.
   */
  setupShadows: function (renderer, isHigh) {
    if (isHigh) return;

    // On <a-scene>, setAttribute for a *system* forwards the raw value straight to
    // System.buildData, so it has to be a complete style string - the (name, prop, value)
    // form would rewrite the whole attribute to "enabled".
    this.el.setAttribute("shadow", "enabled: false; type: pcf");
    renderer.shadowMap.enabled = false;
  },

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
   * lever with real leverage is therefore `desktopPixelRatio` below - and that trades
   * sharpness, so it is left at 2 deliberately rather than tuned behind the artist's back.
   * The shadow map is the one honest saving in here, which is why the low tier drops it.
   */
  setupLights: function (isHigh) {
    const keyLight = this.data.keyLight;
    if (!keyLight) return;

    // The one shadow-casting light in the scene. Dropping castShadow on the low tier also
    // means nothing ever allocates the 2048x2048 depth target.
    keyLight.setAttribute("light", "castShadow", isHigh);
    if (isHigh) {
      keyLight.setAttribute("light", "shadowMapWidth", this.data.desktopShadowMapSize);
      keyLight.setAttribute("light", "shadowMapHeight", this.data.desktopShadowMapSize);
    }
  },

  setupEnvironment: function (isHigh) {
    // Image-based lighting is what makes the metallic-roughness map read as metal at all,
    // so it stays on everywhere - a 2k PMREM is a one-off cost, not a per-frame one.
    // Mobile gets a touch less of it because it has no bloom to carry the highlights.
    this.el.setAttribute("environment-map", "intensity", isHigh ? 1.0 : 0.8);
  },

  setupBloom: function (isHigh) {
    if (!isHigh || !this.data.bloom) return;

    // bloom.js resolves the three postprocessing addons dynamically; only enable the
    // component once we know it actually registered.
    bloomReady.then((available) => {
      if (!available || !this.el.isConnected) return;
      this.el.setAttribute("bloom", {
        enabled: true,
        threshold: 0.85,
        strength: 0.45,
        radius: 0.4,
        samples: 2,
      });
    });
  },
});
