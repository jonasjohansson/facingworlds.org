/* global AFRAME, THREE */
/**
 * Environment Map (image-based lighting)
 *
 * The map ships a metallic-roughness PBR set (FacingWorlds_occlusionRoughnessMetallic_1001.png)
 * where the blue channel drives `metalness`. A metal has no diffuse term, so with no
 * environment to reflect every metal surface in CTF-Face rendered near-black - the single
 * largest visual defect in the scene. This component loads the equirectangular space plate
 * that already ships in assets/graphics/, runs it through THREE.PMREMGenerator and assigns
 * the prefiltered result to the THREE.Scene's `environment`, which gives all
 * MeshStandardMaterial/MeshPhysicalMaterial surfaces both an irradiance and a radiance term.
 *
 * Note on the old code: `gltf-viewer-settings` used to do `scene.environment = null` where
 * `scene` was the <a-scene> *DOM element*, not `sceneEl.object3D`. It set a stray expando on
 * an HTMLElement and never touched three at all.
 *
 * Intensity: since three r163 the scene environment is scaled by `scene.environmentIntensity`
 * and NOT by `material.envMapIntensity` (the renderer overwrites the uniform for any standard
 * material whose own `envMap` is null), so `intensity` here drives the scene property. We
 * still mirror it onto materials so anything that brings its own envMap stays consistent.
 */
AFRAME.registerComponent("environment-map", {
  schema: {
    enabled: { type: "boolean", default: true },
    src: { type: "string", default: "assets/graphics/space_environment_2k.png" },
    // Overall strength of the image-based lighting.
    intensity: { type: "number", default: 1.0 },
    // The scene already has a `space-environment` component that owns the backdrop
    // (solid black + procedural star Points + asteroids). We light from the plate but
    // leave the backdrop alone by default so the two do not fight over scene.background.
    background: { type: "boolean", default: false },
    backgroundBlurriness: { type: "number", default: 0.0 },
    backgroundIntensity: { type: "number", default: 1.0 },
  },

  init: function () {
    this.envMap = null;
    // The PMREM output is a WebGLRenderTarget; PMREMGenerator.dispose() does NOT free it
    // (it only frees the generator's own scratch targets and materials), so we keep the
    // handle and dispose the target itself - disposing just its .texture would leak the
    // framebuffer.
    this.envRenderTarget = null;
    this.onModelLoaded = this.onModelLoaded.bind(this);
    // model-loaded bubbles, so one listener on the scene catches the world, the navmesh,
    // the soldier and every remote avatar as they stream in.
    this.el.addEventListener("model-loaded", this.onModelLoaded);

    if (this.data.enabled) {
      this.load();
    }
  },

  update: function (oldData) {
    const data = this.data;

    if (oldData.enabled !== undefined && oldData.src !== data.src) {
      this.disposeEnvMap();
      if (data.enabled) this.load();
      return;
    }

    if (oldData.enabled === true && data.enabled === false) {
      this.disposeEnvMap();
      return;
    }
    if (oldData.enabled === false && data.enabled === true) {
      this.load();
      return;
    }

    this.applyIntensity();
  },

  /**
   * Load the equirectangular plate and prefilter it into a PMREM cube-UV texture.
   * Both the PMREMGenerator and the source texture are disposed as soon as the
   * prefiltered target exists - only the render target texture needs to stay alive.
   */
  load: function () {
    const el = this.el;
    const renderer = el.renderer;
    if (!renderer) {
      console.warn("[environment-map] no renderer yet, skipping");
      return;
    }

    new THREE.TextureLoader().load(
      this.data.src,
      (texture) => {
        if (!this.data.enabled) {
          texture.dispose();
          return;
        }

        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.colorSpace = THREE.SRGBColorSpace;

        const pmrem = new THREE.PMREMGenerator(renderer);
        pmrem.compileEquirectangularShader();
        const target = pmrem.fromEquirectangular(texture);

        this.envRenderTarget = target;
        this.envMap = target.texture;
        el.object3D.environment = this.envMap;

        pmrem.dispose();
        texture.dispose();

        this.applyIntensity();
        // Everything that loaded before the plate did needs its shaders rebuilt for the
        // newly present environment.
        this.refreshMaterials(el.object3D);
      },
      undefined,
      (error) => {
        console.warn("[environment-map] failed to load " + this.data.src, error);
      }
    );
  },

  /**
   * scene.environmentIntensity is the knob three actually reads for scene-level IBL.
   */
  applyIntensity: function () {
    const object3D = this.el.object3D;
    const data = this.data;

    object3D.environmentIntensity = data.enabled ? data.intensity : 0;
    object3D.backgroundBlurriness = data.backgroundBlurriness;
    object3D.backgroundIntensity = data.backgroundIntensity;

    if (data.background && this.envMap) {
      object3D.background = this.envMap;
    }
  },

  onModelLoaded: function (evt) {
    if (!this.envMap) return;
    const object3D = (evt.detail && evt.detail.model) || evt.target.object3D;
    this.refreshMaterials(object3D);
  },

  /**
   * Mirror the intensity onto materials that carry their own envMap and flag every PBR
   * material for a shader rebuild so it picks the environment up.
   */
  refreshMaterials: function (root) {
    if (!root) return;
    const intensity = this.data.intensity;

    root.traverse((node) => {
      if (!node.isMesh || !node.material) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (let i = 0; i < materials.length; i++) {
        const material = materials[i];
        if (!material.isMeshStandardMaterial && !material.isMeshPhysicalMaterial) continue;
        if (material.envMap) material.envMapIntensity = intensity;
        material.needsUpdate = true;
      }
    });
  },

  disposeEnvMap: function () {
    this.el.object3D.environment = null;
    this.el.object3D.environmentIntensity = 1;
    if (this.el.object3D.background === this.envMap) {
      this.el.object3D.background = null;
    }
    // Disposing the render target releases its texture too.
    if (this.envRenderTarget) {
      this.envRenderTarget.dispose();
      this.envRenderTarget = null;
      this.envMap = null;
    } else if (this.envMap) {
      this.envMap.dispose();
      this.envMap = null;
    }
  },

  remove: function () {
    this.el.removeEventListener("model-loaded", this.onModelLoaded);
    this.disposeEnvMap();
  },
});
