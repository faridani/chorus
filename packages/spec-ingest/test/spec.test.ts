import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { SPEC_CANDIDATES, findSpec } from "../src/spec.js";

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "chorus-spec-"));
}

function writeRepoFile(repo: string, rel: string, content = "content\n"): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), content, "utf8");
}

test("README.md is not a spec candidate", () => {
  assert.equal(SPEC_CANDIDATES.includes("README.md"), false);

  const repo = tempRepo();
  writeRepoFile(repo, "README.md", "# Generic project README\n");

  assert.equal(findSpec(repo), null);
});

test("findSpec returns conventional spec and architecture files", () => {
  assert.equal(SPEC_CANDIDATES.includes("docs/spec.md"), true);

  for (const candidate of ["docs/SPEC.md", "docs/ARCHITECTURE.md", "SPEC.md", "ARCHITECTURE.md"]) {
    const repo = tempRepo();
    writeRepoFile(repo, "README.md", "# README\n");
    writeRepoFile(repo, candidate, "# Project spec\n");

    assert.equal(findSpec(repo), candidate);
  }
});
