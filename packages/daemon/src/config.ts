import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Config, ConfigSchema } from "@chorus/core";

/**
 * Load config from the file at $CHORUS_CONFIG (JSON) merged over defaults.
 * dataDir resolves from $CHORUS_DATA_DIR or ~/.chorus.
 */
export function loadConfig(): Config {
  const fileConfig = readFileConfig();
  const dataDir =
    process.env.CHORUS_DATA_DIR ?? fileConfig.dataDir ?? join(homedir(), ".chorus");
  const merged = {
    ...fileConfig,
    dataDir,
    ...(process.env.CHORUS_PORT ? { port: Number(process.env.CHORUS_PORT) } : {}),
    ...(process.env.CHORUS_HOST ? { host: process.env.CHORUS_HOST } : {}),
  };
  return ConfigSchema.parse(merged);
}

function readFileConfig(): Record<string, unknown> {
  const path = process.env.CHORUS_CONFIG;
  if (path && existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      console.warn(`[config] failed to read ${path}: ${String(err)}`);
    }
  }
  return {};
}
