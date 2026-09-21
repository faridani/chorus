import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("dashboard layout uses a wider responsive left pane", () => {
  assert.match(styles, /--left-pane-width:\s*clamp\(320px,\s*24vw,\s*380px\);/);
  assert.match(
    styles,
    /\.body\s*\{[^}]*grid-template-columns:\s*var\(--left-pane-width\)\s+minmax\(0,\s*1fr\)\s+var\(--events-pane-width\);/s,
  );
  assert.match(
    styles,
    /\.body\.right-pane-collapsed\s*\{[^}]*grid-template-columns:\s*var\(--left-pane-width\)\s+minmax\(0,\s*1fr\)\s+var\(--events-handle-width\);/s,
  );
  assert.match(styles, /max-width:\s*calc\(100vw\s*-\s*var\(--left-pane-width\)\);/);
});
