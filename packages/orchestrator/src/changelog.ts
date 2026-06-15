import type { ChangelogEntry } from "@chorus/core";

/** Render the full CHANGELOG.md from all entries (newest first). */
export function renderChangelog(entries: ChangelogEntry[]): string {
  const lines = ["# Changelog", "", "_Maintained by Chorus._", ""];
  for (const e of entries) {
    const when = new Date(e.createdAt).toISOString();
    const role = e.agentRole ? ` _(by ${e.agentRole})_` : "";
    lines.push(`- **${when}**${role} — ${e.entry}`);
  }
  lines.push("");
  return lines.join("\n");
}
