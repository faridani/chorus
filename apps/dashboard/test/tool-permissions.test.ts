import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeToolIds, resolveToolPermissionState } from "../src/toolPermissions.js";

test("resolveToolPermissionState maps explicit and absent tool states", () => {
  const allowed = ["repo.read"];
  const forbidden = ["repo.commit"];

  assert.equal(resolveToolPermissionState("repo.read", allowed, forbidden), "allowed");
  assert.equal(resolveToolPermissionState("repo.commit", allowed, forbidden), "disallowed");
  assert.equal(resolveToolPermissionState("tickets.create", allowed, forbidden), "unspecified");
  assert.equal(resolveToolPermissionState("future.new.tool", allowed, forbidden), "unspecified");
});

test("resolveToolPermissionState treats missing legacy selections as unspecified", () => {
  assert.equal(resolveToolPermissionState("repo.read"), "unspecified");
  assert.equal(resolveToolPermissionState("repo.read", null, { legacy: true }), "unspecified");
  assert.deepEqual(normalizeToolIds({ legacy: true }), []);
});
