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
export const RUNTIME = join(ROOT, ".runtime");
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
