// lib.mjs — the pieces every Playwright probe in this directory needs.
//
// The probes were written one per migration task, each with its own browser, its own base
// URL and its own way of printing a verdict. scripts/pw/parity.mjs runs all four in one
// session, so what they had in common moved here: the base URL, the "am I being run
// directly?" test that lets a probe be both a CLI and a module, and the check list they
// all report through.
//
// The browser itself stays in launch.mjs — it is the one thing the ground rules pin down
// (headed, always: the headless shell renders through SwiftShader and neither its frame
// times nor its rasterisation are the GPU's).
import { pathToFileURL } from "node:url";

/** The static server. `node scripts/pw/x.mjs http://host:port` and FW_BASE both work. */
export function baseUrl(argv = process.argv) {
  const arg = argv.slice(2).find((a) => a.startsWith("http"));
  return (arg || process.env.FW_BASE || "http://localhost:8080").replace(/\/$/, "");
}

/** True when this module file is what node was asked to run, rather than an import. */
export function isMain(metaUrl) {
  return process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href;
}

/**
 * A check list. Every probe collects `{ name, value, ok }` rows through it and hands the
 * array back to its caller; parity.mjs concatenates four of them into one table.
 *
 *   const checks = createChecks();
 *   checks.row("bots joined", `${n} bodies`, n >= 9);
 */
export function createChecks() {
  const rows = [];
  return {
    rows,
    row(name, value, ok) {
      rows.push({ name, value: String(value), ok: !!ok });
      return ok;
    },
    get failed() {
      return rows.filter((r) => !r.ok).length;
    },
  };
}

/** The one table format. `rows` is what createChecks() collected, in order. */
export function printChecks(rows, { title = "", group = false } = {}) {
  const w = Math.max(5, ...rows.map((r) => (group ? r.group.length + 2 + r.name.length : r.name.length)));
  const v = Math.max(5, ...rows.map((r) => r.value.length));
  if (title) console.log(`\n${title}`);
  console.log(`${"CHECK".padEnd(w)}  OK    ${"VALUE".padEnd(v)}`);
  console.log(`${"-".repeat(w)}  ----  ${"-".repeat(v)}`);
  let last = null;
  for (const r of rows) {
    const label = group ? (r.group === last ? " ".repeat(r.group.length + 2) : `${r.group}  `) + r.name : r.name;
    if (group) last = r.group;
    console.log(`${label.padEnd(w)}  ${r.ok ? " ok " : "FAIL"}  ${r.value}`);
  }
}

/** Collect page errors and console errors onto one array, the way every probe does. */
export function watchErrors(page, errors = [], { consoleErrors = true } = {}) {
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  if (consoleErrors)
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });
  return errors;
}

/**
 * The DOM overlays that sit across a screenshot on both pages: the pointer-lock prompt,
 * the credits panel and the HUD. Hidden rather than removed, so nothing re-renders.
 */
export const HIDE_OVERLAYS = () => {
  for (const el of document.querySelectorAll(".ut-lock-prompt, #credits-container, #ut-hud")) {
    el.style.setProperty("visibility", "hidden", "important");
  }
};
