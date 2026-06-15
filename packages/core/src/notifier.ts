/** A human-facing notification raised by the orchestrator. */
export interface NotificationEvent {
  kind: "merged" | "conflict" | "needs_review" | "quota_paused" | "error";
  projectId: string;
  title: string;
  body: string;
  at: number;
}

/**
 * Pluggable notification channel. The iMessage impl is the M1 default;
 * email/others slot in later. Implementations MUST NOT throw or block the
 * orchestrator — a failed notification is never a failed task.
 */
export interface Notifier {
  readonly id: string;
  notify(event: NotificationEvent): Promise<void>;
}
