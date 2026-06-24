/**
 * JSON Schema handed to `codex exec --output-schema`. Mirrors
 * AgentResultPayloadSchema in @chorus/core. Kept as a literal (rather than
 * generated) to avoid a zod-to-json-schema dependency for one small shape.
 */
// NOTE: the model provider enforces *strict* JSON Schema for structured output:
// with `additionalProperties: false`, `required` MUST list every key in
// `properties`, or the request is rejected with `invalid_json_schema`.
export const CODEX_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "filesChanged", "notes"],
  properties: {
    status: {
      type: "string",
      enum: ["success", "blocked", "no_changes"],
      description:
        "success = work done and committed; no_changes = nothing needed to be done; blocked = could not proceed.",
    },
    summary: {
      type: "string",
      description: "A concise human-readable summary of what was done, for the changelog.",
    },
    filesChanged: {
      type: "array",
      items: { type: "string" },
      description: "Repo-relative paths of files created or modified.",
    },
    notes: {
      type: "string",
      description: "Optional caveats, follow-ups, or reasons for blocked/no_changes.",
    },
  },
} as const;
