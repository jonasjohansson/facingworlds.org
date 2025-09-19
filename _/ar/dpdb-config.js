window.AFRAME = window.AFRAME || {};
window.AFRAME.DPDB_URL = "./dpdb.json";

const originalFetch = window.fetch;
window.fetch = function (url, options) {
  if (typeof url === "string" && url.includes("dpdb.webvr.rocks/dpdb.json")) {
    url = "./dpdb.json";
  }
  return originalFetch(url, options);
};

const originalXHROpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (method, url, ...args) {
  if (typeof url === "string" && url.includes("dpdb.webvr.rocks/dpdb.json")) {
    url = "./dpdb.json";
  }
  return originalXHROpen.call(this, method, url, ...args);
};

window.addEventListener("DOMContentLoaded", function () {
  if (window.AFRAME && window.AFRAME.utils && window.AFRAME.utils.device) {
    const originalLoadDPDB = window.AFRAME.utils.device.loadDPDB;
    if (originalLoadDPDB) {
      window.AFRAME.utils.device.loadDPDB = function () {
        return originalLoadDPDB.call(this, "./dpdb.json");
      };
    }
  }
});
