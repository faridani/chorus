import React, { useEffect, useState } from "react";
import type { AppState } from "./api.js";

const MINUTE_MS = 60_000;

export function QuotaPill({ quota, now }: { quota?: AppState["quota"] | null; now?: number }) {
  const [clock, setClock] = useState(() => Date.now());
  const resumeAt = quota?.state === "exhausted" && isValidRetryTime(quota.resumeAt) ? quota.resumeAt : null;

  useEffect(() => {
    if (resumeAt == null || now != null) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [resumeAt, now]);

  const retryEta = formatQuotaRetryEta(resumeAt, now ?? clock);
  const retryTitle = formatQuotaRetryTitle(resumeAt);

  return (
    <span className={`pill quota-${quota?.state}`} title={retryTitle}>
      quota: {quota?.state ?? "?"}
      {retryEta ? <> · {retryEta}</> : null}
    </span>
  );
}

export function formatQuotaRetryEta(resumeAt: number | null | undefined, now = Date.now()): string | null {
  if (!isValidRetryTime(resumeAt)) return null;

  const remainingMs = resumeAt - now;
  if (remainingMs <= 0) return "retrying soon";
  if (remainingMs < MINUTE_MS) return "retry in <1m";

  const totalMinutes = Math.floor(remainingMs / MINUTE_MS);
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
  if (!isValidRetryTime(resumeAt)) return undefined;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timestamp = new Date(resumeAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
  return `Quota retry scheduled for ${timestamp}${timezone ? ` (${timezone})` : ""}`;
}

function isValidRetryTime(resumeAt: number | null | undefined): resumeAt is number {
  return typeof resumeAt === "number" && Number.isFinite(resumeAt) && Number.isFinite(new Date(resumeAt).getTime());
}
