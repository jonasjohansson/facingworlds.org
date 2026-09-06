// launch.mjs — one headed Chromium launcher for every Playwright probe.
//
// Headed on purpose: the headless shell renders through SwiftShader, whose frame times
// and shading are not the GPU's. But nobody wants the window in their face, so it is
// opened pushed to the bottom-right corner: macOS keeps a sliver of it on screen (a
// fully off-screen window would stop compositing), and that sliver is enough to keep
// the real GPU rendering at full rate. Screenshots come from the page, not the screen,
// so they are unaffected.
import { chromium } from "playwright";

// --mute-audio silences the tab's output only: the AudioContext still runs, so anything a
// probe measures about sound (play counts, timing) is unaffected — nobody hears it.
export const QUIET_ARGS = ["--window-position=4000,3000", "--window-size=1280,720", "--mute-audio"];

/** chromium.launch with the quiet window flags; pass any other launch options through. */
export function launchQuiet(options = {}) {
  return chromium.launch({ headless: false, ...options, args: [...QUIET_ARGS, ...(options.args || [])] });
}
