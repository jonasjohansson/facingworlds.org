import { AR_CONFIG } from "../config/ar-config.js";

// Grounding shadow for the AR model. Put this on an entity sitting at the origin
// of <ar-root>, i.e. flat on the printed marker.
//
// Two layers, because a cast shadow alone does not sell a floating object:
//
//  1. A THREE.ShadowMaterial plane. It is invisible except where the key light is
//     blocked, so it darkens the camera feed exactly under the towers and nowhere
//     else. This is what makes the model look like it is in the room instead of
//     pasted onto it.
//  2. A soft radial "contact" blob painted straight under the model. Real objects
//     hovering above a surface have an ambient-occlusion darkening that a single
//     directional shadow cannot produce, and it costs one 128px canvas texture.
//
// Both are unlit and depth-write off, so the cost is a couple of transparent
// quads - safe on a phone that is also doing camera capture and tracking.
AFRAME.registerComponent("ar-shadow-catcher", {
  schema: {
    size: { type: "number", default: AR_CONFIG.shadow.size },
    opacity: { type: "number", default: AR_CONFIG.shadow.opacity },
    blobSize: { type: "number", default: AR_CONFIG.shadow.blobSize },
    blobOpacity: { type: "number", default: AR_CONFIG.shadow.blobOpacity },
    // Matches ar-reveal so the shadow arrives with the model instead of
    // popping in at full strength on the first tracked frame.
    revealDuration: { type: "number", default: AR_CONFIG.model.reveal.duration },
  },

  init: function () {
    var data = this.data;
    var group = new THREE.Group();

    // Cast-shadow catcher. A-Frame's default plane orientation already lies in
    // the XY plane facing +Z, which is exactly the marker plane.
    var catcherGeometry = new THREE.PlaneGeometry(data.size, data.size);
    var catcherMaterial = new THREE.ShadowMaterial({
      opacity: data.opacity,
      transparent: true,
      depthWrite: false,
    });
    var catcher = new THREE.Mesh(catcherGeometry, catcherMaterial);
    catcher.receiveShadow = true;
    catcher.renderOrder = 1;
    group.add(catcher);
    this.catcher = catcher;

    // Contact blob, lifted a hair so it never z-fights the catcher.
    if (data.blobSize > 0 && data.blobOpacity > 0) {
      var blobGeometry = new THREE.PlaneGeometry(data.blobSize, data.blobSize);
      var blobMaterial = new THREE.MeshBasicMaterial({
        map: this.buildBlobTexture(),
        transparent: true,
        opacity: data.blobOpacity,
        depthWrite: false,
      });
      var blob = new THREE.Mesh(blobGeometry, blobMaterial);
      blob.position.z = 0.002;
      blob.renderOrder = 2;
      group.add(blob);
      this.blob = blob;
    }

    this.el.setObject3D("ar-shadow-catcher", group);

    // A-Frame only flips renderer.shadowMap.enabled on when something registers
    // interest. The model carries a shadow="" component, but ask anyway so the
    // catcher keeps working if that attribute is ever removed.
    var shadowSystem = this.el.sceneEl.systems.shadow;
    if (shadowSystem) {
      shadowSystem.setShadowMapEnabled(true);
    }

    this.elapsed = 0;
    this.setReveal(0);
  },

  // encantar plays/pauses everything under <ar-root> with the tracker, so these
  // hooks are the tracking state.
  play: function () {
    this.elapsed = 0;
    this.setReveal(0);
  },

  pause: function () {
    this.elapsed = 0;
    this.setReveal(0);
  },

  tick: function (time, deltaTime) {
    if (this.elapsed >= this.data.revealDuration) {
      return;
    }
    this.elapsed = Math.min(this.elapsed + deltaTime, this.data.revealDuration);
    this.setReveal(this.elapsed / this.data.revealDuration);
  },

  setReveal: function (t) {
    var p = 1 - t;
    var eased = 1 - p * p * p;
    if (this.catcher) {
      this.catcher.material.opacity = this.data.opacity * eased;
    }
    if (this.blob) {
      this.blob.material.opacity = this.data.blobOpacity * eased;
    }
  },

  buildBlobTexture: function () {
    var canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;

    var ctx = canvas.getContext("2d");
    var gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0.0, "rgba(0, 0, 0, 1)");
    gradient.addColorStop(0.45, "rgba(0, 0, 0, 0.55)");
    gradient.addColorStop(1.0, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);

    var texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  },

  remove: function () {
    var group = this.el.getObject3D("ar-shadow-catcher");
    if (!group) {
      return;
    }

    group.traverse(function (node) {
      if (!node.isMesh) {
        return;
      }
      node.geometry.dispose();
      if (node.material.map) {
        node.material.map.dispose();
      }
      node.material.dispose();
    });

    this.el.removeObject3D("ar-shadow-catcher");
    this.catcher = null;
    this.blob = null;
  },
});
