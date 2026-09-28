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

test("countdown preserves minute, hour, and day boundaries", () => {
  const cases: [number, string][] = [
    [-1, "retrying soon"], [0, "retrying soon"],
    [1, "retry in <1m"], [59_999, "retry in <1m"],
    [60_000, "retry in 1m"], [60_001, "retry in 1m"],
    [119_999, "retry in 1m"], [120_000, "retry in 2m"],
    [3_599_999, "retry in 59m"], [3_600_000, "retry in 1h"],
    [3_660_000, "retry in 1h 1m"],
    [86_399_999, "retry in 23h 59m"], [86_400_000, "retry in 1d"],
    [90_000_000, "retry in 1d 1h"],
  ];
  for (const [remaining, expected] of cases) {
    assert.equal(formatQuotaRetryEta(now + remaining, now), expected, String(remaining));
  }
});

test("missing and invalid dates have neither ETA nor title", () => {
  for (const resumeAt of [undefined, null, NaN, Infinity, -Infinity, 8.64e15 + 1]) {
    assert.equal(formatQuotaRetryEta(resumeAt, now), null);
    assert.equal(formatQuotaRetryTitle(resumeAt), undefined);
    const markup = renderToStaticMarkup(React.createElement(QuotaPill, {
      quota: { state: "exhausted", resumeAt: resumeAt as number | null }, now,
    }));
    assert.match(markup, /quota: exhausted/);
    assert.doesNotMatch(markup, /retry|title=/);
  }
});

test("available quota ignores stale retry timestamps", () => {
  const markup = renderQuota({ state: "available", resumeAt: now + 60_000 });
  assert.match(markup, /quota: available/);
  assert.doesNotMatch(markup, /retry|title=/);
});

test("missing quota renders the unknown state safely", () => {
  for (const quota of [null, undefined]) {
    const markup = renderToStaticMarkup(React.createElement(QuotaPill, { quota, now }));
    assert.match(markup, /quota: \?/);
    assert.doesNotMatch(markup, /retry|title=/);
  }
});

test("retry title includes the exact local date, time, and timezone", () => {
  const local = new Date(now).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(formatQuotaRetryTitle(now), `Quota retry scheduled for ${local}${timezone ? ` (${timezone})` : ""}`);
});
