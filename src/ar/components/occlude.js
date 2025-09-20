// Occlude component for AR
AFRAME.registerComponent("occlude", {
  init: function () {
    var el = this.el;
    var applyOcclusion = function () {
      var mesh = el.getObject3D("mesh");
      if (mesh && mesh.material) {
        mesh.material.colorWrite = false;
        mesh.material.needsUpdate = true;
      }
    };

    el.addEventListener("object3dset", applyOcclusion);
    applyOcclusion();
  },
});
