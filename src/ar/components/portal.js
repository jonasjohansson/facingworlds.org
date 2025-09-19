// Portal component for AR
AFRAME.registerComponent("portal", {
  schema: {
    radius: { type: "number", default: 1 },
    skyTexture: { type: "string", default: "#sky" },
    animated: { type: "boolean", default: false },
  },

  init: function () {
    this.setupPortal();
  },

  setupPortal: function () {
    const el = this.el;
    const data = this.data;

    // Create the portal structure
    this.createPortalRings(el, data);
    this.createSkySphere(el, data);
    this.createGameWorld(el, data);
  },

  createPortalRings: function (parent, data) {
    // Outer ring with occlusion
    const outerRing = document.createElement("a-ring");
    outerRing.setAttribute("rotation", "0 0 0");
    outerRing.setAttribute("radius-inner", data.radius * 1.2);
    outerRing.setAttribute("radius-outer", data.radius * 4);
    outerRing.setAttribute("occlude", "");
    parent.appendChild(outerRing);

    // Inner ring border
    const innerRing = document.createElement("a-ring");
    innerRing.setAttribute("rotation", "0 0 0");
    innerRing.setAttribute("radius-inner", data.radius);
    innerRing.setAttribute("radius-outer", data.radius * 1.2);
    innerRing.setAttribute("color", "black");
    parent.appendChild(innerRing);
  },

  createSkySphere: function (parent, data) {
    // Sky sphere
    const skySphere = document.createElement("a-sphere");
    skySphere.setAttribute("radius", data.radius);
    skySphere.setAttribute("phi-length", "-180");
    skySphere.setAttribute("theta-length", "180");
    skySphere.setAttribute("rotation", "0 0 0");
    skySphere.setAttribute("src", data.skyTexture);

    // Add animation if enabled
    if (data.animated) {
      skySphere.setAttribute("animation", "property: rotation.y; to: 360; dur: 10000; loop: true; easing: linear");
    }

    parent.appendChild(skySphere);
  },

  createGameWorld: function (parent, data) {
    // Add lighting for the GLTF model
    const light = document.createElement("a-light");
    light.setAttribute("type", "directional");
    light.setAttribute("intensity", "1.5");
    light.setAttribute("position", "2 4 3");
    light.setAttribute("castShadow", "true");
    parent.appendChild(light);

    // Game world GLTF model
    const gameWorld = document.createElement("a-entity");
    gameWorld.setAttribute("gltf-model", "#facing-worlds-model");
    gameWorld.setAttribute("scale", "0.1 0.1 0.1"); // Scale down to fit in portal
    gameWorld.setAttribute("position", "0 0 0");
    gameWorld.setAttribute("rotation", "0 0 0");

    // Add animation if enabled
    if (data.animated) {
      gameWorld.setAttribute("animation", "property: rotation.y; to: 360; dur: 20000; loop: true; easing: linear");
    }

    parent.appendChild(gameWorld);
  },
});
