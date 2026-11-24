/**
 * M6：字典管理（wordlists）
 *
 * 文件存 .runtime/wordlists/<name>.txt；只做管理与路径暴露，
 * 工具可以通过 argv 里的绝对路径引用（如 {wordlist} 占位由工具 YAML 自行拼接）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME } from "./config.mjs";

const WORDLIST_DIR = join(RUNTIME, "wordlists");
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function ensureWordlistDir() {
	mkdirSync(WORDLIST_DIR, { recursive: true });
}

export function listWordlists() {
	ensureWordlistDir();
	return readdirSync(WORDLIST_DIR)
		.filter((file) => file.endsWith(".txt"))
		.map((file) => {
			const path = join(WORDLIST_DIR, file);
			const content = readFileSync(path, "utf8");
			const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
			return {
				name: file.replace(/\.txt$/, ""),
				path,
				lines,
				bytes: statSync(path).size,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

function safeName(name) {
	if (!NAME_PATTERN.test(name)) throw new Error("字典名只能是小写字母/数字/.-_");
	return join(WORDLIST_DIR, `${name}.txt`);
}

export function getWordlist(name) {
	const path = safeName(name);
	if (!existsSync(path)) return null;
	return { name, path, content: readFileSync(path, "utf8") };
}

export function saveWordlist(name, content) {
	const path = safeName(name);
	ensureWordlistDir();
	const text = String(content ?? "").replace(/\r\n/g, "\n");
	if (!text.trim()) throw new Error("字典内容不能为空");
	writeFileSync(path, text, "utf8");
	return { name, path, content: text, lines: text.split("\n").filter((line) => line.trim()).length };
}

export function deleteWordlist(name) {
	const path = safeName(name);
	if (!existsSync(path)) return false;
	rmSync(path, { force: true });
	return true;
}
