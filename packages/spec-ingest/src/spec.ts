import { existsSync } from "node:fs";
import { join } from "node:path";

/** Conventional locations for a project spec, in priority order. */
export const SPEC_CANDIDATES = [
  "docs/SPEC.md",
  "docs/ARCHITECTURE.md",
  "SPEC.md",
  "ARCHITECTURE.md",
  "docs/spec.md",
  "README.md",
];

/** Find the first spec-like file present in the clone; null if none. */
export function findSpec(localPath: string): string | null {
  for (const rel of SPEC_CANDIDATES) {
    if (existsSync(join(localPath, rel))) return rel;
  }
  return null;
}
