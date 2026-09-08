import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentTemplateSource,
  type ChorusBus,
  type Config,
  type ControlApi,
  customAgentTemplateToGalleryTemplate,
  listAgentGalleryTemplates,
  TOOL_CATALOG,
} from "@chorus/core";
import type { ChorusDb } from "@chorus/db";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";

export interface VersionInfo {
  number: string;
  commit: string;
  dirty: boolean;
  /** When this daemon process started (ms). */
  startedAt: number;
}

/** Session-scoped internal API the MCP bridge calls (implemented by the Orchestrator). */
export interface SessionApi {
  sessionCall(
    token: string,
    action: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }>;
}

export interface WebDeps {
  db: ChorusDb;
  bus: ChorusBus;
  api: ControlApi;
  config: Config;
  version: VersionInfo;
  /** Directory of the built dashboard SPA, if available. */
  dashboardDir?: string;
  /** Backs the loopback-only MCP tool endpoints for autonomous orchestration. */
  sessionApi?: SessionApi;
}

/** Build (but do not start) the Fastify app. */
export function createServer(deps: WebDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const { db, bus, api } = deps;

  app.register(fastifyWebsocket);

  // ---- live event feed ----
  app.register(async (instance) => {
    instance.get("/ws", { websocket: true }, (socket) => {
      const send = (data: unknown) => {
        try {
          socket.send(JSON.stringify(data));
        } catch {
          /* client gone */
        }
      };
      send({ type: "hello", at: Date.now() });
      const off = bus.on((event) => send(event));
      socket.on("close", off);
    });
  });

  // ---- read endpoints (straight from the DB) ----
  app.get("/api/version", () => deps.version);

  app.get("/api/backends", () => api.listBackends());
  app.post("/api/backends/refresh", () => api.refreshBackends());

  // ---- tool catalog (source-defined, read-only) ----
  app.get("/api/tools", () => TOOL_CATALOG);

  // ---- internal MCP tool API (loopback only; called by the agent-mcp bridge) ----
  // The autonomous orchestrator's codex process spawns the bridge, which calls
  // these endpoints with its session token. Restricted to loopback since the
  // bridge always runs on the daemon host.
  if (deps.sessionApi) {
    const sessionApi = deps.sessionApi;
    // The bridge reaches the daemon on the host's configured address. Allow
    // loopback always, plus the bound host IP when it's a specific interface
    // (a remote client still fails: its source IP won't match config.host).
    const boundHost = deps.config.host;
    const isLoopback = (ip: string) =>
      ip === "127.0.0.1" ||
      ip === "::1" ||
      ip === "::ffff:127.0.0.1" ||
      (boundHost !== "0.0.0.0" && (ip === boundHost || ip === `::ffff:${boundHost}`));
    const handle = async (
      req: { params: unknown; body?: unknown; ip: string },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) => {
      if (!isLoopback(req.ip)) return reply.code(403).send({ error: "loopback only" });
      const { token, action } = req.params as { token: string; action: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { status, body: out } = await sessionApi.sessionCall(token, action, body);
      return reply.code(status).send(out);
    };
    app.get("/api/internal/sessions/:token/:action", handle);
    app.post("/api/internal/sessions/:token/:action", handle);
  }

  // ---- agent gallery (global templates) ----
  app.get("/api/agent-templates", () => listAgentGalleryTemplates(db.listAgentTemplates()));

  app.post("/api/agent-templates", async (req, reply) => {
    const body = req.body as {
      name?: string;
      description?: string;
      allowed?: string[];
      forbidden?: string[];
      allowedToolIds?: string[];
      forbiddenToolIds?: string[];
      backendId?: string;
      model?: string;
    };
    if (!body?.name) return reply.code(400).send({ error: "name required" });
    const template = await api.upsertAgentTemplate({
      name: body.name,
      description: body.description ?? "",
      allowed: body.allowed ?? [],
      forbidden: body.forbidden ?? [],
      allowedToolIds: body.allowedToolIds ?? [],
      forbiddenToolIds: body.forbiddenToolIds ?? [],
      backendId: body.backendId ?? "codex",
      model: body.model,
    });
    return customAgentTemplateToGalleryTemplate(template);
  });

  app.delete("/api/agent-templates/:name", async (req) => {
    const { name } = req.params as { name: string };
    await api.deleteAgentTemplate(decodeURIComponent(name));
    return { ok: true };
  });

  // ---- global settings (read-only for now) ----
  app.get("/api/settings", () => ({
    dataDir: deps.config.dataDir,
    worktreesDir: join(deps.config.dataDir, "worktrees"),
    reposDir: join(deps.config.dataDir, "repos"),
    host: deps.config.host,
    port: deps.config.port,
    maxConcurrentAgents: deps.config.maxConcurrentAgents,
  }));

  app.get("/api/state", () => ({
    orchestrator: api.orchestratorState(),
    runningTasks: api.runningTaskIds(),
    quota: db.getQuota(),
    usageTotals: db.usageTotals(),
    version: deps.version,
    at: Date.now(),
  }));

  app.get("/api/projects", () => db.listProjects());

  app.get("/api/projects/:id", (req, reply) => {
    const { id } = req.params as { id: string };
    const project = db.getProject(id);
    if (!project) return reply.code(404).send({ error: "not found" });
    const tickets = db.listTickets(id);
    return {
      project,
      tickets: tickets.map((t) => ({ ...t, tasks: db.listTasksForTicket(t.id) })),
      roles: db.listRoles(id),
      pullRequests: db.listPullRequests(id),
      attemptJournal: db.listProjectAttemptJournal(id),
      changelog: db.listChangelog(id),
      suggestions: db.listSuggestions(id, "open"),
    };
  });

  // Ticket activity trail for the whole project (powers the State Machine tab
  // and per-ticket trail view).
  app.get("/api/projects/:id/events", (req) => {
    const { id } = req.params as { id: string };
    return db.listProjectTicketEvents(id);
  });

  app.post("/api/projects/:id/suggestions/:sid/dismiss", async (req) => {
    const { id, sid } = req.params as { id: string; sid: string };
    await api.dismissSuggestion(id, sid);
    return { ok: true };
  });

  app.get("/api/usage", () => ({
    totals: db.usageTotals(),
    recent: db.recentUsage(200),
    quota: db.getQuota(),
  }));

  // ---- command endpoints (delegate to the daemon) ----
  app.post("/api/projects", async (req, reply) => {
    const body = req.body as { repoUrl?: string; specText?: string; baseBranch?: string };
    if (!body?.repoUrl) return reply.code(400).send({ error: "repoUrl required" });
    const project = await api.createProject({
      repoUrl: body.repoUrl,
      specText: body.specText,
      baseBranch: body.baseBranch,
    });
    return project;
  });

  app.patch("/api/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      baseBranch?: string;
      expectations?: string;
      groundRules?: string[];
      setupCommand?: string;
      verifyCommands?: string[];
      idleIdeation?: boolean;
      idleIdeationCount?: number;
    };
    return api.updateProjectSettings(id, body ?? {});
  });

  app.post("/api/projects/:id/run-state", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { state?: string };
    if (body?.state !== "running" && body?.state !== "paused" && body?.state !== "stopped") {
      return reply.code(400).send({ error: "state must be running|paused|stopped" });
    }
    return api.setProjectRunState(id, body.state);
  });

  app.post("/api/projects/:id/spec", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { specText?: string };
    if (!body?.specText) return reply.code(400).send({ error: "specText required" });
    await api.provideSpec(id, body.specText);
    return { ok: true };
  });

  app.get("/api/projects/:id/spec", (req) => {
    const { id } = req.params as { id: string };
    return api.readProjectSpec(id);
  });

  app.post("/api/projects/:id/tickets", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      title?: string;
      body?: string;
      roleName?: string;
      priority?: number;
      fromDiagnostic?: boolean;
    };
    if (!body?.title || !body?.body) return reply.code(400).send({ error: "title and body required" });
    return api.addTicket(id, {
      title: body.title,
      body: body.body,
      roleName: body.roleName,
      priority: body.priority,
      fromDiagnostic: body.fromDiagnostic,
    });
  });

  // ---- Debug Traces (read-only diagnosis of recent activity) ----
  app.post("/api/projects/:id/debug-traces", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { liveEvents?: unknown[] };
    try {
      return await api.runDebugTraces(id, null, body.liveEvents ?? []);
    } catch (err) {
      const code = (err as { statusCode?: number })?.statusCode ?? 502;
      return reply.code(code).send({ error: `Diagnosis failed: ${String(err)}` });
    }
  });

  app.post("/api/projects/:id/tickets/:ticketId/debug-traces", async (req, reply) => {
    const { id, ticketId } = req.params as { id: string; ticketId: string };
    const body = (req.body ?? {}) as { liveEvents?: unknown[] };
    try {
      return await api.runDebugTraces(id, ticketId, body.liveEvents ?? []);
    } catch (err) {
      const code = (err as { statusCode?: number })?.statusCode ?? 502;
      return reply.code(code).send({ error: `Diagnosis failed: ${String(err)}` });
    }
  });

  app.put("/api/projects/:id/tickets/:ticketId", async (req) => {
    const { id, ticketId } = req.params as { id: string; ticketId: string };
    const body = req.body as {
      title?: string;
      body?: string;
      roleName?: string;
      priority?: number;
      reopen?: boolean;
    };
    return api.updateTicket(id, ticketId, body ?? {});
  });

  app.post("/api/projects/:id/tickets/:ticketId/star", async (req) => {
    const { id, ticketId } = req.params as { id: string; ticketId: string };
    const body = req.body as { starred?: boolean };
    return api.setTicketStarred(id, ticketId, !!body?.starred);
  });

  app.post("/api/projects/:id/tickets/reorder", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { orderedIds?: string[] };
    if (!Array.isArray(body?.orderedIds)) {
      return reply.code(400).send({ error: "orderedIds (string[]) required" });
    }
    await api.reorderTickets(id, body.orderedIds);
    return { ok: true };
  });

  app.post("/api/projects/:id/tickets/cleanup", async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      confirmation?: string;
      removeBranches?: boolean;
      removePullRequests?: boolean;
    };
    return api.cleanupTickets(id, {
      confirmation: typeof body.confirmation === "string" ? body.confirmation : "",
      removeBranches: !!body.removeBranches,
      removePullRequests: !!body.removePullRequests,
    });
  });

  app.delete("/api/projects/:id/tickets/:ticketId", async (req) => {
    const { id, ticketId } = req.params as { id: string; ticketId: string };
    await api.deleteTicket(id, ticketId);
    return { ok: true };
  });

  app.get("/api/projects/:id/roles", (req) => {
    const { id } = req.params as { id: string };
    return db.listRoles(id);
  });

  app.post("/api/projects/:id/roles", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      name?: string;
      description?: string;
      allowed?: string[];
      forbidden?: string[];
      allowedToolIds?: string[];
      forbiddenToolIds?: string[];
      backendId?: string;
      model?: string;
    };
    if (!body?.name) return reply.code(400).send({ error: "name required" });
    return api.upsertRole(id, {
      name: body.name,
      description: body.description ?? "",
      allowed: body.allowed ?? [],
      forbidden: body.forbidden ?? [],
      allowedToolIds: body.allowedToolIds ?? [],
      forbiddenToolIds: body.forbiddenToolIds ?? [],
      backendId: body.backendId ?? "codex",
      model: body.model,
    });
  });

  // Create/update a project role from a gallery template (copies tool permissions).
  app.post("/api/projects/:id/roles/from-template", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { id?: string; name?: string; source?: AgentTemplateSource };
    if (body?.source && body.source !== "builtin" && body.source !== "custom") {
      return reply.code(400).send({ error: "source must be builtin|custom" });
    }
    if (!body?.name && !body?.id) return reply.code(400).send({ error: "name or id required" });
    return api.applyTemplate(id, { id: body.id, name: body.name, source: body.source });
  });

  app.delete("/api/projects/:id/roles/:name", async (req) => {
    const { id, name } = req.params as { id: string; name: string };
    await api.deleteRole(id, decodeURIComponent(name));
    return { ok: true };
  });

  app.post("/api/orchestrator/start", () => {
    api.startOrchestrator();
    return { state: api.orchestratorState() };
  });
  app.post("/api/orchestrator/pause", () => {
    api.pauseOrchestrator();
    return { state: api.orchestratorState() };
  });
  app.post("/api/orchestrator/stop", async () => {
    await api.stopOrchestrator();
    return { state: api.orchestratorState() };
  });

  // ---- dashboard SPA (if built) ----
  if (deps.dashboardDir && existsSync(deps.dashboardDir)) {
    app.register(fastifyStatic, { root: deps.dashboardDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html", join(deps.dashboardDir!));
    });
  }

  return app;
}
