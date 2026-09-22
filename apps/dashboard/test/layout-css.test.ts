import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("dashboard layout uses a wider responsive left pane", () => {
  assert.match(styles, /--left-pane-width:\s*clamp/);
  assert.match(styles, /grid-template-columns:[^;]*--left-pane-width/);
  assert.match(styles, /max-width:[^;]*--left-pane-width/);
});

test("dashboard layout protects compact viewports from pane squeeze", () => {
  assert.match(styles, /--main-pane-compact-min-width:\s*240px/);
  assert.match(styles, /@media\s*\(\s*max-width:\s*768px\s*\)/);
  assert.match(styles, /grid-template-columns:[^;]*--main-pane-compact-min-width[^;]*--events-handle-width/);
  assert.match(styles, /max-width:[^;]*--events-pane-width/);
});
