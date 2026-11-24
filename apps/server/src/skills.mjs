/**
 * M6：Skills 管理
 *
 * - 仓库 skills/ 下是只读示例；.runtime/skills/ 是 UI 创建的可写技能
 * - 每个技能是含 SKILL.md（YAML frontmatter: name/description）的目录
 * - 按角色白名单注入：spawn 时 --no-skills + 显式 --skill <dir>
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { RUNTIME, ROOT } from "./config.mjs";

const REPO_SKILLS_DIR = join(ROOT, "skills");
const RUNTIME_SKILLS_DIR = join(RUNTIME, "skills");
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function ensureSkillDirs() {
	mkdirSync(RUNTIME_SKILLS_DIR, { recursive: true });
}

function parseSkillFile(dir, filePath) {
	const raw = readFileSync(filePath, "utf8");
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
	let frontmatter = {};
	let body = raw;
	if (match) {
		try {
			frontmatter = parseYaml(match[1]) ?? {};
		} catch {
			frontmatter = {};
		}
		body = raw.slice(match[0].length);
	}
	return {
		name: String(frontmatter.name ?? dir),
		description: String(frontmatter.description ?? ""),
		body,
		raw,
	};
}

export function listSkills() {
	ensureSkillDirs();
	const skills = [];
	for (const [root, source] of [
		[REPO_SKILLS_DIR, "repo"],
		[RUNTIME_SKILLS_DIR, "runtime"],
	]) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const filePath = join(root, entry.name, "SKILL.md");
			if (!existsSync(filePath)) continue;
			try {
				const parsed = parseSkillFile(entry.name, filePath);
				skills.push({
					id: entry.name,
					name: parsed.name,
					description: parsed.description,
					source,
					path: join(root, entry.name),
					bytes: readFileSync(filePath).length,
				});
			} catch (error) {
				skills.push({
					id: entry.name,
					name: entry.name,
					description: "",
					source,
					path: join(root, entry.name),
					error: String(error?.message ?? error),
				});
			}
		}
	}
	return skills.sort((a, b) => a.id.localeCompare(b.id));
}

export function findSkill(id) {
	if (!id || !NAME_PATTERN.test(id)) return undefined;
	for (const [root, source, writable] of [
		[RUNTIME_SKILLS_DIR, "runtime", true],
		[REPO_SKILLS_DIR, "repo", false],
	]) {
		const dir = join(root, id);
		const filePath = join(dir, "SKILL.md");
		if (!existsSync(filePath)) continue;
		const parsed = parseSkillFile(id, filePath);
		return {
			id,
			name: parsed.name,
			description: parsed.description,
			source,
			writable,
			path: dir,
			content: parsed.raw,
		};
	}
	return undefined;
}

/** 校验 SKILL.md 内容（frontmatter 有 name/description，name 合法） */
export function validateSkillContent(id, content) {
	if (!NAME_PATTERN.test(id)) throw new Error("技能 id 只能是小写字母/数字/连字符");
	const text = String(content ?? "");
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!match) throw new Error("SKILL.md 必须以 YAML frontmatter 开头（--- name / description ---）");
	let frontmatter;
	try {
		frontmatter = parseYaml(match[1]) ?? {};
	} catch (error) {
		throw new Error(`frontmatter YAML 解析失败: ${String(error?.message ?? error)}`);
	}
	if (!frontmatter.name) throw new Error("frontmatter 缺少 name");
	if (!NAME_PATTERN.test(String(frontmatter.name))) throw new Error("frontmatter.name 只能是小写字母/数字/连字符");
	if (!frontmatter.description) throw new Error("frontmatter 缺少 description（决定模型何时加载该技能）");
	if (String(frontmatter.description).length > 1024) throw new Error("description 最多 1024 字符");
	if (text.length - match[0].length < 20) throw new Error("SKILL.md 正文太短（至少 20 字符）");
	return { name: String(frontmatter.name), description: String(frontmatter.description) };
}

export function saveSkill(id, content) {
	if (!NAME_PATTERN.test(id)) throw new Error("技能 id 只能是小写字母/数字/连字符");
	validateSkillContent(id, content);
	const dir = join(RUNTIME_SKILLS_DIR, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), String(content), "utf8");
	return findSkill(id);
}

export function deleteSkill(id) {
	if (!NAME_PATTERN.test(id)) return false;
	const dir = join(RUNTIME_SKILLS_DIR, id);
	if (!existsSync(dir)) return false;
	rmSync(dir, { recursive: true, force: true });
	return true;
}

/** 把角色配置里的技能 id 解析成 pi --skill 可用的目录路径 */
export function resolveSkillPaths(skillIds) {
	const paths = [];
	for (const id of skillIds ?? []) {
		const skill = findSkill(id);
		if (skill) paths.push(skill.path);
	}
	return paths;
}

export function skillChoices() {
	return listSkills().map((skill) => ({
		id: skill.id,
		name: skill.name,
		description: skill.description,
		source: skill.source,
	}));
}
