import type { BackendInfo } from "./api.js";

/**
 * The backends to offer in a role/template editor's backend dropdown: every
 * installed backend, plus the currently-saved one even if its CLI is temporarily
 * unavailable (so editing a role doesn't silently drop its backend/model). Falls
 * back to a synthetic codex entry when nothing is detected at all.
 *
 * Shared by RoleEditor (AgentsTab) and TemplateEditor (AgentGallery) so the two
 * dropdowns stay in lockstep.
 */
export function backendChoices(
  backends: BackendInfo[],
  selectedId: string,
  selectedModel: string,
): BackendInfo[] {
  const choices = backends.filter((b) => b.available || b.id === selectedId);
  if (!choices.some((b) => b.id === selectedId)) {
    choices.push(fallbackBackend(selectedId, selectedModel));
  }
  return choices.length ? choices : [fallbackBackend("codex", "")];
}

/** A synthetic BackendInfo for a saved-but-undetected backend/model. */
export function fallbackBackend(id: string, model: string): BackendInfo {
  return {
    id,
    label: id,
    bin: id,
    available: true,
    version: null,
    models: model ? [model] : [],
    defaultModel: null,
    implemented: true,
  };
}
