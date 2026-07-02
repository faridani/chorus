import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuotaPill, formatQuotaRetryEta, formatQuotaRetryTitle } from "../src/quotaDisplay.js";

const now = Date.parse("2026-07-01T12:00:00.000Z");

function renderQuota(quota: { state: string; resumeAt: number | null }, renderNow = now) {
  return renderToStaticMarkup(React.createElement(QuotaPill, { quota, now: renderNow }));
}

test("quota pill keeps available state terse", () => {
  const markup = renderQuota({ state: "available", resumeAt: null });

  assert.match(markup, /quota: available/);
  assert.doesNotMatch(markup, /retry/);
  assert.doesNotMatch(markup, /title=/);
});

test("exhausted quota with future resume time shows retry ETA and local timestamp title", () => {
  const resumeAt = now + 12 * 60_000;
  const title = formatQuotaRetryTitle(resumeAt);
  assert.equal(formatQuotaRetryEta(resumeAt, now), "retry in 12m");
  assert.ok(title);

  const markup = renderQuota({ state: "exhausted", resumeAt });

  assert.match(markup, /quota: exhausted · retry in 12m/);
  assert.ok(markup.includes(`title="${title}"`), markup);
});

test("exhausted quota without resume time avoids a misleading retry ETA", () => {
  const markup = renderQuota({ state: "exhausted", resumeAt: null });

  assert.equal(formatQuotaRetryEta(null, now), null);
  assert.match(markup, /quota: exhausted/);
  assert.doesNotMatch(markup, /retry/);
  assert.doesNotMatch(markup, /title=/);
});

test("past-due resume time renders retrying soon instead of a negative duration", () => {
  const resumeAt = now - 1_000;
  const markup = renderQuota({ state: "exhausted", resumeAt });

  assert.equal(formatQuotaRetryEta(resumeAt, now), "retrying soon");
  assert.match(markup, /quota: exhausted · retrying soon/);
});

test("quota retry ETA changes as current time advances", () => {
  const resumeAt = now + 12 * 60_000;

  assert.match(renderQuota({ state: "exhausted", resumeAt }, now), /retry in 12m/);
  assert.match(renderQuota({ state: "exhausted", resumeAt }, now + 5 * 60_000), /retry in 7m/);
});
