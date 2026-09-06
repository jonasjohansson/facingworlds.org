// earth-sphere.js — the planet in the CTF-Face backdrop.
//
// This is skybox furniture, not level geometry. It hangs off a pivot that is re-pinned to
// the camera every frame, so it has zero parallax however far you run along the bridge,
// and it turns on the SAME axis at the SAME rate as the starfield (both imported from
// space-environment.js) so the whole backdrop drifts as one piece. The planet keeps its
// own, much slower axial spin on top of that.
import * as THREE from "three";
import { SKY_ROTATION_DEG_PER_SEC, SKY_AXIS } from "./space-environment.js";

const DEFAULTS = {
  enabled: true,
  /**
   * Direction and distance from the camera, in world units. Distance barely matters on
   * its own - what you see is `size / |offset|` - but it has to stay clear of the map,
   * whose longest span is ~111 units, so the towers can never poke into the planet.
   */
  offset: { x: 390, y: 120, z: -300 },
  /** Sphere radius. With the default offset this subtends roughly 22 degrees. */
  size: 190,
  /** Radians/second of axial spin, on top of the shared backdrop rotation. */
  rotationSpeed: 0.005,
  /** Degrees/second the planet orbits with the stars. */
  skyRotationSpeed: SKY_ROTATION_DEG_PER_SEC,
  atmosphereColor: "#4db2ff",
  atmosphereIntensity: 0.8,
  /** Warm tint of the city lights on the unlit side. */
  nightLightColor: "#ffb45a",
  nightLightIntensity: 2.6,
  /**
   * Linear-space floor the unlit side never falls below. Without it the night
   * hemisphere renders as pure black, and because the sphere is opaque it reads as a
   * hard-edged HOLE punched through the starfield rather than as a planet. It has to be
   * a floor rather than a multiple of the albedo: night-side ocean is around 0.03
   * linear, so any sane fraction OF it is still black on screen.
   */
  earthshine: 0.024,
  /**
   * World-space direction *towards* the sun. Matches the key light's position in
   * scene/lights.js (it aims at the origin), so the terminator on the planet agrees with
   * the direction the towers are lit from.
   */
  sunDirection: { x: 70, y: 95, z: -100 },
  albedoUrl: "assets/graphics/earth_albedo_4096.jpg",
  bumpUrl: "assets/graphics/earth_bump_4096.jpg",
  cloudsUrl: "assets/graphics/earth_clouds_2048.jpg",
  nightLightsUrl: "assets/graphics/earth_night_lights_4096.jpg",
};

export class EarthSphere {
  constructor(game, opts = {}) {
    this.game = game;
    this.data = { ...DEFAULTS, ...opts };

    this.skyPivot = null;
    this.earthMesh = null;
    this.cloudsMesh = null;
    this.atmosphereMesh = null;
    this.earthMaterial = null;
    this.atmosphereMaterial = null;

    if (!this.data.enabled) return;

    // Allocated once; getWorldPosition() writes into _camPos every frame.
    this._camPos = new THREE.Vector3();
    this._axis = new THREE.Vector3(SKY_AXIS[0], SKY_AXIS[1], SKY_AXIS[2]).normalize();
    this._sunWorld = new THREE.Vector3().copy(this.data.sunDirection).normalize();
    this._sunView = new THREE.Vector3();

    // Everything the planet owns lives under this pivot. Straight off the scene: the
    // <a-entity> it used to hang from sat at the origin at identity, which is why the
    // old tick()'s worldToLocal() round trip was a no-op.
    this.skyPivot = new THREE.Group();
    this.skyPivot.name = "earth-sky-pivot";
    game.scene.add(this.skyPivot);

    this.loadTextures();
  }

  loadTextures() {
    const loader = new THREE.TextureLoader();

    let loadedCount = 0;
    const totalTextures = 4;

    const onTextureLoaded = () => {
      loadedCount++;
      if (loadedCount === totalTextures) {
        this.createEarth();
        this.createClouds();
        this.createAtmosphere();
      }
    };

    const setColorSpace = (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      onTextureLoaded();
    };

    // Load Earth textures
    this.albedoTexture = loader.load(this.data.albedoUrl, setColorSpace, undefined, (error) => {
      console.warn("Failed to load albedo texture:", error);
      onTextureLoaded();
    });

    this.bumpTexture = loader.load(this.data.bumpUrl, setColorSpace, undefined, (error) => {
      console.warn("Failed to load bump texture:", error);
      onTextureLoaded();
    });

    this.cloudsTexture = loader.load(this.data.cloudsUrl, setColorSpace, undefined, (error) => {
      console.warn("Failed to load clouds texture:", error);
      onTextureLoaded();
    });

    this.nightLightsTexture = loader.load(this.data.nightLightsUrl, setColorSpace, undefined, (error) => {
      console.warn("Failed to load night lights texture:", error);
      onTextureLoaded();
    });
  }

  createEarth() {
    const geometry = new THREE.SphereGeometry(this.data.size, 96, 96);

    const material = new THREE.MeshStandardMaterial({
      map: this.albedoTexture,
      bumpMap: this.bumpTexture,
      bumpScale: 0.03,
      // The night-lights texture was loaded and then never used. Wiring it as an
      // emissive map is what turns the unlit two thirds of the disc from a black blob
      // into something worth looking at - and the shader below masks it to the dark
      // side, so the day side is unaffected.
      emissiveMap: this.nightLightsTexture,
      emissive: new THREE.Color(this.data.nightLightColor),
      emissiveIntensity: this.data.nightLightIntensity,
      roughness: 1.0,
      metalness: 0.0,
    });

    this.addCustomShaders(material);

    this.earthMesh = new THREE.Mesh(geometry, material);
    this.earthMesh.position.copy(this.data.offset);
    this.earthMesh.frustumCulled = false;

    // Add Earth's axial tilt (23.5 degrees)
    this.earthMesh.rotation.z = (23.5 / 360) * 2 * Math.PI;

    // Set initial rotational position for good viewing angle
    this.earthMesh.rotateY(-0.3);

    this.earthMaterial = material;
    this.skyPivot.add(this.earthMesh);
  }

  addCustomShaders(material) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.tClouds = { value: this.cloudsTexture };
      shader.uniforms.tClouds.value.wrapS = THREE.RepeatWrapping;
      shader.uniforms.uv_xOffset = { value: 0 };
      // View-space direction towards the sun, refreshed every frame in update().
      shader.uniforms.uSunViewDir = { value: new THREE.Vector3(0, 0, 1) };
      shader.uniforms.uEarthshine = { value: this.data.earthshine };

      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        `
        #include <common>
        uniform sampler2D tClouds;
        uniform float uv_xOffset;
        uniform vec3 uSunViewDir;
        uniform float uEarthshine;
      `
      );

      // <emissivemap_fragment> runs after <normal_fragment_begin>, so `normal` (view
      // space, already normalised) is in scope here.
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        `
        #include <emissivemap_fragment>

        // Cloud shadows cast onto the surface below.
        float cloudsMapValue = texture2D(tClouds, vec2(vMapUv.x - uv_xOffset, vMapUv.y)).r;
        diffuseColor.rgb *= max(1.0 - cloudsMapValue, 0.2);

        // City lights only exist on the night side, and cloud cover smothers them.
        float sunFacing = dot(normal, uSunViewDir);
        float nightMask = smoothstep(0.14, -0.20, sunFacing);
        totalEmissiveRadiance *= nightMask * max(1.0 - cloudsMapValue * 0.85, 0.05);

        // Earthshine: a cold floor plus a little of the albedo, so the dark side keeps a
        // readable silhouette and some land/sea contrast instead of becoming a black disc
        // punched through the starfield.
        vec3 earthshine = vec3(0.58, 0.72, 1.0) * uEarthshine + diffuseColor.rgb * 0.28;
        totalEmissiveRadiance += earthshine * nightMask;
      `
      );

      material.userData.shader = shader;
    };
  }

  createClouds() {
    const cloudsGeometry = new THREE.SphereGeometry(this.data.size * 1.005, 96, 96);
    const cloudsMaterial = new THREE.MeshStandardMaterial({
      alphaMap: this.cloudsTexture,
      transparent: true,
      // A transparent shell that writes depth is an invisible occluder for everything
      // drawn after it in the transparent pass. Same latent bug as the atmosphere below.
      depthWrite: false,
      roughness: 1.0,
      metalness: 0.0,
    });

    this.cloudsMesh = new THREE.Mesh(cloudsGeometry, cloudsMaterial);
    this.cloudsMesh.position.copy(this.earthMesh.position);
    this.cloudsMesh.rotation.copy(this.earthMesh.rotation);
    this.cloudsMesh.frustumCulled = false;
    this.skyPivot.add(this.cloudsMesh);
  }

  createAtmosphere() {
    // 96 segments, not 32: at this angular size a 32-segment sphere shows a visibly
    // faceted silhouette, and the silhouette is the entire point of a rim-glow shell.
    // The shell/planet radius RATIO has to reach the shader too - the glow is positioned
    // relative to the PLANET's limb, not the shell's, so the shader needs to know how far
    // apart the two silhouettes are. Keep the two uses of this constant together.
    const shellRatio = 1.12;
    const atmosphereGeometry = new THREE.SphereGeometry(this.data.size * shellRatio, 96, 96);

    // The old shell was BackSide, so the only part of it you could ever see was the thin
    // annulus outside the planet's silhouette - and the ONLY thing masking the rest was
    // the depth buffer. That is a bad bet 500 units out from a camera whose near plane is
    // 0.005: depth precision there is essentially exhausted, the Earth and the shell's far
    // surface resolve to the same depth in a patchy, view-dependent way, and what you
    // actually got on screen was a hard-edged polygonal wedge of blown-out blue hanging off
    // the planet's limb. Verified in Chrome: hiding this mesh removed the wedge, and
    // disabling depthTest on it turned the wedge into a full blown-out disc.
    //
    // So the shell is now FrontSide with a rim-only shader. Its near surface is always in
    // front of the planet, so it always passes the depth test, and the *shader* - not the
    // depth buffer - decides where the glow lives: nothing over the disc, a band just
    // outside the silhouette, nothing at the shell's own edge.
    const atmosphereMaterial = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 eyeVector;

        void main() {
          vec4 mvPos = modelViewMatrix * vec4( position, 1.0 );
          vNormal = normalize( normalMatrix * normal );
          eyeVector = normalize(mvPos.xyz);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        varying vec3 eyeVector;
        uniform float atmPowFactor;
        uniform float atmMultiplier;
        uniform float atmShellRatio;
        uniform vec3 atmColorBase;
        uniform vec3 uSunViewDir;

        void main() {
          // facing = 1 at the centre of the shell's disc, 0 at its silhouette.
          float facing = clamp(-dot(vNormal, eyeVector), 0.0, 1.0);

          // Impact parameter of this view ray, measured in PLANET radii: 0 at the centre
          // of the disc, exactly 1.0 on the planet's own limb, atmShellRatio at the
          // shell's silhouette. Placing the band in this coordinate rather than in
          // facing is the point: facing is a coordinate on the SHELL, so a band placed
          // in it sits out at the shell's radius and the glow detaches from the planet
          // with a black gap between the two - a hard blue arc floating clear of the
          // limb, i.e. exactly the glass bubble this shader is trying not to be.
          float b = atmShellRatio * sqrt(max(0.0, 1.0 - facing * facing));

          // 0 on the planet's limb, 1 at the shell's outer edge.
          float outward = clamp((b - 1.0) / max(atmShellRatio - 1.0, 1e-4), 0.0, 1.0);
          float glow = pow(1.0 - outward, atmPowFactor);
          // Inside the silhouette the shell hangs in front of an opaque planet: keep a
          // thin haze right at the limb, and nothing across the rest of the disc.
          glow *= smoothstep(1.0 - (atmShellRatio - 1.0) * 1.4, 1.0, b);
          // Air only glows where the sun hits it. Without this the rim is equally bright
          // all the way round, which stops reading as atmosphere and starts reading as a
          // glass bubble drawn around the planet.
          glow *= mix(0.1, 1.0, smoothstep(-0.35, 0.4, dot(vNormal, uSunViewDir)));
          vec3 atmColor = mix(atmColorBase, vec3(1.0), (1.0 - outward) * 0.35);
          // Alpha 1 with AdditiveBlending (SrcAlpha, One) makes the contribution exactly
          // rgb, so the brightness is linear in atmMultiplier instead of quadratic.
          gl_FragColor = vec4(atmColor * glow * atmMultiplier, 1.0);
        }
      `,
      uniforms: {
        // Falloff across the [planet limb -> shell edge] band. 3.5 puts the visible
        // half-width of the rim at roughly 4% of the planet's radius, which reads as a
        // thin bright line of air on the limb rather than a ring drawn around it.
        atmPowFactor: { value: 3.5 },
        // `atmosphereIntensity` used to be accepted by the schema and then dropped on
        // the floor; it now scales the rim. The band peaks at glow ~1.0 now that it is
        // anchored to the limb, so 1.2 puts the peak a little under 1.0 linear at the
        // default intensity of 0.8 - bright, not clipped.
        atmMultiplier: { value: 1.2 * this.data.atmosphereIntensity },
        atmShellRatio: { value: shellRatio },
        atmColorBase: { value: new THREE.Color(this.data.atmosphereColor) },
        uSunViewDir: { value: new THREE.Vector3(0, 0, 1) },
      },
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
      transparent: true,
      // Additive and transparent, and depthWrite was left at its default of TRUE. That
      // made it a full-screen-scale invisible depth occluder: anything sorted behind it in
      // the transparent pass (stars, coronas, sprites, other transparent map surfaces) got
      // depth-rejected and vanished - the shape of an intermittent "black region" artefact.
      depthWrite: false,
    });

    this.atmosphereMaterial = atmosphereMaterial;
    this.atmosphereMesh = new THREE.Mesh(atmosphereGeometry, atmosphereMaterial);
    this.atmosphereMesh.position.copy(this.earthMesh.position);
    this.atmosphereMesh.frustumCulled = false;
    this.skyPivot.add(this.atmosphereMesh);
  }

  update(dt) {
    if (!this.data.enabled || !this.skyPivot) return;

    const camera = this.game.camera;

    // Pin to the camera: a skybox has no parallax. World position, because the camera is
    // (or will be) a child of the rig; the pivot is a child of the scene, so nothing more
    // is needed. The old `Math.min(deltaTime, 100)` clamp is gone — engine/game.js clamps
    // dt to 1/20 s for every system, which is tighter.
    camera.getWorldPosition(this._camPos);
    this.skyPivot.position.copy(this._camPos);

    // Orbit with the starfield.
    this.skyPivot.rotateOnWorldAxis(this._axis, THREE.MathUtils.degToRad(this.data.skyRotationSpeed) * dt);

    if (!this.earthMesh) return;

    // Axial spin, and clouds a touch faster so the shadow offset actually moves.
    this.earthMesh.rotation.y += this.data.rotationSpeed * dt;
    if (this.cloudsMesh) {
      this.cloudsMesh.rotation.y += this.data.rotationSpeed * 2 * dt;
    }

    const shader = this.earthMaterial && this.earthMaterial.userData.shader;
    if (shader) {
      // The cloud-shadow lookup samples the clouds texture in the Earth's own UV space,
      // so the offset is the *relative* spin between the two meshes. This was pinned at
      // 0 before, which made the shadows a static, wrong-by-construction overlay.
      if (this.cloudsMesh) {
        const relative = (this.cloudsMesh.rotation.y - this.earthMesh.rotation.y) / (Math.PI * 2);
        shader.uniforms.uv_xOffset.value = relative - Math.floor(relative);
      }
      // World -> view space for the terminator. transformDirection() uses only the
      // rotation part of the matrix, which is what a direction wants.
      this._sunView.copy(this._sunWorld).transformDirection(camera.matrixWorldInverse);
      shader.uniforms.uSunViewDir.value.copy(this._sunView);
    }

    // The atmosphere needs the same view-space sun direction, and it must not be gated on
    // the Earth material having finished compiling - it has its own material.
    if (this.atmosphereMaterial) {
      this._sunView.copy(this._sunWorld).transformDirection(camera.matrixWorldInverse);
      this.atmosphereMaterial.uniforms.uSunViewDir.value.copy(this._sunView);
    }
  }

  dispose() {
    if (this.skyPivot) {
      this.game.scene.remove(this.skyPivot);
    }
    [this.earthMesh, this.cloudsMesh, this.atmosphereMesh].forEach((mesh) => {
      if (!mesh) return;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) mesh.material.dispose();
    });
    [this.albedoTexture, this.bumpTexture, this.cloudsTexture, this.nightLightsTexture].forEach((texture) => {
      if (texture) texture.dispose();
    });
  }
}
