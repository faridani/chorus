import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AboutDialog } from "../src/components/AboutDialog.js";
import { GlobalSettings } from "../src/components/GlobalSettings.js";

test("global settings drawer exposes an About action", () => {
  const markup = renderToStaticMarkup(
    React.createElement(GlobalSettings, { onClose: () => undefined, onAbout: () => undefined }),
  );

  assert.match(markup, /About/);
  assert.match(markup, /About Chorus/);
});

test("about dialog describes Chorus and its headless CLI workflow", () => {
  const markup = renderToStaticMarkup(React.createElement(AboutDialog, { onClose: () => undefined }));

  assert.match(markup, /About Chorus/);
  assert.match(markup, /goal-oriented software engineering/);
  assert.match(markup, /headless or clamshell server/);
  assert.match(markup, /--yolo/);
  assert.match(markup, /--dangerously-skip-permissions/);
  assert.match(markup, /Codex, Claude, and Gemini/);
});
