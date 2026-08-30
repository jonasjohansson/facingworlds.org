// Screen-space UI for the AR page.
//
// Everything here is plain DOM over the camera feed - no WebGL, no A-Frame primitive,
// no third-party gimmick. Three pieces:
//
//  * a boot overlay, which is the only thing on screen until the map is ready and
//    which is also where a camera-permission failure has to be explained;
//  * a scan hint that is visible exactly while the marker is not being tracked;
//  * a spectator chip reporting whether the live feed is connected and how many
//    players are on the table;
//  * the match: the CTF score, and a roster of who is playing, in their team
//    colour. The figures on the table are three millimetres tall, so this is
//    the only place a name is actually readable - and the score is the one
//    number that has to be legible without looking away from the print.
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
  const match = document.getElementById("ar-match");
  const scoreRed = document.getElementById("ar-score-red");
  const scoreBlue = document.getElementById("ar-score-blue");
  const scoreNote = document.getElementById("ar-score-note");
  const roster = document.getElementById("ar-roster");

  // The roster is rebuilt only when the table says something in it changed, but
  // "changed" is judged loosely up there (a join marks it dirty, and so does a
  // rename), so the rendered text is compared here too. Nothing touches the DOM
  // for a list that is already correct.
  let rosterKey = "";

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

    /**
     * The CTF score. Shown from the first `hello` that carries a match and never
     * hidden again, because a match that has started is the thing being watched.
     *
     * @param {{scores: {red: number, blue: number}, capLimit: number,
     *          state: string, winner: string|null}} state
     */
    setMatch(state) {
      if (!match || !state) {
        return;
      }
      match.hidden = false;
      const scores = state.scores || { red: 0, blue: 0 };
      if (scoreRed) {
        scoreRed.textContent = String(scores.red || 0);
      }
      if (scoreBlue) {
        scoreBlue.textContent = String(scores.blue || 0);
      }
      if (scoreNote) {
        // Only two things are worth the width: who won, and what winning takes.
        scoreNote.textContent =
          state.state === "ended" && state.winner
            ? `${state.winner} wins`
            : state.capLimit
              ? `to ${state.capLimit}`
              : "";
      }
    },

    /**
     * The player list, in team colour.
     *
     * Rebuilt wholesale rather than diffed: this is at most a couple of dozen
     * short rows and it changes on a join, a death or a capture — never per
     * frame — so a diff would be more code than the browser spends on innerHTML.
     *
     * @param {{id: string, name: string, team: string|null, alive: boolean,
     *          flag: string|null}[]} rows
     */
    setRoster(rows) {
      if (!roster) {
        return;
      }
      const list = rows || [];
      // Cheap identity of the rendered result, so an unchanged list is free.
      const key = list.map((r) => `${r.id}:${r.name}:${r.team}:${r.alive ? 1 : 0}:${r.flag || ""}`).join("|");
      if (key === rosterKey) {
        return;
      }
      rosterKey = key;

      roster.replaceChildren(
        ...list.map((row) => {
          const li = document.createElement("li");
          if (row.team) {
            li.dataset.team = row.team;
          }
          if (!row.alive) {
            li.classList.add("is-dead");
          }

          const dot = document.createElement("span");
          dot.className = "dot";
          li.appendChild(dot);

          // textContent, never innerHTML: names come off the wire from other
          // players and are not markup.
          const who = document.createElement("span");
          who.className = "who";
          who.textContent = row.name || "player";
          li.appendChild(who);

          if (row.flag) {
            const carrying = document.createElement("span");
            carrying.className = "carrying";
            carrying.dataset.flag = row.flag;
            carrying.textContent = "flag";
            li.appendChild(carrying);
          }
          return li;
        })
      );
    },
  };
}
