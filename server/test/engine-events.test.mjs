import test from "node:test";
import assert from "node:assert/strict";
import { createEvents } from "../../src/game/engine/events.js";

test("emit delivers detail to listeners, like sceneEl.emit did", () => {
  const ev = createEvents();
  let got = null;
  ev.on("local-fire", (e) => (got = e.detail));
  ev.emit("local-fire", { weapon: "enforcer" });
  assert.deepEqual(got, { weapon: "enforcer" });
});

test("off removes a listener; once fires exactly once; on returns an unsubscribe", () => {
  const ev = createEvents();
  let n = 0;
  const h = () => n++;
  ev.on("x", h);
  ev.emit("x");
  ev.off("x", h);
  ev.emit("x");
  assert.equal(n, 1);
  ev.once("y", h);
  ev.emit("y");
  ev.emit("y");
  assert.equal(n, 2);
  const un = ev.on("z", h);
  ev.emit("z");
  un();
  ev.emit("z");
  assert.equal(n, 3);
});
