import { z } from "zod";

/**
 * Runtime configuration for the whole daemon. Loaded from a JSON file
 * (CHORUS_CONFIG) merged with sensible defaults. Kept here so every package
 * shares one validated shape.
 */
export const ConfigSchema = z.object({
  /** Root for all runtime state: db, clones, worktrees, logs. */
  dataDir: z.string(),
  /** Port the web API/dashboard listens on. */
  port: z.number().int().positive().default(7878),
  /** Bind host. Defaults to 0.0.0.0 so the dashboard is reachable from other
   * machines (LAN/Tailscale); set CHORUS_HOST=127.0.0.1 to restrict to loopback. */
  host: z.string().default("0.0.0.0"),
  /** Max number of agents running at once. */
  maxConcurrentAgents: z.number().int().positive().default(2),
  /** Max dispatch attempts per ticket before it is parked for human review. */
  maxAttemptsPerTicket: z.number().int().positive().default(5),
  agent: z
    .object({
      maxWallClockMs: z.number().int().positive().default(45 * 60 * 1000),
      idleTimeoutMs: z.number().int().positive().default(8 * 60 * 1000),
      /** Default model for the codex backend (empty = CLI default). */
      model: z.string().optional(),
      /** Reasoning summary verbosity streamed to the live feed. */
      reasoningSummary: z.enum(["auto", "concise", "detailed", "none"]).default("auto"),
      /** Self-update CLI backends (claude/codex) once per process before first use. */
      autoUpdateCli: z.boolean().default(true),
    })
    .default({}),
  orchestrator: z
    .object({
      /**
       * "autonomous": the orchestrator runs as a codex agent that calls spoke
       * agents (and verify/PR actions) as MCP tools, deciding turn-by-turn.
       * "hybrid": the legacy one-shot triage decision + TypeScript state machine.
       */
      mode: z.enum(["hybrid", "autonomous"]).default("autonomous"),
      /** Hard cap on spoke-agent runs per autonomous session (cost/loop guard). */
      maxSpokeAgentsPerSession: z.number().int().positive().default(12),
      /** Max spoke agents running concurrently within one session. */
      maxParallelSpokeAgents: z.number().int().positive().default(3),
      /** Wall-clock cap for one autonomous orchestrator session. */
      sessionWallClockMs: z
        .number()
        .int()
        .positive()
        .default(4 * 60 * 60 * 1000),
    })
    .default({}),
  diagnostics: z
    .object({
      /** Model for the read-only Debug Traces diagnostician (empty = CLI default). */
      model: z.string().optional(),
    })
    .default({}),
  quota: z
    .object({
      /** Regexes (source strings) that indicate quota/rate-limit exhaustion. */
      exhaustionPatterns: z
        .array(z.string())
        .default([
          "rate.?limit",
          "quota",
          "usage limit",
          "\\b429\\b",
          "resets? at",
          "too many requests",
        ]),
      /** First retry delay after a quota pause (ms). */
      backoffStartMs: z.number().int().positive().default(15 * 60 * 1000),
      /** Cap on retry delay (ms). */
      backoffMaxMs: z.number().int().positive().default(4 * 60 * 60 * 1000),
    })
    .default({}),
  notifications: z
    .object({
      enabled: z.boolean().default(true),
      /** iMessage recipient (phone number or Apple ID email). */
      imessageTo: z.string().optional(),
    })
    .default({}),
  terminal: z
    .object({
      /**
       * Allow the in-app terminal ("AI Shell") to be used by any client that can
       * reach the dashboard, not just loopback / local-interface clients. The
       * dashboard is unauthenticated, so enabling this exposes an interactive,
       * full-access shell to whatever network `host` is bound to. Enable only on
       * trusted networks (e.g. a personal LAN/Tailscale). Set via config or the
       * CHORUS_ALLOW_REMOTE_TERMINAL env var.
       */
      allowRemoteClients: z.boolean().default(false),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
