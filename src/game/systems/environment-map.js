/**
 * Environment Map (image-based lighting)
 *
 * The map ships a metallic-roughness PBR set (FacingWorlds_occlusionRoughnessMetallic_1001.png)
 * where the blue channel drives `metalness`. A metal has no diffuse term, so with no
 * environment to reflect every metal surface in CTF-Face rendered near-black - the single
 * largest visual defect in the scene. This system loads the equirectangular space plate
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
import * as THREE from "three";

const DEFAULTS = {
  enabled: true,
  src: "assets/graphics/space_environment_2k.png",
  // Overall strength of the image-based lighting.
  intensity: 1.0,
  // The scene already has a `space-environment` system that owns the backdrop (solid
  // black + procedural star Points + asteroids). We light from the plate but leave the
  // backdrop alone by default so the two do not fight over scene.background.
  background: false,
  backgroundBlurriness: 0.0,
  backgroundIntensity: 1.0,
};

export class EnvironmentMap {
  constructor(game, opts = {}) {
    this.game = game;
    this.opts = { ...DEFAULTS, ...opts };
    this.envMap = null;
    // The PMREM output is a WebGLRenderTarget; PMREMGenerator.dispose() does NOT free it
    // (it only frees the generator's own scratch targets and materials), so we keep the
    // handle and dispose the target itself - disposing just its .texture would leak the
    // framebuffer.
    this.envRenderTarget = null;
    // TextureLoader.load is async and nothing cancels it, so its callback can land after
    // dispose() has already cleared scene.environment. Without this flag it would then
    // re-assign the environment (and build a PMREM target nothing will ever free).
    this.disposed = false;

    // `model-loaded` used to bubble to the scene, so one listener caught the world, the
    // navmesh, the soldier and every remote avatar as they streamed in. Models are
    // awaited now, but anything that spawns one mid-match (remote avatars, pickups,
    // flags) announces it on the bus so its materials still get rebuilt.
    this.onModelLoaded = (e) => {
      if (!this.envMap) return;
      const root = e.detail && (e.detail.model || e.detail.root);
      this.refreshMaterials(root);
    };
    this.offModelLoaded = game.events.on("model-loaded", this.onModelLoaded);

    if (this.opts.enabled) this.load();
  }

  /**
   * Load the equirectangular plate and prefilter it into a PMREM cube-UV texture.
   * Both the PMREMGenerator and the source texture are disposed as soon as the
   * prefiltered target exists - only the render target texture needs to stay alive.
   */
  load() {
    const renderer = this.game.renderer;
    if (!renderer) {
      console.warn("[environment-map] no renderer yet, skipping");
      return;
    }

    new THREE.TextureLoader().load(
      this.opts.src,
      (texture) => {
        if (this.disposed || !this.opts.enabled) {
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
        this.game.scene.environment = this.envMap;

        pmrem.dispose();
        texture.dispose();

        this.applyIntensity();
        // Everything that loaded before the plate did needs its shaders rebuilt for the
        // newly present environment.
        this.refreshMaterials(this.game.scene);
      },
      undefined,
      (error) => {
        console.warn("[environment-map] failed to load " + this.opts.src, error);
      }
    );
  }

  /** quality-tier's setupEnvironment(): the low tier gets a touch less IBL. */
  setIntensity(intensity) {
    this.opts.intensity = intensity;
    this.applyIntensity();
  }

  /**
   * scene.environmentIntensity is the knob three actually reads for scene-level IBL.
   */
  applyIntensity() {
    const scene = this.game.scene;
    const opts = this.opts;

    scene.environmentIntensity = opts.enabled ? opts.intensity : 0;
    scene.backgroundBlurriness = opts.backgroundBlurriness;
    scene.backgroundIntensity = opts.backgroundIntensity;

    if (opts.background && this.envMap) scene.background = this.envMap;
  }

  /**
   * Mirror the intensity onto materials that carry their own envMap and flag every PBR
   * material for a shader rebuild so it picks the environment up.
   */
  refreshMaterials(root) {
    if (!root) return;
    const intensity = this.opts.intensity;

    root.traverse((node) => {
      if (!node.isMesh || !node.material) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        if (!material.isMeshStandardMaterial && !material.isMeshPhysicalMaterial) continue;
        if (material.envMap) material.envMapIntensity = intensity;
        material.needsUpdate = true;
      }
    });
  }

  disposeEnvMap() {
    const scene = this.game.scene;
    scene.environment = null;
    scene.environmentIntensity = 1;
    if (scene.background === this.envMap) scene.background = null;
    // Disposing the render target releases its texture too.
    if (this.envRenderTarget) {
      this.envRenderTarget.dispose();
      this.envRenderTarget = null;
      this.envMap = null;
    } else if (this.envMap) {
      this.envMap.dispose();
      this.envMap = null;
    }
  }

  dispose() {
    this.disposed = true;
    if (this.offModelLoaded) this.offModelLoaded();
    this.disposeEnvMap();
  }
}
