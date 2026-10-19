// HTTP routes: health, model gateway, harness builds/installers, update packages, and the
// built console (apps/web/dist) as a single-page app.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { HarnessBuild, ProviderId } from "@alliance/protocol";
import { generateBuildFiles, installScript, zipBuild } from "@alliance/harness-kit";
import type { App } from "./app.js";
import { hashToken, sameHash } from "./ids.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function apiError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { type: code, code, message } });
}

export function registerRoutes(http: FastifyInstance, app: App): void {
  const { core } = app;

  http.get("/api/health", async () => ({ ok: true, harnessVersion: core.harnessSources().hash.slice(0, 12) }));

  // -- builds -------------------------------------------------------------------------

  /** A pending build + its enrollment token, if `t` is that build's token. */
  function buildFor(req: FastifyRequest<{ Params: { id: string }; Querystring: { t?: string } }>): { build: HarnessBuild; token: string } | undefined {
    const build = core.builds.get(req.params.id);
    const t = req.query.t ?? "";
    const stored = core.db.get<{ hash: string; enc: string }>("build_tokens", req.params.id);
    if (!build || !stored || build.status !== "pending" || new Date(build.expiresAt).getTime() < Date.now()) return undefined;
    if (!sameHash(stored.hash, hashToken(t))) return undefined;
    return { build, token: core.secrets.decrypt(stored.enc) };
  }

  http.get<{ Params: { id: string }; Querystring: { t?: string } }>("/api/builds/:id/download", async (req, reply) => {
    const found = buildFor(req);
    if (!found) return apiError(reply, 404, "build_unavailable", "This build doesn't exist, was already used, expired or was revoked. Generate a new one in the console.");
    const { build, token } = found;
    const files = generateBuildFiles({ build, enrollmentToken: token }, core.harnessSources().files);
    const name = `${files[0]!.path.split("/")[0]}-${build.os}.zip`;
    return reply.header("content-type", "application/zip").header("content-disposition", `attachment; filename="${name}"`).send(Buffer.from(zipBuild(files)));
  });

  for (const file of ["install.ps1", "install.sh"] as const) {
    http.get<{ Params: { id: string }; Querystring: { t?: string } }>(`/api/builds/:id/${file}`, async (req, reply) => {
      const found = buildFor(req);
      if (!found) return reply.code(404).type("text/plain").send("echo 'This build is no longer available. Generate a new one in the console.'\n");
      return reply.type("text/plain; charset=utf-8").send(installScript(found.build));
    });
  }

  // -- self-update package (DESIGN §4.5) -------------------------------------------------

  http.get("/api/harness/package", async (req, reply) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!token || !app.harnesses.harnessForToken(token)) return apiError(reply, 401, "invalid_token", "harness token required");
    const src = core.harnessSources();
    return reply.header("content-type", "application/zip").header("x-source-hash", src.hash).header("x-sha256", src.sha256).send(Buffer.from(src.zip));
  });

  // -- model gateway (DESIGN §5a.2) ------------------------------------------------------

  http.route<{ Params: { provider: string; "*": string } }>({
    method: ["GET", "POST"],
    url: "/gateway/:provider/*",
    handler: async (req, reply) => {
      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const harnessId = app.harnesses.gatewayHarness(token);
      if (!harnessId) return apiError(reply, 401, "invalid_token", "Invalid or expired gateway token");
      const providerId = req.params.provider as ProviderId;
      const p = core.providerSettings(providerId);
      const key = p ? core.providerKey(providerId) : undefined;
      if (!p || !p.enabled || !p.available || !key) return apiError(reply, 401, "credentials_missing", `No API key for ${req.params.provider}; set it in Settings`);

      const runId = String(req.headers["x-alliance-run"] ?? "");
      const run = core.runs.get(runId);
      const task = run && run.harnessId === harnessId ? core.tasks.get(run.taskId) : undefined;
      if (task?.budget?.tokens && task.usedTokens >= task.budget.tokens) {
        return apiError(reply, 429, "budget_exceeded", `Task budget of ${task.budget.tokens} tokens is used up`);
      }

      const def = core.providerDefinition(providerId);
      const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      const body = req.method === "POST" ? JSON.stringify(req.body ?? {}) : undefined;
      const started = Date.now();
      let upstream: Response;
      try {
        upstream = await fetch(`${p.baseUrl}/${req.params["*"]}${query}`, {
          method: req.method,
          headers: {
            "content-type": "application/json",
            accept: String(req.headers.accept ?? "application/json"),
            ...(def.auth.header === "authorization" ? { authorization: `Bearer ${key}` } : { "x-api-key": key }),
          },
          ...(body ? { body } : {}),
          signal: AbortSignal.timeout(15 * 60 * 1000),
        });
      } catch (e) {
        return apiError(reply, 502, "upstream_unreachable", `Could not reach ${p.label}: ${(e as Error).message}`);
      }

      // Stream the response through unchanged and pick the usage numbers out on the way.
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-cache" });
      const isStream = (upstream.headers.get("content-type") ?? "").includes("event-stream");
      const decoder = new TextDecoder();
      let buffer = "";
      let usage: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number } | undefined;
      const scan = (line: string) => {
        const data = line.startsWith("data:") ? line.slice(5).trim() : isStream ? "" : line;
        if (!data || data === "[DONE]" || !data.includes("usage")) return;
        try {
          const obj = JSON.parse(data) as { usage?: typeof usage };
          if (obj.usage) usage = obj.usage;
        } catch {
          /* partial or non-JSON line */
        }
      };
      try {
        if (upstream.body) {
          for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
            raw.write(chunk);
            buffer += decoder.decode(chunk, { stream: true });
            if (isStream) {
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              lines.forEach(scan);
            }
          }
        }
        scan(buffer);
      } finally {
        raw.end();
      }
      if (usage && upstream.ok) {
        const reqBody = (req.body ?? {}) as { model?: string };
        core.recordUsage({
          ts: Date.now(), provider: providerId, model: reqBody.model ?? "", source: "gateway", durationMs: Date.now() - started,
          inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0, cacheReadTokens: usage.prompt_cache_hit_tokens ?? 0,
          ...(run && run.harnessId === harnessId ? { agentId: run.agentId, runId: run.id, taskId: run.taskId } : {}),
        });
      } else if (!upstream.ok) {
        core.event("error", { kind: "overseer", id: "gateway" }, "gateway.error", `${p.label} returned HTTP ${upstream.status} for ${core.agents.get(run?.agentId ?? "")?.name ?? "a harness"}`, { ...(run ? { agentId: run.agentId, runId: run.id } : {}) });
      }
    },
  });

  // -- console (single-page app) -----------------------------------------------------------

  const root = resolve(core.cfg.webDist);
  http.setNotFoundHandler((req, reply) => {
    const path = req.url.split("?")[0] ?? "/";
    if (req.method !== "GET" || path.startsWith("/api/") || path.startsWith("/gateway/") || path.startsWith("/ws/")) {
      return apiError(reply, 404, "not_found", `No route for ${req.method} ${path}`);
    }
    if (!existsSync(join(root, "index.html"))) {
      return reply.type("text/html").send("<!doctype html><title>United Alliance</title><p>The console isn't built yet. Run <code>start.cmd</code> and choose Live, or <code>npm run build -w @alliance/web</code> with <code>VITE_MOCK=0</code>.</p>");
    }
    const file = normalize(join(root, decodeURIComponent(path)));
    const inside = file === root || file.startsWith(root + sep);
    const target = inside && existsSync(file) && statSync(file).isFile() ? file : join(root, "index.html");
    const type = MIME[extname(target)] ?? "application/octet-stream";
    const cache = target.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
    return reply.type(type).header("cache-control", cache).send(readFileSync(target));
  });
}
