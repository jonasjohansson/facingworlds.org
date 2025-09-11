// /js/shooter-spawn.js
AFRAME.registerComponent("shooter-spawn", {
  init() {
    this._onLocalFire = (e) => {
      const d = e.detail || {};
      const g = d.gun || {};
      if (!g.spawnLocal) return;

      const b = document.createElement("a-entity");
      b.setAttribute("position", `${d.origin.x} ${d.origin.y} ${d.origin.z}`);
      b.setAttribute("geometry", `primitive: sphere; radius: ${g.radius}`);
      b.setAttribute("material", `color: ${g.color}; opacity: 0.95; metalness:0.2; roughness:0.4`);
      b.setAttribute("shadow", "cast:true");

      b.setAttribute("bullet", {
        vx: d.dir.x * g.speed,
        vy: d.dir.y * g.speed,
        vz: d.dir.z * g.speed,
        radius: g.radius,
        lifeSec: g.life,
        ownerId: d.ownerId || "",
        reportHits: true,
      });

      this.el.sceneEl.appendChild(b);
    };

    this.el.sceneEl.addEventListener("local-fire", this._onLocalFire);
  },
  remove() {
    this.el.sceneEl.removeEventListener("local-fire", this._onLocalFire);
  },
});
