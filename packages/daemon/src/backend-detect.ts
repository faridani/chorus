import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BackendInfo } from "@chorus/core";
import { run } from "@chorus/proc";

interface KnownBackend {
  id: string;
  label: string;
  bin: string;
  /** Whether Chorus has a runtime adapter for it. */
  implemented: boolean;
  /** Curated model list (CLIs don't expose enumeration). */
  models: string[];
  /** Best-effort read of the CLI's configured default model. */
  detectDefaultModel?: () => string | null;
}

function codexDefaultModel(): string | null {
  try {
    const cfg = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
    const m = cfg.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

const KNOWN_BACKENDS: KnownBackend[] = [
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    implemented: true,
    // Only models accepted by Codex on a ChatGPT subscription account. The
    // `-codex` variants and `gpt-5`/`o3`/`o4-mini` are API-key-only and 400 with
    // "not supported when using Codex with a ChatGPT account" — advertising them
    // led operators to pin a model that fails every run. detectBackends() also
    // prepends whatever `~/.codex/config.toml` sets as the default.
    models: ["gpt-5.5"],
    detectDefaultModel: codexDefaultModel,
  },
  {
    id: "claude",
    label: "Claude",
    bin: "claude",
    implemented: false,
    models: ["opus", "sonnet", "haiku"],
  },
  {
    id: "gemini",
    label: "Gemini",
    bin: "gemini",
    implemented: false,
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
];

/**
 * Probe the host for available backend CLIs and pair each with its models.
 * Runs once at startup; the result is a snapshot for the UI and dropdowns.
 */
export async function detectBackends(): Promise<BackendInfo[]> {
  return Promise.all(
    KNOWN_BACKENDS.map(async (b): Promise<BackendInfo> => {
      let available = false;
      let version: string | null = null;
      try {
        const r = await run(b.bin, ["--version"], { timeoutMs: 5000 });
        available = r.code === 0;
        version = r.code === 0 ? r.stdout.trim().split("\n")[0] || null : null;
      } catch {
        available = false;
      }
      const defaultModel = available && b.detectDefaultModel ? b.detectDefaultModel() : null;
      // Surface the configured default first, even if not in the curated list.
      const models =
        defaultModel && !b.models.includes(defaultModel) ? [defaultModel, ...b.models] : b.models;
      return {
        id: b.id,
        label: b.label,
        bin: b.bin,
        available,
        version,
        models,
        defaultModel: defaultModel ?? null,
        implemented: b.implemented,
      };
    }),
  );
}
