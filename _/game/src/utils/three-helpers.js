// three-helpers.js — Common THREE.js utilities
export function createSphere(radius = 0.08) {
  return new AFRAME.THREE.Sphere(new AFRAME.THREE.Vector3(), radius);
}

export function createBox3() {
  return new AFRAME.THREE.Box3();
}

export function createVector3(x = 0, y = 0, z = 0) {
  return new AFRAME.THREE.Vector3(x, y, z);
}

export function createQuaternion() {
  return new AFRAME.THREE.Quaternion();
}

export function createEuler() {
  return new AFRAME.THREE.Euler();
}

export function createClock() {
  return new AFRAME.THREE.Clock();
}

export function createRaycaster(origin, direction, near = 0, far = Infinity) {
  return new AFRAME.THREE.Raycaster(origin, direction, near, far);
}

export function getWorldPosition(object3D, target) {
  return object3D.getWorldPosition(target);
}

export function getWorldQuaternion(object3D, target) {
  return object3D.getWorldQuaternion(target);
}
