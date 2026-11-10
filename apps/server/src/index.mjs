/**
 * Pi-Pentest M1 server
 *
 * 一个进程同时提供：
 *   - 浏览器 API（REST + SSE）
 *   - 内部 API（pi-kit 扩展回调：dispatch / facts / brief）
 *   - agent 调度（每个 agent 是一个 pi RPC 子进程）
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import {
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
import { Supervisor } from "./supervisor.mjs";
import { DB_PATH } from "./config.mjs";

ensureRuntimeDirs();
writeModelsJson();

const store = openStore(DB_PATH);
const sseClients = new Set();

function broadcast(event) {
	const payload = JSON.stringify(event);
	for (const client of sseClients) {
		if (client.projectId !== event.projectId) continue;
		writeSse(client.res, event, payload);
	}
}

function writeSse(res, event, payload) {
	if (res.writableEnded) return;
	if (event.id) res.write(`id: ${event.id}\n`);
	res.write(`data: ${payload}\n\n`);
}

const supervisor = new Supervisor({
	store,
	broadcast,
	serverUrl: `http://${SERVER_HOST}:${SERVER_PORT}`,
});

const server = createServer(async (req, res) => {
	try {
		await route(req, res);
	} catch (error) {
		console.error("[server]", error);
		if (!res.headersSent) sendJson(res, 500, { error: String(error?.message ?? error) });
		else res.end();
	}
});

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

	if (path === "/api/projects" && method === "GET") {
		return sendJson(res, 200, { projects: store.listProjects() });
	}

	if (path === "/api/projects" && method === "POST") {
		const body = await readJson(req);
		if (!body.target) return sendJson(res, 400, { error: "target 必填" });
		if (!activeModelEnv()) return sendJson(res, 409, { error: "请先在「模型设置」里配置模型" });
		const name = body.name || `项目 ${new Date().toLocaleString("zh-CN")}`;
		const { project, commander } = await supervisor.createProject({ name, target: body.target });
		return sendJson(res, 200, { project, commander });
	}

	const projectMatch = /^\/api\/projects\/([^/]+)(?:\/(.*))?$/.exec(path);
	if (projectMatch) {
		const projectId = projectMatch[1];
		const rest = projectMatch[2] ?? "";
		const project = store.getProject(projectId);
		if (!project) return sendJson(res, 404, { error: "项目不存在" });

		if (!rest && method === "GET") return sendJson(res, 200, { project });

		if (rest === "agents" && method === "GET") {
			return sendJson(res, 200, { agents: store.listAgents(projectId) });
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

		if (!rest && method === "GET") return sendJson(res, 200, { agent });

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
			if (!supervisor.hasClient(agentId)) {
				return sendJson(res, 409, {
					error:
						"该 agent 的进程已不在运行（服务重启后旧进程会结束）。M1 暂不支持恢复会话，请新建项目重跑；历史记录仍可回放。",
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

console.log(`[pi-pentest] server http://${SERVER_HOST}:${SERVER_PORT}`);
console.log(`[pi-pentest] model  ${JSON.stringify(activeModelEnv())}`);
console.log(`[pi-pentest] db     ${DB_PATH}`);
if (!activeModelEnv()) console.log("[pi-pentest] 未配置模型：请在 WebUI 的「模型设置」里填写 API 后再新建项目");

// 进程重启后旧 agent 子进程必然已结束：标记为 error，避免 UI 误以为还能对话
for (const project of store.listProjects()) {
	for (const agent of store.listAgents(project.id)) {
		if (agent.status === "running" || agent.status === "starting") {
			store.saveAgent({
				...agent,
				status: "error",
				error: "服务重启，agent 进程已结束（M2 将支持会话恢复）",
			});
		}
	}
}

server.listen(SERVER_PORT, SERVER_HOST);

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, async () => {
		await supervisor.shutdown();
		server.close(() => process.exit(0));
	});
}
