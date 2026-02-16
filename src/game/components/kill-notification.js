// kill-notification.js — Shows kill notifications on screen
AFRAME.registerComponent("kill-notification", {
  schema: {
    enabled: { type: "boolean", default: true },
    duration: { type: "number", default: 3000 }, // 3 seconds
    fadeInDuration: { type: "number", default: 500 }, // 0.5 seconds
    fadeOutDuration: { type: "number", default: 1000 }, // 1 second
  },

  init() {
    this.notifications = [];

    // Listen for kill events (store bound ref for proper cleanup)
    this._onLocalKill = this.onLocalKill.bind(this);
    this.el.sceneEl.addEventListener("local-kill", this._onLocalKill);
  },

  onLocalKill(event) {
    if (!this.data.enabled) return;

    const victimName = event.detail.victimName || "Unknown Player";
    this.showKillNotification(victimName);
  },

  showKillNotification(victimName) {
    // Create notification element
    const notification = document.createElement("div");
    notification.style.position = "fixed";
    notification.style.top = "50%";
    notification.style.left = "50%";
    notification.style.transform = "translate(-50%, -50%)";
    notification.style.backgroundColor = "rgba(0, 0, 0, 0.8)";
    notification.style.color = "#ff6b6b";
    notification.style.padding = "20px 40px";
    notification.style.borderRadius = "10px";
    notification.style.fontSize = "24px";
    notification.style.fontWeight = "bold";
    notification.style.fontFamily = "Arial, sans-serif";
    notification.style.textAlign = "center";
    notification.style.zIndex = "10000";
    notification.style.pointerEvents = "none";
    notification.style.opacity = "0";
    notification.style.transition = `opacity ${this.data.fadeInDuration}ms ease-in`;
    notification.style.border = "2px solid #ff6b6b";
    notification.style.boxShadow = "0 0 20px rgba(255, 107, 107, 0.5)";

    notification.textContent = `You killed ${victimName}`;

    document.body.appendChild(notification);
    this.notifications.push(notification);

    // Fade in
    setTimeout(() => {
      notification.style.opacity = "1";
    }, 10);

    // Fade out and remove
    setTimeout(() => {
      notification.style.transition = `opacity ${this.data.fadeOutDuration}ms ease-out`;
      notification.style.opacity = "0";

      setTimeout(() => {
        if (notification.parentNode) {
          notification.parentNode.removeChild(notification);
        }
        const index = this.notifications.indexOf(notification);
        if (index > -1) {
          this.notifications.splice(index, 1);
        }
      }, this.data.fadeOutDuration);
    }, this.data.duration);
  },

  remove() {
    // Clean up any remaining notifications
    this.notifications.forEach((notification) => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    });
    this.notifications = [];

    // Remove event listener
    this.el.sceneEl.removeEventListener("local-kill", this._onLocalKill);
  },
});
