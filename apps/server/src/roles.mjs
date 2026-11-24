/**
 * M6：角色配置
 *
 * - 默认角色与工具白名单在 DEFAULT_ROLES
 * - 覆盖项持久化在 .runtime/roles.json（模型档位 / 工具白名单 / 技能白名单 / 预算）
 * - supervisor spawn 时读取并应用到 pi 命令行与预算检查
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME } from "./config.mjs";
import { listSkills, resolveSkillPaths } from "./skills.mjs";

const ROLES_FILE = join(RUNTIME, "roles.json");

export const DEFAULT_ROLES = {
	commander: {
		label: "指挥官",
		objective: "负责项目的渗透测试调度与结论汇总（不直接接触目标）",
		tools: ["dispatch_agent", "fact_write", "fact_query", "finding_query", "coverage_query", "get_brief"],
		skills: [],
	},
	recon: {
		label: "侦察员",
		objective: "对目标做信息收集，把可复用的发现写入事实库",
		tools: [
			"powershell",
			"run_tool",
			"list_tools",
			"read_artifact",
			"http_send",
			"finding_submit",
			"finding_query",
			"coverage_update",
			"coverage_query",
			"fact_write",
			"fact_query",
			"get_brief",
		],
		skills: ["recon", "evidence"],
	},
	jwt: {
		label: "JWT 专家",
		objective: "对目标做 JWT 专项测试，验证 alg=none / 弱密钥 / claim 篡改",
		tools: [
			"powershell",
			"run_tool",
			"list_tools",
			"read_artifact",
			"http_send",
			"finding_submit",
			"finding_query",
			"coverage_update",
			"coverage_query",
			"fact_write",
			"fact_query",
			"get_brief",
		],
		skills: ["jwt", "evidence"],
	},
	verifier: {
		label: "独立验证者",
		objective: "独立重放其他 agent 提交的 finding PoC，用新证据验证漏洞是否真实",
		tools: [
			"http_send",
			"read_artifact",
			"list_tools",
			"run_tool",
			"finding_query",
			"finding_verify",
			"fact_write",
			"fact_query",
			"get_brief",
		],
		skills: ["evidence"],
	},
};

export const KNOWN_TOOLS = [
	"dispatch_agent",
	"fact_write",
	"fact_query",
	"get_brief",
	"run_tool",
	"list_tools",
	"read_artifact",
	"http_send",
	"finding_submit",
	"finding_query",
	"finding_verify",
	"coverage_update",
	"coverage_query",
	"powershell",
	"bash",
	"read",
	"write",
	"edit",
	"grep",
	"find",
	"glob",
	"ls",
];

const ALLOWED_MODELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function readOverrideFile() {
	if (!existsSync(ROLES_FILE)) return {};
	try {
		return JSON.parse(readFileSync(ROLES_FILE, "utf8")) ?? {};
	} catch {
		return {};
	}
}

function writeOverrideFile(data) {
	mkdirSync(RUNTIME, { recursive: true });
	writeFileSync(ROLES_FILE, JSON.stringify(data, null, 2), "utf8");
}

/** 默认 + 覆盖 + 校验后的最终配置 */
export function getRoleConfig(role) {
	const defaults = DEFAULT_ROLES[role];
	if (!defaults) throw new Error(`未知角色: ${role}`);
	const override = readOverrideFile().roles?.[role] ?? {};
	const model =
		override.model && override.model.provider && override.model.model
			? { provider: String(override.model.provider), model: String(override.model.model) }
			: null;
	return {
		role,
		label: defaults.label,
		objective: defaults.objective,
		tools: Array.isArray(override.tools) && override.tools.length ? override.tools : defaults.tools,
		skills: Array.isArray(override.skills) ? override.skills : defaults.skills,
		model,
		thinking: ALLOWED_MODELS.includes(override.thinking) ? override.thinking : null,
		maxTurns: Number.isFinite(override.maxTurns) && override.maxTurns > 0 ? override.maxTurns : null,
		maxTokens: Number.isFinite(override.maxTokens) && override.maxTokens > 0 ? override.maxTokens : null,
		overridden: Boolean(Object.keys(override).length),
	};
}

export function listRoles() {
	const skills = listSkills();
	return Object.keys(DEFAULT_ROLES).map((role) => {
		const config = getRoleConfig(role);
		return {
			...config,
			availableTools: [...new Set([...KNOWN_TOOLS, ...DEFAULT_ROLES[role].tools, ...config.tools])],
			availableSkills: skills.map((skill) => ({
				id: skill.id,
				name: skill.name,
				description: skill.description,
				source: skill.source,
			})),
		};
	});
}

function validatePatch(patch) {
	const clean = {};
	if (patch.tools !== undefined) {
		if (!Array.isArray(patch.tools) || patch.tools.some((item) => typeof item !== "string" || !item.trim())) {
			throw new Error("tools 必须是非空字符串数组");
		}
		clean.tools = [...new Set(patch.tools.map((item) => item.trim()))];
		if (clean.tools.length === 0) throw new Error("tools 不能为空（至少保留一个工具）");
	}
	if (patch.skills !== undefined) {
		if (!Array.isArray(patch.skills) || patch.skills.some((item) => typeof item !== "string")) {
			throw new Error("skills 必须是字符串数组");
		}
		const known = new Set(listSkills().map((skill) => skill.id));
		const unknown = patch.skills.filter((item) => !known.has(item));
		if (unknown.length) throw new Error(`未知技能: ${unknown.join(", ")}`);
		clean.skills = [...new Set(patch.skills)];
	}
	if (patch.model !== undefined) {
		if (patch.model === null) clean.model = null;
		else {
			if (!patch.model?.provider || !patch.model?.model) throw new Error("model 需要 provider 和 model，或设为 null");
			clean.model = { provider: String(patch.model.provider), model: String(patch.model.model) };
		}
	}
	if (patch.thinking !== undefined) {
		if (patch.thinking !== null && !ALLOWED_MODELS.includes(patch.thinking)) {
			throw new Error(`thinking 必须是 ${ALLOWED_MODELS.join(" / ")} 或 null`);
		}
		clean.thinking = patch.thinking;
	}
	for (const key of ["maxTurns", "maxTokens"]) {
		if (patch[key] !== undefined) {
			if (patch[key] === null) clean[key] = null;
			else if (!Number.isFinite(patch[key]) || patch[key] <= 0) throw new Error(`${key} 必须是正数或 null`);
			else clean[key] = Math.floor(patch[key]);
		}
	}
	return clean;
}

export function saveRole(role, patch) {
	if (!DEFAULT_ROLES[role]) throw new Error(`未知角色: ${role}`);
	const data = readOverrideFile();
	data.roles = data.roles ?? {};
	data.roles[role] = { ...(data.roles[role] ?? {}), ...validatePatch(patch) };
	writeOverrideFile(data);
	return getRoleConfig(role);
}

export function resetRole(role) {
	if (!DEFAULT_ROLES[role]) throw new Error(`未知角色: ${role}`);
	const data = readOverrideFile();
	if (data.roles?.[role]) {
		delete data.roles[role];
		writeOverrideFile(data);
	}
	return getRoleConfig(role);
}

/** supervisor 用：解析角色技能目录 */
export function roleSkillPaths(role) {
	return resolveSkillPaths(getRoleConfig(role).skills);
}
