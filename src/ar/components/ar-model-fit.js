import { AR_CONFIG } from "../config/ar-config.js";

// Normalise a loaded glTF to a known size and pivot.
//
// The Facing Worlds map is authored at UT scale (roughly 111 x 47 x 42 units)
// and its root node carries a baked translation, so a hardcoded `scale` on the
// entity is a magic number that breaks the moment the export changes. This
// measures the model instead and fits it to a footprint expressed in marker
// units, then recentres it so the idle spin turns around the map's own axis
// rather than some offset point.
//
// Runs once per model-loaded, on the mesh's local frame, so it is independent of
// whatever transform encantar has put on <ar-root> at that moment.
AFRAME.registerComponent("ar-model-fit", {
  schema: {
    // Target footprint (longest horizontal axis) in the parent's units.
    size: { type: "number", default: AR_CONFIG.model.size },
    // Which model-space axis points up. The map is authored Y-up.
    up: { type: "string", default: "y" },
    anisotropy: { type: "number", default: AR_CONFIG.model.anisotropy },
  },

  init: function () {
    this.onModelLoaded = this.fit.bind(this);
    this.el.addEventListener("model-loaded", this.onModelLoaded);
    if (this.el.getObject3D("mesh")) {
      this.fit();
    }
  },

  fit: function () {
    var mesh = this.el.getObject3D("mesh");
    if (!mesh) {
      return;
    }

    var box = this.localBounds(mesh);
    if (box.isEmpty()) {
      return;
    }

    var size = new THREE.Vector3();
    var center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    var up = this.data.up;
    var footprint = up === "y" ? Math.max(size.x, size.z) : Math.max(size.x, size.y);
    if (footprint <= 0) {
      return;
    }

    var scale = this.data.size / footprint;
    this.el.object3D.scale.setScalar(scale);

    // Pull the model back onto its own centre horizontally and drop its base to
    // zero vertically, so the parent can place the base with a plain position.
    mesh.position.set(-center.x, -center.y, -center.z);
    if (up === "y") {
      mesh.position.y = -box.min.y;
    } else {
      mesh.position.z = -box.min.z;
    }

    this.sharpenTextures(mesh);
    this.el.emit("ar-model-fitted", { scale: scale, size: size }, false);
  },

  // A-Frame leaves texture anisotropy at 1. In AR the map is nearly always seen
  // at a grazing angle, which is the one case where that is clearly visible, so
  // bump it - clamped to the device's real limit rather than assumed.
  sharpenTextures: function (mesh) {
    var renderer = this.el.sceneEl.renderer;
    if (!renderer || this.data.anisotropy <= 1) {
      return;
    }

    var anisotropy = Math.min(this.data.anisotropy, renderer.capabilities.getMaxAnisotropy());
    var maps = ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap"];

    mesh.traverse(function (node) {
      if (!node.isMesh || !node.material) {
        return;
      }
      var materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach(function (material) {
        maps.forEach(function (slot) {
          var texture = material[slot];
          if (texture && texture.anisotropy !== anisotropy) {
            texture.anisotropy = anisotropy;
            texture.needsUpdate = true;
          }
        });
      });
    });
  },

  // Union of every child geometry's bounding box, expressed in `root`'s local
  // space. THREE.Box3.setFromObject would give world space, which is useless
  // here because the tracker matrix above us changes every frame.
  localBounds: function (root) {
    var box = new THREE.Box3();
    var toLocal = new THREE.Matrix4();
    var childToLocal = new THREE.Matrix4();

    root.updateWorldMatrix(true, true);
    toLocal.copy(root.matrixWorld).invert();

    root.traverse(function (node) {
      if (!node.isMesh || !node.geometry) {
        return;
      }
      if (!node.geometry.boundingBox) {
        node.geometry.computeBoundingBox();
      }
      childToLocal.multiplyMatrices(toLocal, node.matrixWorld);
      box.union(node.geometry.boundingBox.clone().applyMatrix4(childToLocal));
    });

    return box;
  },

  remove: function () {
    this.el.removeEventListener("model-loaded", this.onModelLoaded);
  },
});
