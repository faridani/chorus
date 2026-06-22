import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("dashboard layout uses a wider responsive left pane", () => {
  assert.match(styles, /--left-pane-width:\s*clamp\(\s*320px\s*,\s*24vw\s*,\s*380px\s*\)\s*;/);
  assert.match(
    styles,
    /\.body\s*\{[^}]*grid-template-columns:\s*var\(\s*--left-pane-width\s*\)\s+minmax\(\s*0\s*,\s*1fr\s*\)\s+var\(\s*--events-pane-width\s*\)\s*;/s,
  );
  assert.match(
    styles,
    /\.body\.right-pane-collapsed\s*\{[^}]*grid-template-columns:\s*var\(\s*--left-pane-width\s*\)\s+minmax\(\s*0\s*,\s*1fr\s*\)\s+var\(\s*--events-handle-width\s*\)\s*;/s,
  );
  assert.match(styles, /max-width:\s*calc\(\s*100vw\s*-\s*var\(\s*--left-pane-width\s*\)\s*\)\s*;/);
});
