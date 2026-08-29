import { AR_CONFIG } from "../config/ar-config.js";
import "./occlude.js";

// Portal component for AR
AFRAME.registerComponent("portal", {
  schema: {
    radius: { type: "number", default: AR_CONFIG.portal.radius },
    skyTexture: { type: "string", default: AR_CONFIG.portal.skyTexture },
    animated: { type: "boolean", default: AR_CONFIG.portal.animated },
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
  },

  createPortalRings: function (parent, data) {
    // Outer ring with occlusion - this blocks the real world behind it
    const outerRing = document.createElement("a-ring");
    outerRing.setAttribute("rotation", "0 0 0");
    outerRing.setAttribute("radius-inner", data.radius * 1.2);
    outerRing.setAttribute("radius-outer", data.radius * 4);
    outerRing.setAttribute("occlude", "");
    outerRing.setAttribute("color", "#000000");
    outerRing.setAttribute("material", "opacity: 1.0; transparent: false; side: double");
    parent.appendChild(outerRing);

    // Inner ring border - this creates the portal frame
    const innerRing = document.createElement("a-ring");
    innerRing.setAttribute("rotation", "0 0 0");
    innerRing.setAttribute("radius-inner", data.radius);
    innerRing.setAttribute("radius-outer", data.radius * 1.2);
    innerRing.setAttribute("color", "black");
    innerRing.setAttribute("material", "opacity: 1.0; transparent: false; side: double");
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
});
