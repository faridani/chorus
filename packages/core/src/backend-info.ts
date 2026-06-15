/**
 * Detected info about an AI backend CLI on the host. Produced at startup by
 * probing the system; surfaced in the dashboard's "Models" panel and used to
 * pre-populate the backend/model dropdowns when defining agents.
 *
 * Model lists are curated per backend (the CLIs don't expose an enumeration
 * API) but include the CLI's configured default when detectable, and can be
 * overridden via config. `implemented` marks whether Chorus actually has an
 * adapter that can drive this backend yet (only codex today).
 */
export interface BackendInfo {
  id: string;
  label: string;
  /** CLI binary name, e.g. "codex". */
  bin: string;
  available: boolean;
  version: string | null;
  /** Models offered for selection. */
  models: string[];
  /** The CLI's configured default model, if detected. */
  defaultModel: string | null;
  /** True when Chorus has a working adapter for this backend. */
  implemented: boolean;
}
