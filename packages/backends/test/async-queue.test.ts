import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncQueue } from "@chorus/backends";

test("AsyncQueue: yields pushed items then completes on close", async () => {
  const q = new AsyncQueue<number>();
  q.push(1);
  q.push(2);
  q.close();
  const got: number[] = [];
  for await (const n of q) got.push(n);
  assert.deepEqual(got, [1, 2]);
});

test("AsyncQueue: consumer awaiting before producer pushes", async () => {
  const q = new AsyncQueue<string>();
  const collected: string[] = [];
  const consumer = (async () => {
    for await (const s of q) collected.push(s);
  })();
  await new Promise((r) => setTimeout(r, 10));
  q.push("a");
  q.push("b");
  q.close();
  await consumer;
  assert.deepEqual(collected, ["a", "b"]);
});
