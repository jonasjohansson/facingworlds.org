AFRAME.registerComponent("shooter", {
  init: function () {
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space") {
        this.shoot();
      }
    });
  },
  shoot: function () {
    const scene = this.el.sceneEl;
    const cam = this.el.querySelector("[camera]");

    // get camera forward direction
    const dir = new THREE.Vector3();
    cam.object3D.getWorldDirection(dir);

    // spawn position just in front of camera
    const pos = new THREE.Vector3();
    cam.object3D.getWorldPosition(pos);
    pos.add(dir.clone().multiplyScalar(1.5));

    // create bullet
    const bullet = document.createElement("a-sphere");
    bullet.setAttribute("radius", 0.1);
    bullet.setAttribute("color", "yellow");
    bullet.setAttribute("position", pos);
    scene.appendChild(bullet);

    // move bullet forward each frame
    const velocity = dir.multiplyScalar(0.3);
    function tick() {
      pos.add(velocity);
      bullet.setAttribute("position", pos);
      // remove when far away
      if (Math.abs(pos.x) > 500 || Math.abs(pos.y) > 500 || Math.abs(pos.z) > 500) {
        bullet.remove();
        scene.removeEventListener("tick", tick);
      }
    }
    scene.addEventListener("tick", tick);
  },
});
