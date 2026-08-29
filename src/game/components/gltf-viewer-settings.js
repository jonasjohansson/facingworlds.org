/* global AFRAME, THREE */
/**
 * GLTF Viewer Settings - Don McCurdy Environment
 *
 * Owns the renderer's tone mapping. This is deliberately NOT expressed through
 * <a-scene renderer="toneMapping: ...; exposure: ..."> so there is exactly one source of
 * truth; A-Frame's renderer system sets those once at init and never again, and this
 * component's update() runs after it.
 *
 * Two bugs this replaces, both verified against A-Frame 1.6.0 (three r164):
 *
 * 1. `renderer.toneMappingExposure = -1.22`. A-Frame's renderer system reads its config
 *    during a-scene's connectedCallback, and 'renderstart' is not emitted until play(),
 *    long afterwards - so the negative value did survive. Under ACES that multiplier goes
 *    through `color *= exposure / 0.6` and then RRTAndODTFit, which crushes everything
 *    below mid-grey to black and folds the highlights back positive: a solarised, mostly
 *    black image. Exposure is a linear scene-referred multiplier and must be > 0.
 *
 *    Worse, the <a-scene> attribute said `toneMapping: ACESFilmicToneMapping`, but the
 *    renderer system's schema takes the *short* name and does
 *    `THREE[name.charAt(0).toUpperCase() + name.slice(1) + 'ToneMapping']`, so it looked up
 *    `THREE.ACESFilmicToneMappingToneMapping` -> undefined. index.html now passes the
 *    correct short form and the mapping itself is (re)asserted here.
 *
 * 2. `scene.environment = null`, where `scene` was `this.el` - the <a-scene> DOM element,
 *    not `this.el.object3D`. It set a stray expando on an HTMLElement and never reached
 *    three. The scene environment is now owned by the `environment-map` component.
 *
 * Also gone: `renderer.useLegacyLights = false`. That flag was removed in three r155-r165;
 * on r164 it only produces the deprecation warning that `console-suppression` was written
 * to hide.
 */
AFRAME.registerComponent("gltf-viewer-settings", {
  schema: {
    toneMapping: {
      type: "string",
      default: "ACESFilmic",
      oneOf: ["No", "Linear", "Reinhard", "Cineon", "ACESFilmic", "AgX", "Neutral"],
    },
    // Linear multiplier applied before the tone curve. 1.0 is neutral.
    exposure: { type: "number", default: 1.0 },
  },

  init: function () {
    this.apply = this.apply.bind(this);
    // The renderer exists by now (a-scene creates it in connectedCallback, before any of
    // its components initialise), but re-apply on renderstart as well so nothing that runs
    // in between can leave the first frames with the wrong curve.
    this.el.addEventListener("renderstart", this.apply);
  },

  update: function () {
    this.apply();
  },

  apply: function () {
    const renderer = this.el.renderer;
    if (!renderer) return;

    const mode = THREE[this.data.toneMapping + "ToneMapping"];
    if (mode === undefined) {
      console.warn(`[gltf-viewer-settings] unknown toneMapping "${this.data.toneMapping}", falling back to ACESFilmic`);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
    } else {
      renderer.toneMapping = mode;
    }

    renderer.toneMappingExposure = Math.max(0, this.data.exposure);
  },

  remove: function () {
    this.el.removeEventListener("renderstart", this.apply);
  },
});
