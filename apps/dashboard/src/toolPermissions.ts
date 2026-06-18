export type ToolPermissionState = "allowed" | "disallowed" | "unspecified";

export function normalizeToolIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string");
}

export function resolveToolPermissionState(
  id: string,
  allowed?: unknown,
  forbidden?: unknown,
): ToolPermissionState {
  if (normalizeToolIds(allowed).includes(id)) return "allowed";
  if (normalizeToolIds(forbidden).includes(id)) return "disallowed";
  return "unspecified";
}
