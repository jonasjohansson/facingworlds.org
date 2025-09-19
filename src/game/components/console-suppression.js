// Console Warning Suppression
AFRAME.registerComponent("console-suppression", {
  init: function () {
    // Suppress Three.js lighting deprecation warning
    const originalWarn = console.warn;
    console.warn = function (message) {
      if (message && message.includes("useLegacyLights has been deprecated")) {
        return; // Suppress this specific warning
      }
      originalWarn.apply(console, arguments);
    };
  },
});
