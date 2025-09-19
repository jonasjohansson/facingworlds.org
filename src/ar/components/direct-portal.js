// Direct Portal - Uses Three.js CircleGeometry for guaranteed circular shape
AFRAME.registerComponent("direct-portal", {
  schema: {
    radius: { type: "number", default: 0.5 },
    animated: { type: "boolean", default: false },
    texture: { type: "string", default: "#sky" }
  },

  init: function () {
    console.log("Direct Portal initialized with radius:", this.data.radius);
    this.createPortal();
  },

  createPortal: function () {
    const el = this.el;
    const data = this.data;

    // Wait for the element to be ready
    el.addEventListener('loaded', () => {
      this.setupGeometry();
    });

    // If already loaded, set up immediately
    if (el.object3D) {
      this.setupGeometry();
    }
  },

  setupGeometry: function () {
    const el = this.el;
    const data = this.data;

    // Create circular geometry
    const geometry = new THREE.CircleGeometry(data.radius, 32);
    
    // Get the texture
    const texture = el.sceneEl.systems.material.getTexture(data.texture);
    
    // Create material
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide
    });

    // Create mesh
    const mesh = new THREE.Mesh(geometry, material);
    
    // Replace the existing mesh
    el.setObject3D('mesh', mesh);

    // Add glow effect if animated
    if (data.animated) {
      this.addGlowEffect();
    }

    console.log("Direct Portal geometry created with radius:", data.radius);
  },

  addGlowEffect: function () {
    const el = this.el;
    
    // Add CSS glow effect
    if (!document.getElementById("direct-portal-glow")) {
      const style = document.createElement("style");
      style.id = "direct-portal-glow";
      style.textContent = `
        .direct-portal-glow {
          filter: drop-shadow(0 0 20px rgba(0, 255, 255, 0.8));
          animation: direct-glow 2s ease-in-out infinite alternate;
        }
        @keyframes direct-glow {
          from { filter: drop-shadow(0 0 20px rgba(0, 255, 255, 0.5)); }
          to { filter: drop-shadow(0 0 40px rgba(0, 255, 255, 1)); }
        }
      `;
      document.head.appendChild(style);
    }

    el.classList.add("direct-portal-glow");
  },

  update: function () {
    console.log("Direct Portal updating with new data:", this.data);
    this.setupGeometry();
  }
});
