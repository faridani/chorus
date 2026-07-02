import React from "react";
import type { AppState } from "./api.js";

const MINUTE_MS = 60_000;

export function QuotaPill({ quota, now = Date.now() }: { quota?: AppState["quota"] | null; now?: number }) {
  const retryEta = quota?.state === "exhausted" ? formatQuotaRetryEta(quota.resumeAt, now) : null;
  const retryTitle = formatQuotaRetryTitle(quota?.resumeAt ?? null);

  return (
    <span className={`pill quota-${quota?.state}`} title={retryTitle}>
      quota: {quota?.state ?? "?"}
      {retryEta ? <> · {retryEta}</> : null}
    </span>
  );
}

export function formatQuotaRetryEta(resumeAt: number | null | undefined, now = Date.now()): string | null {
  if (resumeAt == null || !Number.isFinite(resumeAt)) return null;

  const remainingMs = resumeAt - now;
  if (remainingMs <= 0) return "retrying soon";
  if (remainingMs < MINUTE_MS) return "retry in <1m";

  const totalMinutes = Math.ceil(remainingMs / MINUTE_MS);
  if (totalMinutes < 60) return `retry in ${totalMinutes}m`;

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    return `retry in ${totalHours}h${minutes ? ` ${minutes}m` : ""}`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `retry in ${days}d${hours ? ` ${hours}h` : ""}`;
}

export function formatQuotaRetryTitle(resumeAt: number | null | undefined): string | undefined {
  if (resumeAt == null || !Number.isFinite(resumeAt)) return undefined;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timestamp = new Date(resumeAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
  return `Quota retry scheduled for ${timestamp}${timezone ? ` (${timezone})` : ""}`;
}
