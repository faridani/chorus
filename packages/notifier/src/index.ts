import type { NotificationEvent, Notifier } from "@chorus/core";
import { run } from "@chorus/proc";

/** Drops notifications (used when notifications are disabled or no recipient). */
export class NullNotifier implements Notifier {
  readonly id = "null";
  async notify(_event: NotificationEvent): Promise<void> {
    // intentionally empty
  }
}

/**
 * Sends an iMessage via AppleScript. Fire-and-forget: any failure is swallowed
 * (with a console warning) so a broken notification never fails a task.
 */
export class IMessageNotifier implements Notifier {
  readonly id = "imessage";
  constructor(private readonly to: string) {}

  async notify(event: NotificationEvent): Promise<void> {
    const text = `Chorus — ${event.title}\n${event.body}`;
    const script = `on run argv
  set theBuddy to item 1 of argv
  set theText to item 2 of argv
  tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set targetBuddy to participant theBuddy of targetService
    send theText to targetBuddy
  end tell
end run`;
    try {
      const r = await run("osascript", ["-e", script, this.to, text], { timeoutMs: 15_000 });
      if (r.code !== 0) {
        console.warn(`[notifier] iMessage failed (${r.code}): ${r.stderr.trim()}`);
      }
    } catch (err) {
      console.warn(`[notifier] iMessage error: ${String(err)}`);
    }
  }
}

/** Sends to all child notifiers; one failing never blocks the others. */
export class CompositeNotifier implements Notifier {
  readonly id = "composite";
  constructor(private readonly children: Notifier[]) {}
  async notify(event: NotificationEvent): Promise<void> {
    await Promise.allSettled(this.children.map((c) => c.notify(event)));
  }
}
