import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChorusBus, Config, ControlApi } from "@chorus/core";
import type { ChorusDb } from "@chorus/db";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";

export interface WebDeps {
  db: ChorusDb;
  bus: ChorusBus;
  api: ControlApi;
  config: Config;
  /** Directory of the built dashboard SPA, if available. */
  dashboardDir?: string;
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
  app.get("/api/state", () => ({
    orchestrator: api.orchestratorState(),
    runningTasks: api.runningTaskIds(),
    quota: db.getQuota(),
    usageTotals: db.usageTotals(),
    backends: undefined,
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
      merges: db.listMerges(id),
      changelog: db.listChangelog(id),
    };
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
    const body = req.body as { baseBranch?: string; expectations?: string; groundRules?: string[] };
    return api.updateProjectSettings(id, body ?? {});
  });

  app.post("/api/projects/:id/spec", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { specText?: string };
    if (!body?.specText) return reply.code(400).send({ error: "specText required" });
    await api.provideSpec(id, body.specText);
    return { ok: true };
  });

  app.post("/api/projects/:id/tickets", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { title?: string; body?: string; roleName?: string; priority?: number };
    if (!body?.title || !body?.body) return reply.code(400).send({ error: "title and body required" });
    return api.addTicket(id, {
      title: body.title,
      body: body.body,
      roleName: body.roleName,
      priority: body.priority,
    });
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
      backendId?: string;
      model?: string;
    };
    if (!body?.name) return reply.code(400).send({ error: "name required" });
    return api.upsertRole(id, {
      name: body.name,
      description: body.description ?? "",
      allowed: body.allowed ?? [],
      forbidden: body.forbidden ?? [],
      backendId: body.backendId ?? "codex",
      model: body.model,
    });
  });

  app.delete("/api/projects/:id/roles/:name", async (req) => {
    const { id, name } = req.params as { id: string; name: string };
    await api.deleteRole(id, decodeURIComponent(name));
    return { ok: true };
  });

  app.post("/api/projects/:id/approve", async (req) => {
    const { id } = req.params as { id: string };
    return api.approveToMain(id);
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
