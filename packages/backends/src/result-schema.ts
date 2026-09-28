/**
 * JSON Schema used for the structured result every worker backend must return.
 * Mirrors AgentResultPayloadSchema in @chorus/core. Kept as a literal rather
 * than generated to avoid a zod-to-json-schema dependency for one small shape.
 */
export const AGENT_RESULT_SCHEMA = {
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
    suggestions: {
      type: "array",
      description:
        "Optional structured follow-up suggestions for work that is useful but outside this attempt's safe scope.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "rationale", "affectedArea", "proposedAction"],
        properties: {
          title: { type: "string" },
          rationale: { type: "string" },
          affectedArea: { type: "string" },
          proposedAction: { type: "string" },
          recommendedAgent: { type: "string" },
          recommendedTool: { type: "string" },
          recommendedSkill: { type: "string" },
        },
      },
    },
  },
} as const;

export const AGENT_RESULT_INSTRUCTIONS = `Return only a JSON object matching this schema:
${JSON.stringify(AGENT_RESULT_SCHEMA)}

Do not wrap the JSON in Markdown fences or explanatory text.`;
