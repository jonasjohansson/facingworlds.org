// Simple Portal Shader - More reliable version
AFRAME.registerComponent("simple-portal-shader", {
  schema: {
    portalTexture: { type: "string", default: "#sky" },
    portalRadius: { type: "number", default: 0.5 },
    edgeSoftness: { type: "number", default: 0.1 },
    portalCenter: { type: "vec2", default: { x: 0.5, y: 0.5 } },
    animated: { type: "boolean", default: false },
  },

  init: function () {
    console.log("Simple Portal Shader initialized");
    this.setupSimplePortal();
  },

  setupSimplePortal: function () {
    const el = this.el;
    const data = this.data;

    // Create a simple circular mask using CSS
    this.createCircularMask();

    // Set up the plane with the texture
    el.setAttribute("material", {
      src: data.portalTexture,
      transparent: true,
      opacity: 0.9,
    });
  },

  createCircularMask: function () {
    const el = this.el;
    const data = this.data;

    // Add CSS for circular mask
    if (!document.getElementById("portal-mask-style")) {
      const style = document.createElement("style");
      style.id = "portal-mask-style";
      style.textContent = `
        .portal-mask {
          border-radius: 50%;
          overflow: hidden;
        }
        .portal-glow {
          box-shadow: 0 0 20px rgba(0, 255, 255, 0.5);
          animation: portal-glow 2s ease-in-out infinite alternate;
        }
        @keyframes portal-glow {
          from { box-shadow: 0 0 20px rgba(0, 255, 255, 0.5); }
          to { box-shadow: 0 0 40px rgba(0, 255, 255, 0.8); }
        }
      `;
      document.head.appendChild(style);
    }

    // Apply the mask class
    el.classList.add("portal-mask");

    // Set dynamic clip-path based on radius
    const radiusPercent = Math.round(data.portalRadius * 100);
    el.style.clipPath = `circle(${radiusPercent}%)`;

    // Add glow effect
    if (data.animated) {
      el.classList.add("portal-glow");
    } else {
      el.classList.remove("portal-glow");
    }
  },

  update: function () {
    console.log("Simple Portal Shader updating with data:", this.data);
    // Recreate mask when data changes
    this.setupSimplePortal();
  },

  tick: function () {
    // Ensure the mask is applied correctly
    if (this.el.classList.contains("portal-mask")) {
      const radiusPercent = Math.round(this.data.portalRadius * 100);
      this.el.style.clipPath = `circle(${radiusPercent}%)`;
    }
  },
});

// Alternative: Canvas-based portal effect
AFRAME.registerComponent("canvas-portal", {
  schema: {
    portalTexture: { type: "string", default: "#sky" },
    portalRadius: { type: "number", default: 0.5 },
  },

  init: function () {
    console.log("Canvas Portal initialized");
    this.createCanvasPortal();
  },

  createCanvasPortal: function () {
    const el = this.el;
    const data = this.data;

    // Create canvas
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");

    // Create circular gradient mask
    const gradient = ctx.createRadialGradient(256, 256, 0, 256, 256, 256 * data.portalRadius);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.8, "rgba(255,255,255,0.8)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");

    // Fill with gradient
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 512, 512);

    // Convert to texture
    const texture = new THREE.CanvasTexture(canvas);

    // Apply to plane
    el.setAttribute("material", {
      src: data.portalTexture,
      transparent: true,
      opacity: 0.9,
    });
  },

  update: function () {
    console.log("Canvas Portal updating with data:", this.data);
    // Recreate canvas when data changes
    this.createCanvasPortal();
  },
});
