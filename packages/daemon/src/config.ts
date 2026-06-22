import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Config, ConfigSchema } from "@chorus/core";

/**
 * Load config from the file at $CHORUS_CONFIG (JSON) merged over defaults.
 * dataDir resolves from $CHORUS_DATA_DIR or ~/.chorus.
 */
export function loadConfig(): Config {
  const fileConfig = readFileConfig();
  const dataDir =
    process.env.CHORUS_DATA_DIR ?? fileConfig.dataDir ?? join(homedir(), ".chorus");
  const allowRemoteTerminal = process.env.CHORUS_ALLOW_REMOTE_TERMINAL;
  const merged = {
    ...fileConfig,
    dataDir,
    ...(process.env.CHORUS_PORT ? { port: Number(process.env.CHORUS_PORT) } : {}),
    ...(process.env.CHORUS_HOST ? { host: process.env.CHORUS_HOST } : {}),
    ...(allowRemoteTerminal !== undefined
      ? {
          terminal: {
            ...((fileConfig.terminal as Record<string, unknown> | undefined) ?? {}),
            allowRemoteClients: /^(1|true|yes|on)$/i.test(allowRemoteTerminal),
          },
        }
      : {}),
  };
  return ConfigSchema.parse(merged);
}

function readFileConfig(): Record<string, unknown> {
  const path = resolveConfigPath();
  if (path) {
    try {
      console.log(`[config] loaded ${path}`);
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      console.warn(`[config] failed to read ${path}: ${String(err)}`);
    }
  }
  return {};
}

/**
 * $CHORUS_CONFIG wins if set. Otherwise fall back to `chorus.config.json` at the
 * repo root, so settings persist across restarts without having to export
 * CHORUS_CONFIG on every launch.
 */
function resolveConfigPath(): string | undefined {
  if (process.env.CHORUS_CONFIG) {
    return existsSync(process.env.CHORUS_CONFIG) ? process.env.CHORUS_CONFIG : undefined;
  }
  const here = dirname(fileURLToPath(import.meta.url)); // packages/daemon/{src,dist}
  for (const candidate of [
    join(here, "..", "..", "..", "chorus.config.json"),
    join(here, "..", "..", "..", "..", "chorus.config.json"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
