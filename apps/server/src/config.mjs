/**
 * 运行时路径与模型配置。
 *
 * 所有可变数据都在 .runtime/ 下，不动用户全局的 ~/.pi/agent：
 *   .runtime/agent-dir/models.json   pi 的 provider 配置（由本文件生成）
 *   .runtime/config.json             平台自己的模型选择 / provider 配置
 *   .runtime/secrets.json            API key（不出现在 models.json 里）
 *   .runtime/pi-pentest.db           领域库
 *   .runtime/projects/<id>/sessions/ 每个项目的 pi 会话
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "../../..");
/** 可用 PENTEST_RUNTIME_DIR 指向隔离目录（验收脚本/多实例测试用）。 */
export const RUNTIME = process.env.PENTEST_RUNTIME_DIR
	? resolve(process.env.PENTEST_RUNTIME_DIR)
	: join(ROOT, ".runtime");
export const AGENT_DIR = join(RUNTIME, "agent-dir");
export const SESSIONS_ROOT = join(RUNTIME, "projects");
export const DB_PATH = join(RUNTIME, "pi-pentest.db");
export const KIT_LOG = join(RUNTIME, "kit.log");
export const CONFIG_PATH = join(RUNTIME, "config.json");
export const SECRETS_PATH = join(RUNTIME, "secrets.json");
export const MODELS_PATH = join(AGENT_DIR, "models.json");
export const ROLES_DIR = join(ROOT, "roles");
export const PI_KIT_ENTRY = join(ROOT, "packages", "pi-kit", "src", "index.ts");
export const WEB_DIST = join(ROOT, "apps", "web", "dist");

export const SERVER_PORT = Number(process.env.PORT ?? 8787);
export const SERVER_HOST = "127.0.0.1";

export function ensureRuntimeDirs() {
	for (const dir of [RUNTIME, AGENT_DIR, SESSIONS_ROOT]) mkdirSync(dir, { recursive: true });
}

export function projectSessionDir(projectId) {
	const dir = join(SESSIONS_ROOT, projectId, "sessions");
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** agent 的工作目录：工具产物放这里，不和会话 JSONL 混在一起。 */
export function projectWorkspaceDir(projectId) {
	const dir = join(SESSIONS_ROOT, projectId, "workspace");
	mkdirSync(dir, { recursive: true });
	return dir;
}

/* ------------------------------- 运行时参数 ------------------------------- */

const positiveNumber = (value, fallback) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const LIMITS = {
	/** 全局同时运行的 agent 上限（排队，不丢弃）。 */
	maxConcurrentAgents: Math.floor(positiveNumber(process.env.PENTEST_MAX_CONCURRENCY, 4)),
	/** 单个 agent 墙钟上限，到点中止并标记失败。 */
	agentTimeoutMs: positiveNumber(process.env.PENTEST_AGENT_TIMEOUT_MS, 20 * 60 * 1000),
	/** 多久没有收到任何 pi 事件就判定卡死。 */
	heartbeatMs: positiveNumber(process.env.PENTEST_HEARTBEAT_MS, 5 * 60 * 1000),
	/** 父 agent 空闲时，合并通知的防抖窗口。 */
	wakeDebounceMs: positiveNumber(process.env.PENTEST_WAKE_DEBOUNCE_MS, 1500),
	/** 父 agent 忙碌时，通知最多等待多久（到点用 follow_up 硬塞）。 */
	wakeMaxWaitMs: positiveNumber(process.env.PENTEST_WAKE_MAX_WAIT_MS, 60 * 1000),
	/** 单个项目最多派发多少个子 agent（防止真实模型无限扩展测试面）。 */
	maxChildrenPerProject: Math.floor(positiveNumber(process.env.PENTEST_MAX_CHILDREN, 8)),
	/** 每个 agent 的轮次预算（assistant 消息数）。 */
	maxTurns: Math.floor(positiveNumber(process.env.PENTEST_MAX_TURNS, 40)),
	/** 每个 agent 的 token 预算（累计 input+output，usage 缺失时用上下文 token 兜底）。 */
	maxTokens: Math.floor(positiveNumber(process.env.PENTEST_MAX_TOKENS, 400_000)),
	/** 预算软提醒阈值：到 80% 时提示 agent 收尾。 */
	budgetSoftRatio: 0.8,
	/** 单项目同时运行的 agent 上限（M7 多项目配额）。 */
	maxConcurrentPerProject: Math.floor(positiveNumber(process.env.PENTEST_MAX_CONCURRENCY_PER_PROJECT, 2)),
	/** 工具审批等待上限，超时按 fail-closed 拒绝（M7）。 */
	approvalTimeoutMs: positiveNumber(process.env.PENTEST_APPROVAL_TIMEOUT_MS, 120 * 1000),
	/** off=全放行；risk=shell / 高风险工具需审批；all=所有工具都审批（默认 off，需显式开启）。 */
	approvalMode: process.env.PENTEST_APPROVAL_MODE ?? "off",
	/** 项目 token 预警阈值（0=关闭）。 */
	projectTokenLimit: Math.floor(positiveNumber(process.env.PENTEST_PROJECT_TOKEN_LIMIT, 0)) || 0,
	/** 项目成本预警阈值（0=关闭）。 */
	projectCostLimit: positiveNumber(process.env.PENTEST_PROJECT_COST_LIMIT, 0) || 0,
};

/* ---------------------------------- 配置 ---------------------------------- */

const DEFAULT_CONFIG = {
	active: null,
	providers: {},
};

export function readConfig() {
	if (!existsSync(CONFIG_PATH)) {
		writeConfig(DEFAULT_CONFIG);
		return structuredClone(DEFAULT_CONFIG);
	}
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		return { ...structuredClone(DEFAULT_CONFIG), ...parsed };
	} catch {
		return structuredClone(DEFAULT_CONFIG);
	}
}

export function writeConfig(config) {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	writeModelsJson(config);
	return config;
}

function readSecrets() {
	if (!existsSync(SECRETS_PATH)) return {};
	try {
		return JSON.parse(readFileSync(SECRETS_PATH, "utf8"));
	} catch {
		return {};
	}
}

function writeSecrets(secrets) {
	mkdirSync(dirname(SECRETS_PATH), { recursive: true });
	writeFileSync(SECRETS_PATH, `${JSON.stringify(secrets, null, 2)}\n`, "utf8");
}

export function saveCustomProvider({ baseUrl, api, apiKey, modelId, name }) {
	if (!baseUrl || !modelId) throw new Error("baseUrl 与模型 ID 必填");
	const config = readConfig();
	const secrets = readSecrets();
	secrets.custom = apiKey ?? secrets.custom ?? "";
	writeSecrets(secrets);

	config.providers.custom = {
		id: "custom",
		name: name || "自定义模型",
		api: api || "openai-completions",
		baseUrl,
		models: [{ id: modelId, name: modelId }],
	};
	config.active = { provider: "custom", model: modelId };
	writeConfig(config);
	return publicConfig(config);
}

export function setActiveModel(providerId, modelId) {
	const config = readConfig();
	if (!config.providers[providerId]) throw new Error(`未知 provider: ${providerId}`);
	const provider = config.providers[providerId];
	if (!provider.models?.some((model) => model.id === modelId)) {
		throw new Error(`provider ${providerId} 下没有模型 ${modelId}`);
	}
	config.active = { provider: providerId, model: modelId };
	writeConfig(config);
	return publicConfig(config);
}

export function publicConfig(config = readConfig()) {
	const secrets = readSecrets();
	const custom = config.providers.custom;
	const configured = Boolean(
		config.active?.provider &&
			config.active?.model &&
			config.providers[config.active.provider]?.models?.some((model) => model.id === config.active.model),
	);
	return {
		active: config.active ?? null,
		configured,
		custom: custom
			? {
					name: custom.name,
					baseUrl: custom.baseUrl,
					api: custom.api,
					modelId: custom.models?.[0]?.id ?? "",
					hasKey: Boolean(secrets.custom),
				}
			: null,
		providers: Object.values(config.providers).map((provider) => ({
			id: provider.id,
			name: provider.name,
			api: provider.api,
			baseUrl: provider.baseUrl,
			models: provider.models ?? [],
			hasKey: Boolean(secrets[provider.id]),
		})),
	};
}

/** 生成 pi 的 models.json。API key 通过 $PENTEST_LLM_KEY 环境变量注入，不落盘。 */
export function writeModelsJson(config = readConfig()) {
	const providers = {};
	for (const provider of Object.values(config.providers)) {
		if (!provider.baseUrl || !provider.models?.length) continue;
		providers[provider.id] = {
			name: provider.name,
			baseUrl: provider.baseUrl,
			api: provider.api || "openai-completions",
			apiKey: "$PENTEST_LLM_KEY",
			models: provider.models.map((model) => ({
				id: model.id,
				name: model.name ?? model.id,
				contextWindow: 128000,
				maxTokens: 8192,
			})),
		};
	}
	mkdirSync(AGENT_DIR, { recursive: true });
	writeFileSync(MODELS_PATH, `${JSON.stringify({ providers }, null, 2)}\n`, "utf8");
}

/** 返回 { provider, model }；未配置模型时返回 null。 */
export function activeModelEnv() {
	const config = readConfig();
	if (!config.active?.provider || !config.active?.model) return null;
	if (!config.providers[config.active.provider]) return null;
	return { provider: config.active.provider, model: config.active.model };
}

export function llmApiKeyEnv() {
	const secrets = readSecrets();
	return secrets.custom || "";
}

export function resolvePiCliPath() {
	const explicit = process.env.PI_CLI_PATH;
	if (explicit && existsSync(explicit)) return explicit;
	const installRoot = process.env.PI_MANAGED_INSTALL_ROOT ?? join(homedir(), ".pi", "agent", "install");
	const versionFile = join(installRoot, "current-version");
	if (existsSync(versionFile)) {
		const version = readFileSync(versionFile, "utf8").trim();
		const pkgDir = join(installRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
		const pkgJsonPath = join(pkgDir, "package.json");
		if (existsSync(pkgJsonPath)) {
			const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
			const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
			const cli = join(pkgDir, bin);
			if (existsSync(cli)) return cli;
		}
	}
	throw new Error("找不到 pi CLI，请先安装 pi 或设置 PI_CLI_PATH");
}
