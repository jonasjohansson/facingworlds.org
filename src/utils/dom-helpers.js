// dom-helpers.js — DOM and A-Frame utilities
export function waitForElement(selector) {
  return new Promise((resolve) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const obs = new MutationObserver(() => {
      const el2 = document.querySelector(selector);
      if (el2) {
        obs.disconnect();
        resolve(el2);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  });
}

export function waitForSceneLoaded(scene) {
  return new Promise((res) => {
    if (scene.hasLoaded) return res();
    scene.addEventListener("loaded", () => res(), { once: true });
  });
}

export function waitForModelLoaded(element) {
  return new Promise((res) => {
    const mesh = element && element.getObject3D("mesh");
    if (mesh) return res(mesh);
    element && element.addEventListener("model-loaded", () => res(element.getObject3D("mesh")), { once: true });
  });
}

export function createEntity(tag = "a-entity", attributes = {}) {
  const entity = document.createElement(tag);
  Object.entries(attributes).forEach(([key, value]) => {
    if (typeof value === "object") {
      entity.setAttribute(key, value);
    } else {
      entity.setAttribute(key, value);
    }
  });
  return entity;
}

export function addClass(element, className) {
  element.classList.add(className);
}

export function setDataAttribute(element, key, value) {
  element.dataset[key] = value;
}
