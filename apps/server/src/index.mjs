/**
 * Pi-Pentest M1 server
 *
 * 一个进程同时提供：
 *   - 浏览器 API（REST + SSE）
 *   - 内部 API（pi-kit 扩展回调：dispatch / facts / brief）
 *   - agent 调度（每个 agent 是一个 pi RPC 子进程）
 */
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import {
	LIMITS,
	SERVER_HOST,
	SERVER_PORT,
	WEB_DIST,
	activeModelEnv,
	ensureRuntimeDirs,
	llmApiKeyEnv,
	publicConfig,
	resolvePiCliPath,
	saveCustomProvider,
	setActiveModel,
	writeModelsJson,
} from "./config.mjs";
import { openStore } from "../../../packages/db/src/index.mjs";
import { Supervisor, seedIdCounter } from "./supervisor.mjs";
import { McpManager } from "./mcp.mjs";
import { EvidenceService } from "./evidence.mjs";
import { ToolRegistry } from "./tools.mjs";
import { DB_PATH, RUNTIME } from "./config.mjs";

ensureRuntimeDirs();
writeModelsJson();

const store = openStore(DB_PATH);
seedIdCounter(store);
const sseClients = new Set();

// 把服务端错误落盘，避免进程意外退出后无从排查（M1 之前只打到终端）
const SERVER_LOG = join(RUNTIME, "server.log");
function logLine(line) {
	try {
		appendFileSync(SERVER_LOG, `[${new Date().toISOString()}] ${line}\n`);
	} catch {
		/* ignore logging failure */
	}
}

function broadcast(event) {
	const payload = JSON.stringify(event);
	for (const client of sseClients) {
		if (client.projectId !== event.projectId) continue;
		writeSse(client.res, event, payload);
	}
}

function writeSse(res, event, payload) {
	if (res.writableEnded || res.destroyed) return;
	try {
		if (event.id) res.write(`id: ${event.id}\n`);
		res.write(`data: ${payload}\n\n`);
	} catch (error) {
		logLine(`sse write failed: ${String(error?.message ?? error)}`);
	}
}

const supervisor = new Supervisor({
	store,
	broadcast,
	serverUrl: `http://${SERVER_HOST}:${SERVER_PORT}`,
});

const mcpManager = new McpManager();
const toolRegistry = new ToolRegistry({ store, broadcast, mcp: mcpManager });
const evidenceService = new EvidenceService({ store, broadcast });

const server = createServer(async (req, res) => {
	try {
		await route(req, res);
	} catch (error) {
		logLine(`request error ${req.method} ${req.url}: ${error?.stack ?? error}`);
		console.error("[server]", error);
		if (!res.headersSent) sendJson(res, 500, { error: friendlyError(error) });
		else res.end();
	}
});

function friendlyError(error) {
	const message = String(error?.message ?? error);
	if (message.includes("UNIQUE constraint")) {
		return "数据 ID 冲突（服务重启后计数器未恢复导致）。请刷新页面重试；若持续出现请删除 .runtime/pi-pentest.db 后重启。";
	}
	return message;
}

/* ------------------------------- 路由 ------------------------------- */

async function route(req, res) {
	const url = new URL(req.url ?? "/", `http://${SERVER_HOST}:${SERVER_PORT}`);
	const path = url.pathname;

	if (path.startsWith("/api/")) return routeApi(req, res, url);
	if (path.startsWith("/internal/")) return routeInternal(req, res, url);
	if (path === "/") return serveStatic(res, "/index.html");
	return serveStatic(res, path);
}

async function routeApi(req, res, url) {
	const path = url.pathname;
	const method = req.method ?? "GET";

	if (path === "/api/health" && method === "GET") {
		const model = activeModelEnv();
		return sendJson(res, 200, {
			ok: true,
			piCli: resolvePiCliPath(),
			model,
			configured: Boolean(model),
			hasKey: Boolean(llmApiKeyEnv()),
			limits: LIMITS,
			time: Date.now(),
		});
	}

	if (path === "/api/config" && method === "GET") {
		return sendJson(res, 200, publicConfig());
	}

	if (path === "/api/config" && method === "PUT") {
		const body = await readJson(req);
		if (body.baseUrl || body.modelId) {
			if (!body.baseUrl || !body.modelId) return sendJson(res, 400, { error: "baseUrl 和模型 ID 必填" });
			return sendJson(res, 200, saveCustomProvider(body));
		}
		if (body.provider && body.model) return sendJson(res, 200, setActiveModel(body.provider, body.model));
		return sendJson(res, 400, { error: "无法识别的配置请求" });
	}

	// ---------------------------- 工具注册表 ----------------------------
	if (path === "/api/tool-categories" && method === "GET") {
		return sendJson(res, 200, { categories: toolRegistry.categories() });
	}
	if (path === "/api/tool-categories" && method === "POST") {
		const body = await readJson(req);
		try {
			return sendJson(res, 200, { categories: toolRegistry.addCategory(body.name) });
		} catch (error) {
			return sendJson(res, 400, { error: String(error?.message ?? error) });
		}
	}
	const categoryMatch = /^\/api\/tool-categories\/(.+)$/.exec(path);
	if (categoryMatch && method === "DELETE") {
		try {
			return sendJson(res, 200, { categories: toolRegistry.removeCategory(decodeURIComponent(categoryMatch[1])) });
		} catch (error) {
			return sendJson(res, 400, { error: String(error?.message ?? error) });
		}
	}

	if (path === "/api/tools" && method === "GET") {
		return sendJson(res, 200, { tools: toolRegistry.list(), categories: toolRegistry.categories() });
	}

	if (path === "/api/tools" && method === "POST") {
		const body = await readJson(req);
		try {
			const tool = toolRegistry.save(body.tool ?? body);
			return sendJson(res, 200, { tool });
		} catch (error) {
			return sendJson(res, 400, { error: String(error?.message ?? error) });
		}
	}

	const toolMatch = /^\/api\/tools\/([a-z0-9-]+)(?:\/(launch|run|mcp|mcp\/call))?$/.exec(path);
	const runMatch = /^\/api\/tool-runs\/([^/]+)$/.exec(path);
	if (runMatch && method === "GET") {
		const run = toolRegistry.getLaunch(runMatch[1]);
		return run ? sendJson(res, 200, { run }) : sendJson(res, 404, { error: "运行记录不存在" });
	}
	if (toolMatch) {
		const toolId = toolMatch[1];
		const action = toolMatch[2];
		if (action === "launch" && method === "POST") {
			const body = await readJson(req).catch(() => ({}));
			try {
				const result = await toolRegistry.launch({ toolId, args: body.args ?? {} });
				return sendJson(res, 200, result);
			} catch (error) {
				return sendJson(res, 400, { error: String(error?.message ?? error) });
			}
		}
		if (action === "mcp" && method === "GET") {
			const tool = toolRegistry.get(toolId);
			if (!tool || tool.type !== "mcp") return sendJson(res, 404, { error: "MCP 工具不存在" });
			const listed = await toolRegistry.mcp.listTools(tool);
			return sendJson(res, 200, listed);
		}
		if (action === "mcp/call" && method === "POST") {
			const body = await readJson(req);
			const tool = toolRegistry.get(toolId);
			if (!tool || tool.type !== "mcp") return sendJson(res, 404, { error: "MCP 工具不存在" });
			try {
				const result = await toolRegistry.run({
					toolId: `mcp:${toolId}/${body.tool}`,
					projectId: body.projectId ?? "toolbox",
					agentId: "ui",
					args: body.args ?? {},
				});
				return sendJson(res, 200, { result });
			} catch (error) {
				return sendJson(res, 400, { error: String(error?.message ?? error) });
			}
		}
		if (action === "run" && method === "POST") {
			const body = await readJson(req);
			try {
				const result = await toolRegistry.run({
					toolId,
					projectId: body.projectId,
					agentId: body.agentId,
					args: body.args ?? {},
				});
				return sendJson(res, 200, { result });
			} catch (error) {
				return sendJson(res, 400, { error: String(error?.message ?? error) });
			}
		}
		if (method === "PUT") {
			const body = await readJson(req);
			try {
				const tool = toolRegistry.save(body.yaml ?? body.tool ?? body);
				return sendJson(res, 200, { tool });
			} catch (error) {
				return sendJson(res, 400, { error: String(error?.message ?? error) });
			}
		}
		if (method === "DELETE") {
			const removed = toolRegistry.remove(toolId);
			return sendJson(res, removed ? 200 : 404, { ok: removed });
		}
		if (method === "GET") {
			const tool = toolRegistry.get(toolId);
			return tool ? sendJson(res, 200, { tool: toolRegistry.list().find((item) => item.id === toolId) ?? tool }) : sendJson(res, 404, { error: "工具不存在" });
		}
	}

	// ---------------------------- Artifact ----------------------------
	const artifactMatch = /^\/api\/artifacts\/([^/]+)(?:\/(raw))?$/.exec(path);
	if (artifactMatch) {
		const artifactId = artifactMatch[1];
		const raw = artifactMatch[2] === "raw";
		const artifact = store.getArtifact(artifactId);
		if (!artifact) return sendJson(res, 404, { error: "artifact 不存在" });
		if (!raw) return sendJson(res, 200, { artifact });
		try {
			const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
			const limit = Number(url.searchParams.get("limit") ?? 200000) || 200000;
			const part = toolRegistry.readArtifact(artifactId, { offset, limit });
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			res.end(part.text);
			return;
		} catch (error) {
			return sendJson(res, 404, { error: String(error?.message ?? error) });
		}
	}

	// ---------------------------- M4：finding / 证据 ----------------------------
	const findingMatch = /^\/api\/findings\/([^/]+)(?:\/(verify))?$/.exec(path);
	if (findingMatch) {
		const findingId = findingMatch[1];
		if (findingMatch[2] === "verify" && method === "POST") {
			const body = await readJson(req);
			const finding = store.getFinding(findingId);
			if (!finding) return sendJson(res, 404, { error: "finding 不存在" });
			try {
				const result = await evidenceService.verifyFinding({
					projectId: finding.projectId,
					agentId: body.agentId ?? null,
					findingId,
					evidenceIds: body.evidenceIds ?? body.evidence_ids,
					verdict: body.verdict,
					rationale: body.rationale ?? "",
				});
				return sendJson(res, 200, result);
			} catch (error) {
				return sendJson(res, 400, { error: String(error?.message ?? error) });
			}
		}
		if (method === "GET") {
			const detail = evidenceService.findingDetail(findingId);
			return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: "finding 不存在" });
		}
	}

	if (path === "/api/projects" && method === "GET") {
		return sendJson(res, 200, { projects: store.listProjects() });
	}

	if (path === "/api/projects" && method === "POST") {
		const body = await readJson(req);
		if (!body.target) return sendJson(res, 400, { error: "target 必填" });
		if (!activeModelEnv()) return sendJson(res, 409, { error: "请先在「模型设置」里配置模型" });
		const name = body.name || `项目 ${new Date().toLocaleString("zh-CN")}`;
		const { project, commander } = await supervisor.createProject({
			name,
			target: body.target,
			kickoff: body.kickoff,
		});
		return sendJson(res, 200, { project, commander });
	}

	const projectMatch = /^\/api\/projects\/([^/]+)(?:\/(.*))?$/.exec(path);
	if (projectMatch) {
		const projectId = projectMatch[1];
		const rest = projectMatch[2] ?? "";
		const project = store.getProject(projectId);
		if (!project) return sendJson(res, 404, { error: "项目不存在" });

		if (!rest && method === "GET") return sendJson(res, 200, { project });

		if (!rest && method === "DELETE") {
			await supervisor.stopProject(projectId);
			store.deleteProject(projectId);
			// 项目删除后同步清掉 runtime 目录（会话 / 工具产物），避免残留
			await rm(join(RUNTIME, "projects", projectId), { recursive: true, force: true }).catch(() => {});
			return sendJson(res, 200, { ok: true, deleted: projectId });
		}

		if (rest === "agents" && method === "GET") {
			const agents = store.listAgents(projectId).map((agent) => ({
				...agent,
				connected: supervisor.hasClient(agent.id),
			}));
			return sendJson(res, 200, { agents });
		}

		if (rest === "agents" && method === "POST") {
			const body = await readJson(req);
			const role = body.role ?? "recon";
			const objective = body.objective || `对 ${project.target} 做 ${role} 测试`;
			const root = store.listAgents(projectId).find((agent) => !agent.parentId);
			const agent = await supervisor.createAgent({
				projectId,
				parentId: root?.id ?? null,
				role,
				objective,
				targets: body.targets ?? [project.target],
				factIds: body.factIds ?? [],
			});
			return sendJson(res, 200, { agent });
		}

		if (rest === "facts" && method === "GET") {
			return sendJson(res, 200, { facts: store.listFacts(projectId) });
		}

		if (rest === "artifacts" && method === "GET") {
			return sendJson(res, 200, { artifacts: store.listArtifacts(projectId) });
		}

		// ---------------------------- M4：证据 / finding / coverage ----------------------------
		if (rest === "findings" && method === "GET") {
			return sendJson(res, 200, { findings: evidenceService.listFindings(projectId) });
		}

		if (rest === "findings" && method === "POST") {
			const body = await readJson(req);
			try {
				const result = await evidenceService.submitFinding({ projectId, agentId: body.agentId ?? null, input: body });
				return sendJson(res, result.duplicate_of ? 200 : 201, result);
			} catch (error) {
				return sendJson(res, 400, {
					error: String(error?.message ?? error),
					code: error?.code ?? "FINDING_REJECTED",
					details: error?.details,
				});
			}
		}

		if (rest === "coverage" && method === "GET") {
			return sendJson(res, 200, { coverage: store.listCoverage(projectId) });
		}

		if (rest === "coverage" && method === "POST") {
			const body = await readJson(req);
			try {
				const coverage = await evidenceService.updateCoverage({ projectId, agentId: body.agentId ?? null, input: body });
				return sendJson(res, 200, { coverage });
			} catch (error) {
				return sendJson(res, 400, { error: String(error?.message ?? error) });
			}
		}

		if (rest === "http-send" && method === "POST") {
			const body = await readJson(req);
			try {
				const result = await evidenceService.httpSend({
					projectId,
					agentId: body.agentId ?? null,
					method: body.method,
					url: body.url,
					headers: body.headers ?? {},
					body: body.body,
					timeoutMs: body.timeoutMs,
				});
				return sendJson(res, 200, { result });
			} catch (error) {
				return sendJson(res, 400, { error: String(error?.message ?? error) });
			}
		}

		if (rest === "exchanges" && method === "GET") {
			return sendJson(res, 200, { exchanges: store.listExchanges(projectId) });
		}

		if (rest === "events" && method === "GET") {
			const after = Number(url.searchParams.get("after") ?? 0) || 0;
			res.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			});
			res.write(": connected\n\n");
			const client = { res, projectId };
			sseClients.add(client);
			for (const event of store.eventsAfter(projectId, after)) writeSse(res, event, JSON.stringify(event));
			req.on("close", () => sseClients.delete(client));
			return;
		}

		if (rest === "brief" && method === "GET") {
			const root = store.listAgents(projectId).find((agent) => !agent.parentId);
			return sendJson(res, 200, { brief: root ? supervisor.buildBrief(root.id) : "" });
		}
	}

	const agentMatch = /^\/api\/agents\/([^/]+)(?:\/(.*))?$/.exec(path);
	if (agentMatch) {
		const agentId = agentMatch[1];
		const rest = agentMatch[2] ?? "";
		const agent = store.getAgent(agentId);
		if (!agent) return sendJson(res, 404, { error: "agent 不存在" });

		if (!rest && method === "GET") {
			return sendJson(res, 200, { agent: { ...agent, connected: supervisor.hasClient(agentId) } });
		}

		if (rest === "messages" && method === "GET") {
			const messages = store
				.eventsForAgent(agentId)
				.filter((event) => event.type === "message")
				.map((event) => event.payload);
			return sendJson(res, 200, { messages });
		}

		if (rest === "messages" && method === "POST") {
			const body = await readJson(req);
			if (!body.text?.trim()) return sendJson(res, 400, { error: "text 不能为空" });
			if (agent.status === "queued") {
				return sendJson(res, 409, { error: "agent 正在排队等待启动，请稍后再发" });
			}
			if (!supervisor.hasClient(agentId)) {
				return sendJson(res, 409, {
					error:
						"该 agent 的进程已不在运行（服务重启后旧进程会结束）。可以点会话头部的「恢复会话」接回原会话，历史记录不会丢。",
				});
			}
			const result = await supervisor.userMessage(agentId, body.text);
			return sendJson(res, 200, result);
		}

		if (rest === "abort" && method === "POST") {
			if (!supervisor.hasClient(agentId)) return sendJson(res, 409, { error: "agent 进程已结束" });
			await supervisor.abort(agentId);
			return sendJson(res, 200, { ok: true });
		}

		if (rest === "resume" && method === "POST") {
			const resumed = await supervisor.resumeAgent(agentId);
			return sendJson(res, 200, { agent: resumed });
		}
	}

	return sendJson(res, 404, { error: `未知接口: ${req.method} ${path}` });
}

async function routeInternal(req, res, url) {
	const token = req.headers["x-pi-pentest-token"];
	if (token !== supervisor.token) return sendJson(res, 403, { error: "invalid token" });

	const path = url.pathname;
	const method = req.method ?? "GET";

	if (path === "/internal/dispatch" && method === "POST") {
		const body = await readJson(req);
		if (!body.projectId || !body.role || !body.objective) {
			return sendJson(res, 400, { error: "projectId / role / objective 必填" });
		}
		if (!activeModelEnv()) return sendJson(res, 409, { error: "未配置模型，无法派发子 agent" });
		const agent = await supervisor.createAgent({
			projectId: body.projectId,
			parentId: body.parentAgentId ?? null,
			role: body.role,
			objective: body.objective,
			targets: body.targets ?? [],
			factIds: body.factIds ?? [],
		});
		return sendJson(res, 200, { agentId: agent.id, role: agent.role });
	}

	if (path === "/internal/facts" && method === "POST") {
		const body = await readJson(req);
		if (!body.projectId || !body.kind || !body.title) {
			return sendJson(res, 400, { error: "projectId / kind / title 必填" });
		}
		const fact = supervisor.addFact({
			projectId: body.projectId,
			agentId: body.agentId,
			kind: body.kind,
			title: body.title,
			value: body.value ?? {},
			confidence: body.confidence ?? 0.8,
		});
		return sendJson(res, 200, { id: fact.id, fact });
	}

	if (path === "/internal/facts" && method === "GET") {
		const projectId = url.searchParams.get("projectId");
		if (!projectId) return sendJson(res, 400, { error: "projectId 必填" });
		const query = (url.searchParams.get("q") ?? "").toLowerCase();
		const kind = url.searchParams.get("kind");
		const limit = Number(url.searchParams.get("limit") ?? 20) || 20;
		let facts = store.listFacts(projectId);
		if (kind) facts = facts.filter((fact) => fact.kind === kind);
		if (query) {
			facts = facts.filter(
				(fact) =>
					fact.title.toLowerCase().includes(query) ||
					JSON.stringify(fact.value).toLowerCase().includes(query),
			);
		}
		return sendJson(res, 200, { facts: facts.slice(-limit) });
	}

	if (path === "/internal/brief" && method === "GET") {
		const agentId = url.searchParams.get("agentId");
		if (!agentId) return sendJson(res, 400, { error: "agentId 必填" });
		return sendJson(res, 200, { brief: supervisor.buildBrief(agentId) });
	}

	if (path === "/internal/tools" && method === "GET") {
		return sendJson(res, 200, { tools: await toolRegistry.listForAgent() });
	}

	if (path === "/internal/tools/run" && method === "POST") {
		const body = await readJson(req);
		if (!body.projectId || !body.toolId) return sendJson(res, 400, { error: "projectId / toolId 必填" });
		try {
			const result = await toolRegistry.run({
				toolId: body.toolId,
				projectId: body.projectId,
				agentId: body.agentId,
				args: body.args ?? {},
			});
			return sendJson(res, 200, result);
		} catch (error) {
			return sendJson(res, 400, { error: String(error?.message ?? error) });
		}
	}

	if (path === "/internal/artifacts/read" && method === "POST") {
		const body = await readJson(req);
		if (!body.artifactId) return sendJson(res, 400, { error: "artifactId 必填" });
		try {
			return sendJson(
				res,
				200,
				toolRegistry.readArtifact(body.artifactId, { offset: body.offset ?? 0, limit: body.limit ?? 20000 }),
			);
		} catch (error) {
			return sendJson(res, 404, { error: String(error?.message ?? error) });
		}
	}

	// ---------------------------- M4：证据 / finding / coverage ----------------------------
	if (path === "/internal/http/send" && method === "POST") {
		const body = await readJson(req);
		if (!body.projectId || !body.url) return sendJson(res, 400, { error: "projectId / url 必填" });
		try {
			const result = await evidenceService.httpSend({
				projectId: body.projectId,
				agentId: body.agentId ?? null,
				method: body.method,
				url: body.url,
				headers: body.headers ?? {},
				body: body.body,
				timeoutMs: body.timeoutMs,
			});
			return sendJson(res, 200, result);
		} catch (error) {
			return sendJson(res, 400, { error: String(error?.message ?? error) });
		}
	}

	if (path === "/internal/findings/submit" && method === "POST") {
		const body = await readJson(req);
		if (!body.projectId) return sendJson(res, 400, { error: "projectId 必填" });
		try {
			const result = await evidenceService.submitFinding({
				projectId: body.projectId,
				agentId: body.agentId ?? null,
				input: body.finding ?? body,
			});
			return sendJson(res, 200, result);
		} catch (error) {
			return sendJson(res, 400, {
				error: String(error?.message ?? error),
				code: error?.code ?? "FINDING_REJECTED",
				details: error?.details,
			});
		}
	}

	if (path === "/internal/findings/verify" && method === "POST") {
		const body = await readJson(req);
		if (!body.projectId || !body.findingId) return sendJson(res, 400, { error: "projectId / findingId 必填" });
		try {
			const result = await evidenceService.verifyFinding({
				projectId: body.projectId,
				agentId: body.agentId ?? null,
				findingId: body.findingId,
				evidenceIds: body.evidenceIds ?? body.evidence_ids,
				verdict: body.verdict,
				rationale: body.rationale ?? "",
			});
			return sendJson(res, 200, result);
		} catch (error) {
			return sendJson(res, 400, { error: String(error?.message ?? error) });
		}
	}

	if (path === "/internal/coverage/update" && method === "POST") {
		const body = await readJson(req);
		if (!body.projectId) return sendJson(res, 400, { error: "projectId 必填" });
		try {
			const coverage = await evidenceService.updateCoverage({
				projectId: body.projectId,
				agentId: body.agentId ?? null,
				input: body.coverage ?? body,
			});
			return sendJson(res, 200, { coverage });
		} catch (error) {
			return sendJson(res, 400, { error: String(error?.message ?? error) });
		}
	}

	if (path === "/internal/findings" && method === "GET") {
		const projectId = url.searchParams.get("projectId");
		if (!projectId) return sendJson(res, 400, { error: "projectId 必填" });
		return sendJson(res, 200, {
			findings: evidenceService.listFindings(projectId).map((finding) => ({
				id: finding.id,
				title: finding.title,
				category: finding.category,
				severity: finding.severity,
				status: finding.status,
				target: finding.target,
				confidence: finding.confidence,
				poc: finding.poc,
				evidenceCount: finding.evidenceCount,
			})),
		});
	}

	if (path === "/internal/finding" && method === "GET") {
		const findingId = url.searchParams.get("findingId");
		if (!findingId) return sendJson(res, 400, { error: "findingId 必填" });
		const detail = evidenceService.findingDetail(findingId);
		return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: "finding 不存在" });
	}

	if (path === "/internal/coverage" && method === "GET") {
		const projectId = url.searchParams.get("projectId");
		if (!projectId) return sendJson(res, 400, { error: "projectId 必填" });
		return sendJson(res, 200, { coverage: store.listCoverage(projectId) });
	}

	return sendJson(res, 404, { error: `未知内部接口: ${path}` });
}

/* ------------------------------- 静态资源 ------------------------------- */

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
};

async function serveStatic(res, urlPath) {
	const relative = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, "");
	const filePath = join(WEB_DIST, relative);
	if (!filePath.startsWith(WEB_DIST)) return sendJson(res, 403, { error: "forbidden" });
	try {
		const info = await stat(filePath);
		if (info.isDirectory()) throw new Error("directory");
		const content = await readFile(filePath);
		res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
		res.end(content);
	} catch {
		// SPA fallback
		try {
			const index = await readFile(join(WEB_DIST, "index.html"));
			res.writeHead(200, { "content-type": MIME[".html"] });
			res.end(index);
		} catch {
			sendJson(res, 404, {
				error: "WebUI 尚未构建。开发模式请运行 npm run dev（Vite 在 5173）；或先 npm run build:web。",
			});
		}
	}
}

/* ------------------------------- 工具 ------------------------------- */

function sendJson(res, status, data) {
	if (res.headersSent) {
		res.end();
		return;
	}
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(data));
}

async function readJson(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString("utf8");
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

/* ------------------------------- 启动 ------------------------------- */

const model = activeModelEnv();
console.log(`[pi-pentest] server http://${SERVER_HOST}:${SERVER_PORT}`);
console.log(`[pi-pentest] model  ${JSON.stringify(model)}`);
console.log(`[pi-pentest] db     ${DB_PATH}`);
logLine(`start server port=${SERVER_PORT} model=${JSON.stringify(model)}`);
if (!model) console.log("[pi-pentest] 未配置模型：请在 WebUI 的「模型设置」里填写 API 后再新建项目");

// 异常统一落盘：以后进程意外退出能查 .runtime/server.log，而不是只看到一句 Failed to fetch
process.on("uncaughtException", (error) => {
	logLine(`uncaughtException: ${error?.stack ?? error}`);
	console.error("[server] uncaughtException", error);
	process.exit(1);
});
process.on("unhandledRejection", (reason) => {
	logLine(`unhandledRejection: ${reason?.stack ?? reason}`);
	console.error("[server] unhandledRejection", reason);
});

// 进程重启后旧 agent 子进程必然已结束：标记 interrupted，保留 session_file 供恢复。
// 注意 idle 也要处理：idle 只是"等着下一条消息"，进程同样已经没了，否则 UI 会显示空闲但发不了消息。
// queued 也要处理：进程重启后队列已经不存在，否则会永远停在"排队中"。
for (const project of store.listProjects()) {
	for (const agent of store.listAgents(project.id)) {
		const stale = agent.status === "running" || agent.status === "starting" || agent.status === "queued";
		const idleButDead = agent.status === "idle" && agent.sessionFile;
		if (stale || idleButDead) {
			store.saveAgent({
				...agent,
				status: "interrupted",
				error: "服务重启导致进程中断，可在会话头部点「恢复会话」继续原会话",
			});
		}
	}
}

// 崩溃前"子 agent 已完成但父 agent 没收到通知"的，补投一次
supervisor
	.reconcileAfterBoot()
	.then((count) => {
		if (count > 0) logLine(`reconciled ${count} unreported agent(s) after boot`);
	})
	.catch((error) => logLine(`reconcileAfterBoot failed: ${error?.stack ?? error}`));

server.listen(SERVER_PORT, SERVER_HOST);

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, async () => {
		logLine(`received ${signal}, shutting down`);
		await mcpManager.closeAll().catch(() => {});
		await supervisor.shutdown();
		server.close(() => process.exit(0));
	});
}
