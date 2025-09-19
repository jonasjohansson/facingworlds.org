// Working Portal Component - Simple and reliable
AFRAME.registerComponent("working-portal", {
  schema: {
    radius: { type: "number", default: 0.5 },
    animated: { type: "boolean", default: false },
    texture: { type: "string", default: "#sky" },
  },

  init: function () {
    console.log("Working Portal initialized");
    this.setupPortal();
  },

  setupPortal: function () {
    const el = this.el;
    const data = this.data;

    // Set up the material
    el.setAttribute("material", {
      src: data.texture,
      transparent: true,
      opacity: 0.9,
    });

    // Apply CSS mask
    this.applyMask();
  },

  applyMask: function () {
    const el = this.el;
    const data = this.data;

    // Add CSS styles if not already added
    if (!document.getElementById("working-portal-styles")) {
      const style = document.createElement("style");
      style.id = "working-portal-styles";
      style.textContent = `
        .working-portal {
          border-radius: 50%;
          overflow: hidden;
        }
        .working-portal-glow {
          box-shadow: 0 0 30px rgba(0, 255, 255, 0.6);
          animation: working-glow 2s ease-in-out infinite alternate;
        }
        @keyframes working-glow {
          from { box-shadow: 0 0 20px rgba(0, 255, 255, 0.5); }
          to { box-shadow: 0 0 50px rgba(0, 255, 255, 0.9); }
        }
      `;
      document.head.appendChild(style);
    }

    // Apply classes
    el.classList.add("working-portal");

    if (data.animated) {
      el.classList.add("working-portal-glow");
    } else {
      el.classList.remove("working-portal-glow");
    }

    // Set dynamic radius using both clip-path and border-radius
    const radiusPercent = Math.round(data.radius * 100);
    el.style.clipPath = `circle(${radiusPercent}%)`;
    el.style.borderRadius = `${radiusPercent}%`;
    
    // Force a re-render by updating the material
    const currentMaterial = el.getAttribute("material") || {};
    el.setAttribute("material", {
      ...currentMaterial,
      src: data.texture,
      transparent: true,
      opacity: 0.9
    });
    
    console.log("Applied mask with radius:", radiusPercent, "%");
  },

  update: function () {
    console.log("Working Portal updating:", this.data);
    this.setupPortal();
  },

  tick: function () {
    // Keep the mask applied
    if (this.el.classList.contains("working-portal")) {
      const radiusPercent = Math.round(this.data.radius * 100);
      this.el.style.clipPath = `circle(${radiusPercent}%)`;
      this.el.style.borderRadius = `${radiusPercent}%`;
    }
  },

  // Alternative approach using Three.js geometry
  createCircularGeometry: function () {
    const el = this.el;
    const data = this.data;
    
    // Create a circular plane geometry
    const geometry = new THREE.CircleGeometry(1, 32);
    const material = new THREE.MeshBasicMaterial({
      map: new THREE.TextureLoader().load(data.texture),
      transparent: true,
      opacity: 0.9
    });
    
    // Replace the mesh
    const mesh = new THREE.Mesh(geometry, material);
    el.setObject3D('mesh', mesh);
    
    console.log("Created circular geometry with radius:", data.radius);
  },
});
