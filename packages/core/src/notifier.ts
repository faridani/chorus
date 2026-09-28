import type { NotificationKind, NotificationRecord } from "./domain.js";
import type { ChorusBus } from "./events.js";
import { newId } from "./ids.js";

/** A human-facing notification raised by the orchestrator. */
export interface NotificationEvent {
  kind: NotificationKind;
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

export interface NotificationStore {
  insertNotification(notification: NotificationRecord): void;
}

export interface PublishNotificationDeps {
  db: NotificationStore;
  notifier: Notifier;
  bus?: ChorusBus;
}

/**
 * Persist a project notification, preserve the live bus event when requested,
 * then hand off to the external notifier. Notification failures never fail the
 * task/controller path that raised them.
 */
export async function publishNotification(
  deps: PublishNotificationDeps,
  input: Omit<NotificationEvent, "at"> & { at?: number },
): Promise<NotificationEvent> {
  const at = input.at ?? Date.now();
  const event: NotificationEvent = { ...input, at };
  try {
    deps.db.insertNotification({
      id: newId("ntf"),
      projectId: event.projectId,
      kind: event.kind,
      title: event.title,
      body: event.body,
      createdAt: at,
    });
  } catch (err) {
    console.warn(`[notifier] failed to persist notification: ${String(err)}`);
  }
  deps.bus?.emit({
    type: "notification",
    projectId: event.projectId,
    kind: event.kind,
    title: event.title,
    body: event.body,
    at,
  });
  try {
    await deps.notifier.notify(event);
  } catch (err) {
    console.warn(`[notifier] delivery failed: ${String(err)}`);
  }
  return event;
}
