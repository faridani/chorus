import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AgentGalleryTemplate, AgentTemplate } from "./domain.js";
import { validateToolSelection } from "./tools.js";

const StableIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z][a-z0-9._-]*$/, "must start with a lowercase letter and contain only lowercase letters, numbers, '.', '_', or '-'");
const NonEmptyStringSchema = z.string().trim().min(1);

export const BuiltInAgentDefinitionSchema = z
  .object({
    id: StableIdentifierSchema,
    name: StableIdentifierSchema,
    displayName: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    allowed: z.array(NonEmptyStringSchema).default([]),
    forbidden: z.array(NonEmptyStringSchema).default([]),
    backendId: StableIdentifierSchema,
    model: NonEmptyStringSchema.optional(),
    allowedToolIds: z.array(NonEmptyStringSchema).default([]),
    forbiddenToolIds: z.array(NonEmptyStringSchema).default([]),
    version: NonEmptyStringSchema,
    category: NonEmptyStringSchema,
  })
  .strict();

export type BuiltInAgentDefinition = z.infer<typeof BuiltInAgentDefinitionSchema>;

export type BuiltInAgentTemplate = AgentGalleryTemplate & {
  source: "builtin";
  readOnly: true;
  version: string;
};

export interface BuiltInAgentRef {
  id?: string;
  name?: string;
}

export interface BuiltInAgentLoadOptions {
  agentsDir?: string;
}

export function customAgentTemplateToGalleryTemplate(t: AgentTemplate): AgentGalleryTemplate {
  return {
    ...t,
    displayName: t.name,
    category: "Custom",
    source: "custom",
    readOnly: false,
  };
}

export function listAgentGalleryTemplates(
  customTemplates: AgentTemplate[],
  options: BuiltInAgentLoadOptions = {},
): AgentGalleryTemplate[] {
  return [
    ...loadBuiltInAgentTemplates(options),
    ...customTemplates.map(customAgentTemplateToGalleryTemplate),
  ];
}

export function getBuiltInAgentTemplate(
  ref: BuiltInAgentRef,
  options: BuiltInAgentLoadOptions = {},
): BuiltInAgentTemplate | undefined {
  if (!ref.id && !ref.name) return undefined;
  return loadBuiltInAgentTemplates(options).find(
    (agent) => (ref.id != null && agent.id === ref.id) || (ref.name != null && agent.name === ref.name),
  );
}

export function loadBuiltInAgentTemplates(
  options: BuiltInAgentLoadOptions = {},
): BuiltInAgentTemplate[] {
  const agentsDir = options.agentsDir ? resolve(options.agentsDir) : resolveBuiltInAgentsDir();
  const files = readdirSync(agentsDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    throw new Error(`Built-in agent validation failed:\n- ${agentsDir}: no .json agent definition files found`);
  }

  const entries: { filePath: string; data: BuiltInAgentDefinition }[] = [];
  const errors: string[] = [];
  const seenIds = new Map<string, string>();
  const seenNames = new Map<string, string>();

  for (const file of files) {
    const filePath = join(agentsDir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (err) {
      errors.push(`${filePath}: invalid JSON (${String(err)})`);
      continue;
    }

    const parsed = BuiltInAgentDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.length > 0 ? issue.path.join(".") : "root";
        errors.push(`${filePath}: ${path}: ${issue.message}`);
      }
      continue;
    }

    const toolSelection = validateToolSelection(parsed.data.allowedToolIds, parsed.data.forbiddenToolIds);
    if (!toolSelection.ok) errors.push(`${filePath}: ${toolSelection.error}`);

    const priorId = seenIds.get(parsed.data.id);
    if (priorId) errors.push(`${filePath}: duplicate built-in agent id "${parsed.data.id}" (already in ${priorId})`);
    else seenIds.set(parsed.data.id, filePath);

    const priorName = seenNames.get(parsed.data.name);
    if (priorName)
      errors.push(`${filePath}: duplicate built-in agent name "${parsed.data.name}" (already in ${priorName})`);
    else seenNames.set(parsed.data.name, filePath);

    entries.push({ filePath, data: parsed.data });
  }

  if (errors.length > 0) {
    throw new Error(`Built-in agent validation failed:\n- ${errors.join("\n- ")}`);
  }

  return entries.map(({ data }) => ({
    ...data,
    source: "builtin",
    readOnly: true,
  }));
}

export function resolveBuiltInAgentsDir(): string {
  const override = process.env.CHORUS_BUILTIN_AGENTS_DIR?.trim();
  if (override) return resolve(override);

  const starts = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    let current = resolve(start);
    while (true) {
      const candidate = join(current, "agents");
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  throw new Error(
    "Built-in agents directory not found. Expected an agents/ folder at the repository root or set CHORUS_BUILTIN_AGENTS_DIR.",
  );
}
