import { randomUUID } from "node:crypto";

/** Short, sortable-ish unique id with a type prefix for readability in logs. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
