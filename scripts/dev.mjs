/**
 * 开发模式：同时启动 API/编排服务（8787）和 Vite（5173）。
 * 两个子进程都继承 stdio，Ctrl+C 一起退出。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = join(ROOT, "apps", "web");

const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

const children = [];

function run(name, command, args, options = {}) {
	const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", env: process.env, ...options });
	child.on("exit", (code) => {
		if (code !== 0 && code !== null) console.error(`[dev] ${name} 退出 code=${code}`);
		shutdown(code ?? 0);
	});
	children.push(child);
	return child;
}

let closing = false;
function shutdown(code) {
	if (closing) return;
	closing = true;
	for (const child of children) {
		try {
			child.kill();
		} catch {
			/* ignore */
		}
	}
	setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("[dev] 启动 API/编排 server : http://127.0.0.1:8787");
run("server", process.execPath, [join(ROOT, "apps", "server", "src", "index.mjs")]);

console.log("[dev] 启动 WebUI (Vite)     : http://127.0.0.1:5173");
if (existsSync(npmCli)) {
	run("web", process.execPath, [npmCli, "run", "dev", "--workspace", "@pi-pentest/web"]);
} else {
	// 兜底：Windows 上直接 spawn npm.cmd 需要 shell
	run("web", process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev", "--workspace", "@pi-pentest/web"], {
		shell: true,
	});
}
