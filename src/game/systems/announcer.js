// announcer.js — UT99's voice.
//
// The SERVER decides when it speaks: first blood, multi-kills, sprees, captures and the
// end of a match are all things only the server knows, and the rules for each are read
// out of Botpack's own script (see server/announcer-rules.js). This file receives a name
// and plays a file. It works nothing out.
//
// ONE ELEMENT, deliberately. An announcer that overlaps itself is not an announcer — it
// is two people shouting. A new line cuts the one before it, which is what UT99 does when
// a capture lands on top of a killing spree.
//
// Ported from components/announcer.js. The only change is the wrapper: the A-Frame system
// whose init() warmed the cache is the `Announcer` class below, registered under the same
// name (`ut-announcer`) in core/main-three.js. `announce()` is still a plain module
// function, because network.js calls it from a message handler and never had a system
// instance to go through.
import { ANNOUNCEMENTS, announcementUrl } from "../../shared/announcer.js";

const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

let voice = null;
const warmed = new Map();

function element() {
  if (voice) return voice;
  voice = new Audio();
  voice.volume = 0.65;
  return voice;
}

/**
 * Pull every line down at load. They are small — the whole set is a few hundred KB — and
 * the alternative is that the first "First Blood" of a session arrives silently while its
 * file is still on the wire, which is precisely the one you want to hear.
 */
export function preloadAnnouncer() {
  if (isMobileDevice) return;
  for (const key of ANNOUNCEMENTS) {
    if (warmed.has(key)) continue;
    const url = announcementUrl(key);
    if (!url) continue;
    const a = new Audio(url);
    a.preload = "auto";
    warmed.set(key, a);
  }
}

export function announce(key) {
  if (isMobileDevice) return;
  // The key comes off the wire, so it is checked against the generated list rather than
  // pasted into a path. A server that said "../../etc/passwd" would get null.
  const url = announcementUrl(key);
  if (!url) return;
  const a = element();
  a.src = url;
  a.currentTime = 0;
  a.play().catch(() => {});
}

/** The whole system: warm the cache once. There is nothing to do per frame. */
export class Announcer {
  constructor() {
    try {
      preloadAnnouncer();
    } catch (e) {
      console.warn("[announcer] preload failed:", e);
    }
  }
}
