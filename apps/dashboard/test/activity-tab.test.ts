import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityTab } from "../src/components/ActivityTab.js";

test("activity tab renders persisted notification history", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ActivityTab, {
      pullRequests: [],
      attemptJournal: [],
      changelog: [],
      notifications: [
        {
          id: "ntf_1",
          projectId: "proj_1",
          kind: "pr_opened",
          title: "PR opened",
          body: "Persist notification history\nhttps://github.com/faridani/chorus/pull/123",
          createdAt: Date.UTC(2026, 6, 1, 12, 0, 0),
        },
      ],
    }),
  );

  assert.match(markup, /Notifications/);
  assert.match(markup, /pr opened/);
  assert.match(markup, /PR opened/);
  assert.match(markup, /Persist notification history/);
  assert.match(markup, /github\.com\/faridani\/chorus\/pull\/123/);
});
