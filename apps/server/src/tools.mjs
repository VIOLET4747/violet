/**
 * 工具箱：定义管理 + 执行 + 直接启动 + MCP。
 *
 * 工具类型：
 *   cmd      命令行：AI 可调用（run_tool），也可在工具箱里直接启动
 *   mcp      MCP Server：AI 可调用其 tools（run_tool），UI 可连接/查看/手动调用
 *   gui      图形界面：只在工具箱里直接启动，AI 不可调用
 *   website  网站：只在工具箱里打开，AI 不可调用
 *
 * 定义存 YAML：repo 的 tools/ 是只读示例，.runtime/tools/ 是用户自定义（同 id 覆盖）。
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { mcpResultText } from "./mcp.mjs";
import { RUNTIME, ROOT, projectWorkspaceDir } from "./config.mjs";

const REPO_TOOLS_DIR = join(ROOT, "tools");
const RUNTIME_TOOLS_DIR = join(RUNTIME, "tools");
const CATEGORIES_FILE = join(RUNTIME, "tool-categories.json");
const BASE_CATEGORIES = ["单点信息收集", "批量信息收集", "综合工具", "AI工具"];

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TYPES = new Set(["cmd", "gui", "website", "mcp"]);
const RUNNERS = new Set(["host", "docker"]);
const PARSERS = new Set(["text", "json"]);
const RISKS = new Set(["passive", "active", "intrusive"]);

const DEFAULT_CATEGORY = "综合工具";
const DEFAULT_TIMEOUT_SEC = 300;
const DEFAULT_MODEL_CHARS = 8000;
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

export class ToolRegistry {
	constructor({ store, broadcast, mcp }) {
		this.store = store;
		this.broadcast = broadcast;
		this.mcp = mcp;
		this.launches = new Map();
		this.launchSeq = 0;
		mkdirSync(RUNTIME_TOOLS_DIR, { recursive: true });
	}

	/* ------------------------------ 定义管理 ------------------------------ */

	loadAll() {
		const tools = new Map();
		for (const [dir, source] of [
			[REPO_TOOLS_DIR, "repo"],
			[RUNTIME_TOOLS_DIR, "runtime"],
		]) {
			if (!existsSync(dir)) continue;
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
				try {
					const def = validateTool(parseYaml(readFileSync(join(dir, file), "utf8")));
					def.source = source;
					def.file = file;
					tools.set(def.id, def);
				} catch (error) {
					const id = file.replace(/\.ya?ml$/, "");
					tools.set(id, {
						id,
						name: id,
						description: "工具定义无效",
						type: "cmd",
						category: DEFAULT_CATEGORY,
						source,
						error: String(error?.message ?? error),
					});
				}
			}
		}
		return [...tools.values()].sort((a, b) => a.id.localeCompare(b.id));
	}

	list() {
		return this.loadAll().map((tool) => sanitize(tool));
	}

	categories() {
		const counts = new Map();
		for (const tool of this.loadAll()) {
			const category = tool.category ?? DEFAULT_CATEGORY;
			counts.set(category, (counts.get(category) ?? 0) + 1);
		}
		const names = [...new Set([...BASE_CATEGORIES, ...this.readCustomCategories(), ...counts.keys()])];
		const custom = new Set(this.readCustomCategories());
		return names.map((name) => ({
			name,
			count: counts.get(name) ?? 0,
			builtin: BASE_CATEGORIES.includes(name),
			deletable: custom.has(name) && !BASE_CATEGORIES.includes(name) && (counts.get(name) ?? 0) === 0,
		}));
	}

	readCustomCategories() {
		try {
			const parsed = JSON.parse(readFileSync(CATEGORIES_FILE, "utf8"));
			return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
		} catch {
			return [];
		}
	}

	writeCustomCategories(list) {
		mkdirSync(RUNTIME, { recursive: true });
		writeFileSync(CATEGORIES_FILE, JSON.stringify([...new Set(list)], null, 2), "utf8");
	}

	addCategory(name) {
		const clean = String(name ?? "").trim();
		if (!clean) throw new Error("分类名不能为空");
		if (clean.length > 24) throw new Error("分类名最多 24 个字符");
		const custom = this.readCustomCategories();
		if (!custom.includes(clean) && !BASE_CATEGORIES.includes(clean)) custom.push(clean);
		this.writeCustomCategories(custom);
		return this.categories();
	}

	removeCategory(name) {
		const clean = String(name ?? "").trim();
		if (!clean) throw new Error("分类名不能为空");
		if (this.loadAll().some((tool) => (tool.category ?? DEFAULT_CATEGORY) === clean)) {
			throw new Error("该分类下还有工具，先把工具移到其他分类再删除");
		}
		if (BASE_CATEGORIES.includes(clean)) throw new Error("内置分类不能删除");
		this.writeCustomCategories(this.readCustomCategories().filter((item) => item !== clean));
		return this.categories();
	}

	get(id) {
		return this.loadAll().find((tool) => tool.id === id);
	}

	save(input) {
		const def = typeof input === "string" ? validateTool(parseYaml(input)) : validateTool(input);
		def.source = "runtime";
		mkdirSync(RUNTIME_TOOLS_DIR, { recursive: true });
		writeFileSync(join(RUNTIME_TOOLS_DIR, `${def.id}.yaml`), stringifyYaml(plain(def)), "utf8");
		return sanitize(this.get(def.id));
	}

	remove(id) {
		const file = join(RUNTIME_TOOLS_DIR, `${id}.yaml`);
		if (!existsSync(file)) return false;
		unlinkSync(file);
		if (this.mcp) this.mcp.close(id).catch(() => {});
		return true;
	}

	/** AI 可见的工具：仅命令行 + MCP。 */
	async listForAgent() {
		const defs = this.loadAll().filter((tool) => !tool.error);
		const out = [];
		for (const tool of defs) {
			if (tool.type === "cmd") {
				out.push({
					id: tool.id,
					name: tool.name,
					type: "cmd",
					category: tool.category,
					description: tool.description,
					risk: tool.risk,
					params: (tool.params ?? []).map(publicParam),
				});
			}
		}
		for (const tool of defs) {
			if (tool.type !== "mcp") continue;
			const listed = await this.mcp.listTools(tool);
			if (!listed.ok) {
				out.push({
					id: `mcp:${tool.id}`,
					name: `${tool.name}（MCP，连接失败）`,
					type: "mcp",
					category: tool.category,
					description: `MCP Server ${tool.id} 当前不可用：${listed.error}`,
					params: [],
				});
				continue;
			}
			for (const item of listed.tools) {
				out.push({
					id: `mcp:${tool.id}/${item.name}`,
					name: `${tool.name} · ${item.name}`,
					type: "mcp",
					category: tool.category,
					description: item.description,
					params: schemaToParams(item.inputSchema),
				});
			}
		}
		return out;
	}

	/* ------------------------------ 执行（AI 路径） ------------------------------ */

	async run({ toolId, projectId, agentId, args = {} }) {
		if (toolId.startsWith("mcp:")) {
			return this.runMcp({ toolId, projectId, agentId, args });
		}
		const tool = this.get(toolId);
		if (!tool) throw new Error(`工具不存在: ${toolId}`);
		if (tool.error) throw new Error(`工具定义无效: ${tool.error}`);
		if (tool.type !== "cmd") throw new Error(`${tool.type} 类型工具不供 AI 执行（可在工具箱里直接启动）`);

		const values = resolveArgs(tool, args);
		const workspace = projectWorkspaceDir(projectId || "tool-test");
		const argv = buildArgv(tool, values, workspace);

		let program;
		let commandArgs;
		if (tool.runner === "docker") {
			if (!tool.image) throw new Error("docker runner 必须配置 image");
			program = "docker";
			commandArgs = ["run", "--rm", "-v", `${workspace}:/work`, "-w", "/work", tool.image, ...argv];
		} else {
			program = argv[0];
			commandArgs = argv.slice(1);
		}

		const timeoutMs = (args.timeoutSec ?? tool.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
		const maxBytes = tool.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
		const started = Date.now();
		const result = await execCaptured(program, commandArgs, {
			cwd: tool.workdir || workspace,
			timeoutMs,
			maxBytes,
		});

		const artifact = this.writeArtifact({
			projectId: projectId || "tool-test",
			agentId,
			tool,
			values,
			argv,
			result,
		});

		const modelChars = tool.modelOutputChars ?? DEFAULT_MODEL_CHARS;
		let text = result.stdout;
		if (result.stderr) text += `\n[stderr]\n${result.stderr}`;
		let structured;
		if (tool.parser === "json" && result.stdout.trim()) {
			try {
				const parsed = JSON.parse(result.stdout);
				if (JSON.stringify(parsed).length <= modelChars * 2) structured = parsed;
			} catch {
				structured = undefined;
			}
		}
		const truncated = text.length > modelChars;
		const shown = truncated ? headTail(text, modelChars) : text;
		const bytes = result.bytes;
		const note = truncated
			? `\n\n[输出已截断：完整 ${bytes} bytes，只显示前 ${modelChars} 字符。完整内容可用 read_artifact("${artifact.id}") 读取]`
			: "";

		return {
			toolId: tool.id,
			type: "cmd",
			artifactId: artifact.id,
			exitCode: result.exitCode,
			timedOut: result.timedOut,
			durationMs: Date.now() - started,
			bytes,
			truncated,
			text: `exit=${result.exitCode}${result.timedOut ? " (timeout)" : ""} · ${bytes} bytes · artifact=${artifact.id}\n${shown}${note}`,
			structured,
		};
	}

	async runMcp({ toolId, projectId, agentId, args }) {
		const match = /^mcp:([^/]+)\/(.+)$/.exec(toolId);
		if (!match) throw new Error(`MCP 工具 id 格式应为 mcp:<server>/<tool>，收到 ${toolId}`);
		const [, serverId, toolName] = match;
		const server = this.get(serverId);
		if (!server || server.type !== "mcp") throw new Error(`MCP Server 不存在: ${serverId}`);
		const started = Date.now();
		const result = await this.mcp.callTool(server, toolName, args);
		const text = mcpResultText(result);
		const modelChars = server.modelOutputChars ?? DEFAULT_MODEL_CHARS;
		const truncated = text.length > modelChars;
		const artifact = this.saveArtifact({
			projectId: projectId || "tool-test",
			agentId,
			kind: "mcp-result",
			title: `${server.name} · ${toolName}`,
			text,
			meta: { toolId: server.id, mcpTool: toolName, args, isError: Boolean(result?.isError) },
		});
		return {
			toolId,
			type: "mcp",
			artifactId: artifact.id,
			exitCode: result?.isError ? 1 : 0,
			timedOut: false,
			durationMs: Date.now() - started,
			bytes: Buffer.byteLength(text, "utf8"),
			truncated,
			text: `mcp=${serverId}/${toolName} · isError=${Boolean(result?.isError)} · ${Buffer.byteLength(text, "utf8")} bytes · artifact=${artifact.id}\n${
				truncated ? headTail(text, modelChars) : text
			}`,
		};
	}

	/* ------------------------------ 直接启动（UI 路径） ------------------------------ */

	async launch({ toolId, args = {} }) {
		const tool = this.get(toolId);
		if (!tool) throw new Error(`工具不存在: ${toolId}`);
		if (tool.error) throw new Error(`工具定义无效: ${tool.error}`);

		if (tool.type === "mcp") {
			const listed = await this.mcp.listTools(tool);
			return { kind: "mcp", toolId, ...listed };
		}

		if (tool.type === "website") {
			const values = resolveArgs(tool, args);
			const url = substitute(tool.url, values);
			if (!/^https?:\/\//i.test(url)) throw new Error(`网站 URL 必须是 http(s): ${url}`);
			if (dryLaunch()) return { kind: "website", url, action: "open", dryRun: true };
			openUrl(url);
			return { kind: "website", url, action: "open" };
		}

		if (tool.type === "gui") {
			const values = resolveArgs(tool, args);
			const argv = buildArgv(tool, values, tool.workdir || process.cwd());
			if (dryLaunch()) return { kind: "gui", argv, dryRun: true };
			const child = spawn(argv[0], argv.slice(1), {
				cwd: tool.workdir || undefined,
				detached: true,
				stdio: "ignore",
				windowsHide: false,
			});
			child.unref();
			return { kind: "gui", pid: child.pid, argv };
		}

		// cmd：后台跑，输出落 artifact，UI 轮询 run 状态
		const runId = `run-${++this.launchSeq}`;
		const run = {
			id: runId,
			toolId,
			status: "running",
			startedAt: Date.now(),
			endedAt: null,
			artifactId: null,
			exitCode: null,
			error: null,
			text: null,
		};
		this.launches.set(runId, run);
		this.run({ toolId, projectId: "toolbox", agentId: "ui-launch", args })
			.then((result) => {
				Object.assign(run, {
					status: "done",
					endedAt: Date.now(),
					artifactId: result.artifactId,
					exitCode: result.exitCode,
					text: result.text.slice(0, 4000),
				});
			})
			.catch((error) => {
				Object.assign(run, {
					status: "failed",
					endedAt: Date.now(),
					error: String(error?.message ?? error),
				});
			});
		// 只保留最近 50 条
		if (this.launches.size > 50) {
			const oldest = [...this.launches.keys()].slice(0, this.launches.size - 50);
			for (const id of oldest) this.launches.delete(id);
		}
		return { kind: "cmd", run };
	}

	getLaunch(runId) {
		return this.launches.get(runId);
	}

	/* ------------------------------ artifact ------------------------------ */

	saveArtifact({ projectId, agentId, kind, title, text, meta = {} }) {
		const dir = join(RUNTIME, "projects", projectId, "artifacts");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}.log`);
		writeFileSync(path, text, "utf8");
		const artifact = this.store.addArtifact({
			projectId,
			agentId,
			kind,
			title,
			path,
			bytes: Buffer.byteLength(text, "utf8"),
			sha256: createHash("sha256").update(text).digest("hex"),
			meta,
		});
		if (this.broadcast) {
			this.broadcast({ projectId, agentId, type: "artifact.created", payload: { artifact } });
		}
		return artifact;
	}

	writeArtifact({ projectId, agentId, tool, values, argv, result }) {
		const header = [
			`# tool=${tool.id} type=${tool.type} runner=${tool.runner}`,
			`# argv=${JSON.stringify(argv)}`,
			`# args=${JSON.stringify(values)}`,
			`# exit=${result.exitCode} timeout=${result.timedOut} duration=${result.durationMs}ms bytes=${result.bytes}`,
			"",
		].join("\n");
		return this.saveArtifact({
			projectId,
			agentId,
			kind: "tool-output",
			title: `${tool.id} 输出`,
			text: `${header}${result.full}`,
			meta: {
				toolId: tool.id,
				runner: tool.runner,
				argv,
				args: values,
				exitCode: result.exitCode,
				timedOut: result.timedOut,
				bytes: result.bytes,
			},
		});
	}

	readArtifact(id, { offset = 0, limit = 20000 } = {}) {
		const artifact = this.store.getArtifact(id);
		if (!artifact) throw new Error(`artifact 不存在: ${id}`);
		if (!existsSync(artifact.path)) throw new Error(`artifact 文件丢失: ${artifact.path}`);
		const buffer = readFileSync(artifact.path);
		const start = Math.max(0, Math.min(offset, buffer.length));
		const end = Math.min(buffer.length, start + Math.max(1, limit));
		return {
			id,
			text: buffer.subarray(start, end).toString("utf8"),
			totalBytes: buffer.length,
			offset: start,
			limit: end - start,
			hasMore: end < buffer.length,
		};
	}
}

/* ------------------------------ 执行器 ------------------------------ */

function execCaptured(program, args, { cwd, timeoutMs, maxBytes }) {
	return new Promise((resolvePromise, rejectPromise) => {
		let child;
		try {
			child = spawn(program, args, {
				cwd,
				shell: false,
				windowsHide: true,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			rejectPromise(new Error(`无法启动进程 ${program}: ${String(error?.message ?? error)}`));
			return;
		}

		const stdout = [];
		const stderr = [];
		let bytes = 0;
		let timedOut = false;
		let settled = false;

		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child);
		}, timeoutMs);

		const collect = (chunks, chunk) => {
			if (bytes >= maxBytes) return;
			const remaining = maxBytes - bytes;
			const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
			bytes += slice.length;
			chunks.push(slice);
		};

		child.stdout.on("data", (chunk) => collect(stdout, chunk));
		child.stderr.on("data", (chunk) => collect(stderr, chunk));

		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rejectPromise(new Error(`进程执行失败 ${program}: ${String(error?.message ?? error)}`));
		});

		child.on("close", (exitCode) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const out = Buffer.concat(stdout);
			const err = Buffer.concat(stderr);
			resolvePromise({
				exitCode: timedOut ? -1 : exitCode ?? -1,
				timedOut,
				stdout: out.toString("utf8"),
				stderr: err.toString("utf8"),
				full: Buffer.concat([out, err]).toString("utf8"),
				bytes,
				durationMs: 0,
			});
		});
	});
}

function killTree(child) {
	if (!child || child.killed) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

function dryLaunch() {
	return process.env.PENTEST_DRY_LAUNCH === "1";
}

function openUrl(url) {
	if (process.platform === "win32") {
		spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
	} else if (process.platform === "darwin") {
		spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
	} else {
		spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
	}
}

function headTail(text, modelChars) {
	const headLen = Math.floor(modelChars * 0.7);
	const tailLen = modelChars - headLen;
	return `${text.slice(0, headLen)}\n…[中间省略 ${text.length - modelChars} 字符]…\n${text.slice(-tailLen)}`;
}

/* ------------------------------ 校验/参数 ------------------------------ */

function validateTool(input) {
	if (!input || typeof input !== "object") throw new Error("工具定义必须是对象");
	const tool = plain(input);
	if (!tool.id) throw new Error("缺少 id");
	if (!ID_PATTERN.test(tool.id)) throw new Error("id 只能是小写字母/数字/连字符");

	tool.type = tool.type ?? inferType(tool);
	if (!TYPES.has(tool.type)) throw new Error(`type 必须是 cmd / gui / website / mcp`);
	tool.name = tool.name ?? tool.id;
	tool.category = tool.category ?? DEFAULT_CATEGORY;
	tool.description = tool.description ?? "";
	tool.icon = tool.icon ?? "";
	tool.version = tool.version ?? "";
	tool.runtime = tool.runtime ?? "";
	tool.homepage = tool.homepage ?? "";
	tool.workdir = tool.workdir ?? "";
	tool.risk = tool.risk ?? "passive";
	if (!RISKS.has(tool.risk)) throw new Error(`risk 必须是 passive/active/intrusive`);
	tool.parser = tool.parser ?? "text";
	if (!PARSERS.has(tool.parser)) throw new Error(`parser 必须是 text 或 json`);
	tool.params = Array.isArray(tool.params) ? tool.params : [];
	for (const param of tool.params) {
		if (!param?.name) throw new Error("params 每项必须有 name");
		if (!["string", "number", "boolean", "enum"].includes(param.type ?? "string")) {
			throw new Error(`参数 ${param.name} 的类型不支持`);
		}
	}
	tool.timeoutSec = Number(tool.timeoutSec ?? DEFAULT_TIMEOUT_SEC);
	tool.modelOutputChars = Number(tool.modelOutputChars ?? DEFAULT_MODEL_CHARS);
	tool.maxOutputBytes = Number(tool.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);

	if (tool.type === "website") {
		if (!tool.url) throw new Error("网站工具必须配置 url");
	} else if (tool.type === "mcp") {
		const cfg = tool.mcp ?? {};
		if (!["stdio", "http", "sse"].includes(cfg.transport)) {
			throw new Error("MCP 需要配置 mcp.transport = stdio / http / sse");
		}
		if (cfg.transport === "stdio" && !cfg.command) throw new Error("MCP stdio 需要 mcp.command");
		if (cfg.transport !== "stdio" && !cfg.url) throw new Error("MCP http/sse 需要 mcp.url");
		tool.mcp = {
			transport: cfg.transport,
			command: cfg.command ?? "",
			args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
			cwd: cfg.cwd ?? "",
			env: cfg.env && typeof cfg.env === "object" ? cfg.env : {},
			url: cfg.url ?? "",
			headers: cfg.headers && typeof cfg.headers === "object" ? cfg.headers : {},
		};
	} else {
		tool.runner = tool.runner ?? "host";
		if (!RUNNERS.has(tool.runner)) throw new Error(`runner 必须是 host 或 docker`);
		const argv = tool.argv ?? (tool.executable ? [tool.executable, ...(tool.args ?? [])] : []);
		if (!Array.isArray(argv) || argv.length === 0) throw new Error("cmd/gui 工具需要 executable+args 或 argv");
		if (argv.some((token) => typeof token !== "string")) throw new Error("argv 每一项都必须是字符串");
		tool.argv = argv;
		if (tool.runner === "docker" && !tool.image) throw new Error("runner: docker 时必须配置 image");
	}
	return tool;
}

function inferType(tool) {
	if (tool.mcp) return "mcp";
	if (tool.url && !tool.argv) return "website";
	if (tool.gui === true || tool.type === "gui") return "gui";
	return "cmd";
}

function publicParam(param) {
	return {
		name: param.name,
		type: param.type,
		required: Boolean(param.required),
		default: param.default,
		description: param.description,
	};
}

function schemaToParams(schema) {
	const props = schema?.properties ?? {};
	const required = new Set(schema?.required ?? []);
	return Object.entries(props).map(([name, value]) => ({
		name,
		type: value?.type ?? "string",
		required: required.has(name),
		description: value?.description ?? "",
	}));
}

function buildArgv(tool, values, workspace) {
	return (tool.argv ?? []).map((token) => substitute(token, values, workspace));
}

function substitute(template, values, workspace) {
	return String(template).replace(/\{(\w+)\}/g, (match, key) => {
		const value = values[key];
		if (value === undefined) return key === "workspace" && workspace ? workspace : match;
		return String(value);
	});
}

function resolveArgs(tool, args) {
	const values = {};
	for (const param of tool.params ?? []) {
		let value = args[param.name];
		if (value === undefined) value = param.default;
		if (value === undefined) {
			if (param.required) throw new Error(`缺少必填参数: ${param.name}`);
			continue;
		}
		if (param.type === "number") {
			const number = Number(value);
			if (!Number.isFinite(number)) throw new Error(`参数 ${param.name} 必须是数字`);
			values[param.name] = number;
		} else if (param.type === "boolean") {
			values[param.name] = value === true || value === "true";
		} else if (param.type === "enum") {
			if (!param.values?.includes(String(value))) {
				throw new Error(`参数 ${param.name} 必须是 ${param.values?.join(" / ")}`);
			}
			values[param.name] = String(value);
		} else {
			values[param.name] = String(value);
		}
	}
	return values;
}

function sanitize(tool) {
	return {
		id: tool.id,
		name: tool.name,
		type: tool.type,
		category: tool.category,
		description: tool.description,
		icon: tool.icon,
		version: tool.version,
		runtime: tool.runtime,
		homepage: tool.homepage,
		workdir: tool.workdir,
		source: tool.source,
		risk: tool.risk,
		runner: tool.runner,
		image: tool.image,
		executable: tool.executable,
		args: tool.args,
		argv: tool.argv,
		url: tool.url,
		mcp: tool.mcp,
		params: tool.params,
		timeoutSec: tool.timeoutSec,
		modelOutputChars: tool.modelOutputChars,
		parser: tool.parser,
		aiUsable: tool.type === "cmd" || tool.type === "mcp",
		error: tool.error,
	};
}

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}
