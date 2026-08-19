// NOTE: Codex enforces *strict* JSON Schema for structured output: with
// `additionalProperties: false`, `required` MUST list every key in `properties`,
// or the request is rejected with `invalid_json_schema`.
export { AGENT_RESULT_SCHEMA as CODEX_OUTPUT_SCHEMA } from "../result-schema.js";
