import { AR_CONFIG } from "../config/ar-config.js";

// Lighting rig for the AR scene. Put this on <ar-root> so the lights live in
// marker space: the key direction then stays fixed relative to the print, and
// encantar's visibility toggle turns them off along with the model.
//
// Three ingredients, and each one is doing a specific job:
//
//  1. An image-based environment (PMREM from an equirectangular PNG). The map
//     ships a metallic-roughness texture set, and metals have no diffuse term -
//     with scene.environment left null every metal surface renders near-black.
//     This is the single biggest visual fix in the AR scene.
//  2. A directional key that casts the grounding shadow. In AR the model has to
//     look like it is sitting under the viewer's own ceiling light, so the key is
//     warm-white, mostly overhead (+Z in marker space) and raked to one side.
//  3. A hemisphere fill standing in for the room: cool light from above, warm
//     bounce off whatever surface the print is lying on.
//
// Two lights is the whole budget. The phone is already running camera capture,
// feature tracking and rendering at the same time.
AFRAME.registerComponent("ar-lighting", {
  schema: {
    envMap: { type: "string", default: AR_CONFIG.lighting.envMap },
    envIntensity: { type: "number", default: AR_CONFIG.lighting.envIntensity },
    toneMapping: { type: "string", default: AR_CONFIG.lighting.toneMapping },
    exposure: { type: "number", default: AR_CONFIG.lighting.exposure },
    keyColor: { type: "color", default: AR_CONFIG.lighting.key.color },
    keyIntensity: { type: "number", default: AR_CONFIG.lighting.key.intensity },
    keyPosition: { type: "vec3", default: AR_CONFIG.lighting.key.position },
    fillSky: { type: "color", default: AR_CONFIG.lighting.fill.sky },
    fillGround: { type: "color", default: AR_CONFIG.lighting.fill.ground },
    fillIntensity: { type: "number", default: AR_CONFIG.lighting.fill.intensity },
    shadowMapSize: { type: "number", default: AR_CONFIG.shadow.mapSize },
    shadowExtent: { type: "number", default: AR_CONFIG.shadow.extent },
  },

  init: function () {
    var data = this.data;
    var root = this.el.object3D;

    this.disableDefaultLights();

    // Key light -------------------------------------------------------------
    var key = new THREE.DirectionalLight(new THREE.Color(data.keyColor), data.keyIntensity);
    key.position.set(data.keyPosition.x, data.keyPosition.y, data.keyPosition.z);
    key.castShadow = true;

    // The target has to be a real node under ar-root, otherwise three falls back
    // to a detached target at the world origin and the light direction swings
    // around as the tracker matrix changes.
    key.target.position.set(0, 0, 0);
    root.add(key.target);

    var extent = data.shadowExtent;
    key.shadow.camera.left = -extent;
    key.shadow.camera.right = extent;
    key.shadow.camera.top = extent;
    key.shadow.camera.bottom = -extent;
    key.shadow.camera.near = 0.1;
    key.shadow.camera.far = 12;
    key.shadow.mapSize.set(data.shadowMapSize, data.shadowMapSize);
    // normalBias beats a plain depth bias here: it kills acne on the map's many
    // grazing surfaces without peter-panning the contact shadow off the print.
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.01;
    key.shadow.camera.updateProjectionMatrix();

    this.el.setObject3D("ar-key-light", key);
    this.keyLight = key;

    // Fill ------------------------------------------------------------------
    var fill = new THREE.HemisphereLight(
      new THREE.Color(data.fillSky),
      new THREE.Color(data.fillGround),
      data.fillIntensity
    );
    fill.position.set(0, 0, 1);
    this.el.setObject3D("ar-fill-light", fill);
    this.fillLight = fill;

    // Environment and tone mapping -------------------------------------------
    this.envTarget = null;
    var sceneEl = this.el.sceneEl;
    if (sceneEl.renderer) {
      this.setupRenderer();
    } else {
      this.onRenderStart = this.setupRenderer.bind(this);
      sceneEl.addEventListener("renderstart", this.onRenderStart, { once: true });
    }
  },

  setupRenderer: function () {
    this.applyToneMapping();
    this.buildEnvironment();
  },

  // The <a-scene renderer=""> attribute is not usable here: encantar calls
  // scene.setAttribute("renderer", { alpha: true }) while the scene is
  // initialising, and because `renderer` is a system rather than a component
  // that call rewrites the whole attribute string. Anything declared in markup
  // is gone by the time the renderer is built, so set it on the renderer.
  applyToneMapping: function () {
    var renderer = this.el.sceneEl.renderer;
    if (!renderer) {
      return;
    }

    var modes = {
      no: THREE.NoToneMapping,
      linear: THREE.LinearToneMapping,
      reinhard: THREE.ReinhardToneMapping,
      cineon: THREE.CineonToneMapping,
      ACESFilmic: THREE.ACESFilmicToneMapping,
    };

    var mode = modes[this.data.toneMapping];
    if (mode === undefined) {
      console.warn("[ar-lighting] unknown tone mapping:", this.data.toneMapping);
      return;
    }

    renderer.toneMapping = mode;
    renderer.toneMappingExposure = this.data.exposure;
  },

  // Load the equirectangular source, run it through PMREM once, hand the result
  // to the scene. Falls back to a tiny procedural room gradient if the image is
  // missing or the connection is metered - a wrong-but-present environment still
  // beats no environment, because no environment means black metal.
  buildEnvironment: function () {
    var self = this;
    var sceneEl = this.el.sceneEl;
    var renderer = sceneEl.renderer;
    if (!renderer) {
      return;
    }

    sceneEl.object3D.environmentIntensity = this.data.envIntensity;

    if (!this.data.envMap || this.preferLightweightEnvironment()) {
      this.applyEnvironment(this.proceduralRoomTexture());
      return;
    }

    new THREE.TextureLoader().load(
      this.data.envMap,
      function (texture) {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        self.applyEnvironment(texture);
      },
      undefined,
      function () {
        console.warn("[ar-lighting] env map failed to load, using procedural room");
        self.applyEnvironment(self.proceduralRoomTexture());
      }
    );
  },

  // PMREM the source, assign to the scene, then drop everything we no longer
  // need. The generator and the source texture are both large.
  applyEnvironment: function (texture) {
    var sceneEl = this.el.sceneEl;
    var renderer = sceneEl.renderer;
    if (!renderer || !this.el.isConnected) {
      texture.dispose();
      return;
    }

    var pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    var target = pmrem.fromEquirectangular(texture);
    pmrem.dispose();
    texture.dispose();

    if (this.envTarget) {
      this.envTarget.dispose();
    }
    this.envTarget = target;
    sceneEl.object3D.environment = target.texture;
    sceneEl.object3D.environmentIntensity = this.data.envIntensity;
  },

  // A 3.8 MB equirect is a lot to ask of a phone that is also streaming camera
  // frames. On a metered or memory-poor device, synthesise the environment
  // instead: 64x32 pixels, no network, and PMREM smooths it out anyway.
  preferLightweightEnvironment: function () {
    var connection = navigator.connection;
    if (connection && connection.saveData) {
      return true;
    }
    return typeof navigator.deviceMemory === "number" && navigator.deviceMemory <= 2;
  },

  proceduralRoomTexture: function () {
    var canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 32;

    var ctx = canvas.getContext("2d");
    var gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0.0, "#fff4e6"); // ceiling / lamp
    gradient.addColorStop(0.45, "#9db0c6"); // walls
    gradient.addColorStop(0.55, "#5d5a54"); // horizon
    gradient.addColorStop(1.0, "#2e2b27"); // floor
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    var texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  },

  /**
   * A-Frame injects two default lights (an ambient #BBB at 1.0 and a shadow-casting
   * directional at 0.6) into every scene, and only removes them when its own `light`
   * COMPONENT registers a user light. This rig builds raw THREE.js lights and attaches
   * them with setObject3D, so `light`'s registerLight() never fires and the defaults
   * stay - the scene then runs four lights instead of the two documented above, with an
   * extra flat ambient lift washing out the model (and a second shadow-casting light
   * costing a whole extra shadow pass on a phone).
   *
   * The system attribute has to be set as a complete style string: setAttribute on
   * <a-scene> forwards the raw value straight to System.buildData, so the
   * (name, prop, value) form would rewrite the whole attribute.
   */
  disableDefaultLights: function () {
    var sceneEl = this.el.sceneEl;
    if (!sceneEl) return;

    // Stops setupDefaultLights() from injecting them on the scene's "loaded" event.
    sceneEl.setAttribute("light", "defaultLightsEnabled: false");

    // ...and clear any that were injected before this component initialised.
    var injected = sceneEl.querySelectorAll("[data-aframe-default-light]");
    for (var i = 0; i < injected.length; i++) {
      if (injected[i].parentNode) injected[i].parentNode.removeChild(injected[i]);
    }
    var lightSystem = sceneEl.systems && sceneEl.systems.light;
    if (lightSystem) lightSystem.defaultLights = false;
  },

  remove: function () {
    var sceneEl = this.el.sceneEl;

    if (this.onRenderStart) {
      sceneEl.removeEventListener("renderstart", this.onRenderStart);
      this.onRenderStart = null;
    }

    if (this.keyLight) {
      this.el.object3D.remove(this.keyLight.target);
      this.keyLight.shadow.dispose();
      this.el.removeObject3D("ar-key-light");
      this.keyLight = null;
    }

    if (this.fillLight) {
      this.el.removeObject3D("ar-fill-light");
      this.fillLight = null;
    }

    if (this.envTarget) {
      if (sceneEl.object3D.environment === this.envTarget.texture) {
        sceneEl.object3D.environment = null;
      }
      this.envTarget.dispose();
      this.envTarget = null;
    }
  },
});
