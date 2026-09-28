import assert from "node:assert/strict";
import { test } from "node:test";
import { ChorusBus, publishNotification, type NotificationRecord } from "../src/index.js";

test("notification is persisted before live and external delivery, even when delivery fails", async () => {
  const records: NotificationRecord[] = [];
  const order: string[] = [];
  const bus = new ChorusBus();
  bus.on((event) => {
    assert.equal(records.length, 1);
    assert.deepEqual(event, { type: "notification", ...input });
    order.push("bus");
  });
  const input = { kind: "error" as const, projectId: "proj_1", title: "Failure", body: "Details", at: 123 };
  await publishNotification({
    db: { insertNotification: (record) => { records.push(record); order.push("persist"); } },
    bus,
    notifier: { id: "test", notify: async (event) => {
      assert.deepEqual(event, input);
      order.push("delivery");
      throw new Error("iMessage unavailable");
    } },
  }, input);
  assert.deepEqual(order, ["persist", "bus", "delivery"]);
  assert.deepEqual(records[0], {
    id: records[0]!.id, projectId: input.projectId, kind: input.kind,
    title: input.title, body: input.body, createdAt: input.at,
  });
});

test("persistence failure still allows existing live and external delivery", async () => {
  const bus = new ChorusBus();
  let emitted = false;
  let delivered = false;
  bus.on(() => { emitted = true; });
  await publishNotification({
    db: { insertNotification: () => { throw new Error("disk full"); } },
    bus,
    notifier: { id: "test", notify: async () => { delivered = true; } },
  }, { kind: "needs_review", projectId: "proj_1", title: "Review", body: "Details" });
  assert.equal(emitted, true);
  assert.equal(delivered, true);
});
