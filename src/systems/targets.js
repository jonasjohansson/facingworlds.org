// targets.js — target cubes that react to hits and despawn after 10
import { createEntity } from "../utils/dom-helpers.js";
import { createBox3, createSphere } from "../utils/three-helpers.js";

AFRAME.registerSystem("target-spawner", {
  spawnRandom(count = 20, { radiusMin = 6, radiusMax = 15, y = 0.5, size = 1.0 } = {}) {
    const scene = this.sceneEl;
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = radiusMin + Math.random() * (radiusMax - radiusMin);
      const x = Math.cos(ang) * r;
      const z = Math.sin(ang) * r;
      const s = 0.6 + Math.random() * 0.8;
      const e = createEntity("a-entity", {
        position: `${x} ${y} ${z}`,
        geometry: `primitive: box; width:${s}; height:${2 + s}; depth:${s}`,
        material: `color: #4CC3D9; metalness: 0; roughness: 1`,
        shadow: "cast:true; receive:true",
        target: `maxHits:10`,
      });
      scene.appendChild(e);
    }
  },
});

AFRAME.registerComponent("target", {
  schema: {
    maxHits: { type: "int", default: 10 },
  },
  init() {
    this.hits = 0;
    this._box = createBox3();
    this._sphere = createSphere();
    this._color = new AFRAME.THREE.Color();
    // For collision queries by bullets:
    this.el.classList.add("target");
  },
  // Utility for bullets: returns true if sphere (world) intersects this target's AABB
  intersectsSphere(worldSphere) {
    const obj = this.el.object3D;
    if (!obj) return false;
    this._box.setFromObject(obj);
    return this._box.intersectsSphere(worldSphere);
  },
  takeHit() {
    this.hits++;
    // Visual feedback: lerp color to red and shrink slightly
    const mat = this.el.getObject3D("mesh");
    if (mat) {
      this._color.setHSL(Math.max(0, 0.55 - 0.55 * (this.hits / this.data.maxHits)), 0.7, 0.5);
      this.el.setAttribute("material", "color", `#${this._color.getHexString()}`);
    }
    // Scale pulse
    const s = Math.max(0.3, 1.0 - 0.05 * this.hits);
    this.el.setAttribute("scale", `${s} ${2 + s} ${s}`);

    if (this.hits >= this.data.maxHits) {
      // Despawn with a tiny fade out
      this.el.setAttribute("animation__fade", {
        property: "components.material.material.opacity",
        to: 0,
        dur: 150,
        easing: "easeOutQuad",
      });
      setTimeout(() => this.el.parentNode && this.el.parentNode.removeChild(this.el), 160);
    }
  },
});
