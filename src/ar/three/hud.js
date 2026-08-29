// Screen-space UI for the AR page.
//
// Everything here is plain DOM over the camera feed - no WebGL, no A-Frame primitive,
// no third-party gimmick. Three pieces:
//
//  * a boot overlay, which is the only thing on screen until the map is ready and
//    which is also where a camera-permission failure has to be explained;
//  * a scan hint that is visible exactly while the marker is not being tracked;
//  * a spectator chip reporting whether the live feed is connected and how many
//    players are on the table.
//
// The markup lives in ar/index.html so it paints before any module runs; this module
// only wires it. Elements are looked up once and cached - no per-frame DOM work.

export function createHud() {
  const viewport = document.getElementById("ar-viewport");
  const container = document.getElementById("ar-hud");
  const scan = document.getElementById("ar-scan");
  const scanSub = document.getElementById("ar-scan-sub");
  const chip = document.getElementById("ar-spectator");
  const chipText = document.getElementById("ar-spectator-text");
  const boot = document.getElementById("ar-boot");
  const bootText = document.getElementById("ar-boot-text");

  let bootDismissed = false;

  const dismissBoot = () => {
    if (bootDismissed || !boot) {
      return;
    }
    bootDismissed = true;
    boot.classList.add("is-gone");
  };

  return {
    viewport,
    container,

    /** The scene is built and the session is live. */
    ready() {
      dismissBoot();
      if (scan) {
        scan.hidden = false;
      }
    },

    /**
     * Non-fatal: the page runs, but something is missing. It goes under the scan hint
     * rather than back over the camera feed - that line is on screen exactly while the
     * user is hunting for the marker, which is when they can read it, and the boot
     * overlay has already been dismissed by ready().
     */
    warn(message) {
      dismissBoot();
      if (scanSub) {
        scanSub.textContent = message;
      }
      console.warn("[ar]", message);
    },

    /** Fatal: no camera, no session, nothing to show. Leave the message up. */
    fail(message) {
      bootDismissed = true;
      if (boot) {
        boot.classList.remove("is-gone");
        boot.classList.add("is-error");
      }
      if (bootText) {
        bootText.textContent = message;
      }
    },

    setTracking(tracking) {
      if (scan) {
        scan.hidden = tracking;
      }
    },

    /** @param {"connecting"|"online"|"offline"} state */
    setSpectatorStatus(state, count) {
      if (!chip || !chipText) {
        return;
      }
      chip.dataset.state = state;
      if (state === "online") {
        chipText.textContent = count === 1 ? "1 player live" : `${count} players live`;
      } else if (state === "connecting") {
        chipText.textContent = "connecting";
      } else {
        chipText.textContent = "offline";
      }
    },
  };
}
