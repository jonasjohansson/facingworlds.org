// Earth Sphere Component - Distant planet with atmosphere
AFRAME.registerComponent("earth-sphere", {
  schema: {
    enabled: { type: "boolean", default: true },
    distance: { type: "number", default: 100 },
    size: { type: "number", default: 5 },
    rotationSpeed: { type: "number", default: 0.01 },
    atmosphereColor: { type: "color", default: "#4db2ff" },
    atmosphereIntensity: { type: "number", default: 0.3 },
  },

  init() {
    if (!this.data.enabled) return;

    this.loadTextures();
  },

  loadTextures() {
    const THREE = AFRAME.THREE;
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

    // Load Earth textures
    this.albedoTexture = loader.load("assets/graphics/earth_albedo_4096.jpg", onTextureLoaded, undefined, (error) => {
      console.warn("Failed to load albedo texture:", error);
      onTextureLoaded();
    });

    this.bumpTexture = loader.load("assets/graphics/earth_bump_4096.jpg", onTextureLoaded, undefined, (error) => {
      console.warn("Failed to load bump texture:", error);
      onTextureLoaded();
    });

    this.cloudsTexture = loader.load("assets/graphics/earth_clouds_2048.jpg", onTextureLoaded, undefined, (error) => {
      console.warn("Failed to load clouds texture:", error);
      onTextureLoaded();
    });

    this.nightLightsTexture = loader.load("assets/graphics/earth_night_lights_4096.jpg", onTextureLoaded, undefined, (error) => {
      console.warn("Failed to load night lights texture:", error);
      onTextureLoaded();
    });

    // Set texture properties
    this.albedoTexture.colorSpace = THREE.SRGBColorSpace;
    this.bumpTexture.colorSpace = THREE.SRGBColorSpace;
    this.cloudsTexture.colorSpace = THREE.SRGBColorSpace;
    this.nightLightsTexture.colorSpace = THREE.SRGBColorSpace;
  },

  createEarth() {
    const THREE = AFRAME.THREE;

    // Create Earth geometry with more detail
    const geometry = new THREE.SphereGeometry(this.data.size, 64, 64);

    // Create enhanced Earth material with multiple textures
    const material = new THREE.MeshStandardMaterial({
      map: this.albedoTexture, // Albedo texture
      bumpMap: this.bumpTexture, // Bump map for terrain detail
      bumpScale: 0.03, // Small scale to avoid over-lighting
    });

    // Add custom shader effects step by step
    this.addCustomShaders(material);

    // Create Earth mesh
    this.earthMesh = new THREE.Mesh(geometry, material);
    this.earthMesh.position.set(this.data.distance, 10, -80);

    // Add Earth's axial tilt (23.5 degrees)
    this.earthMesh.rotation.z = (23.5 / 360) * 2 * Math.PI;

    // Set initial rotational position for good viewing angle
    this.earthMesh.rotateY(-0.3);

    this.el.object3D.add(this.earthMesh);
  },

  addCustomShaders(material) {
    const THREE = AFRAME.THREE;

    // Add custom shader effects using onBeforeCompile
    material.onBeforeCompile = (shader) => {
      // Add uniforms for cloud shadows
      shader.uniforms.tClouds = { value: this.cloudsTexture };
      shader.uniforms.tClouds.value.wrapS = THREE.RepeatWrapping;
      shader.uniforms.uv_xOffset = { value: 0 };

      // Add cloud shadow uniforms
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        `
        #include <common>
        uniform sampler2D tClouds;
        uniform float uv_xOffset;
      `
      );

      // Add cloud shadows effect (simplified)
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        `
        #include <emissivemap_fragment>

        // Cloud shadows calculation
        float cloudsMapValue = texture2D(tClouds, vec2(vMapUv.x - uv_xOffset, vMapUv.y)).r;
        diffuseColor.rgb *= max(1.0 - cloudsMapValue, 0.2);
      `
      );

      // Store shader reference for animation
      material.userData.shader = shader;
    };
  },

  createClouds() {
    const THREE = AFRAME.THREE;

    // Create clouds geometry (slightly larger than earth)
    const cloudsGeometry = new THREE.SphereGeometry(this.data.size * 1.005, 64, 64);
    const cloudsMaterial = new THREE.MeshStandardMaterial({
      alphaMap: this.cloudsTexture, // Use clouds as alpha map
      transparent: true,
    });

    // Create clouds mesh
    this.cloudsMesh = new THREE.Mesh(cloudsGeometry, cloudsMaterial);
    this.cloudsMesh.position.copy(this.earthMesh.position);
    this.cloudsMesh.rotation.copy(this.earthMesh.rotation);
    this.el.object3D.add(this.cloudsMesh);
  },

  createAtmosphere() {
    const THREE = AFRAME.THREE;

    // Create atmosphere geometry (larger sphere)
    const atmosphereGeometry = new THREE.SphereGeometry(this.data.size * 1.25, 32, 32);

    // Create custom shader material for atmosphere
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
        uniform float atmOpacity;
        uniform float atmPowFactor;
        uniform float atmMultiplier;

        void main() {
          float dotP = dot( vNormal, eyeVector );
          float factor = pow(dotP, atmPowFactor) * atmMultiplier;
          vec3 atmColor = vec3(0.35 + dotP/4.5, 0.35 + dotP/4.5, 1.0);
          gl_FragColor = vec4(atmColor, atmOpacity) * factor;
        }
      `,
      uniforms: {
        atmOpacity: { value: 0.7 },
        atmPowFactor: { value: 4.1 },
        atmMultiplier: { value: 9.5 },
      },
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      transparent: true,
    });

    // Create atmosphere mesh
    this.atmosphereMesh = new THREE.Mesh(atmosphereGeometry, atmosphereMaterial);
    this.atmosphereMesh.position.copy(this.earthMesh.position);
    this.el.object3D.add(this.atmosphereMesh);
  },

  tick(time, deltaTime) {
    if (!this.data.enabled || !this.earthMesh) return;

    // Rotate Earth slowly
    this.earthMesh.rotation.y += (this.data.rotationSpeed * deltaTime) / 1000;

    // Rotate clouds slightly faster than earth for shadow effect
    if (this.cloudsMesh) {
      this.cloudsMesh.rotation.y += (this.data.rotationSpeed * 2 * deltaTime) / 1000;
    }
  },

  remove() {
    if (this.earthMesh) {
      this.el.object3D.remove(this.earthMesh);
    }
    if (this.cloudsMesh) {
      this.el.object3D.remove(this.cloudsMesh);
    }
    if (this.atmosphereMesh) {
      this.el.object3D.remove(this.atmosphereMesh);
    }
  },
});
