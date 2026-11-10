/**
 * 定位本机安装的 pi CLI。
 *
 * 优先级：
 *   1. PI_CLI_PATH 环境变量（手动指定）
 *   2. Pi 托管安装：~/.pi/agent/install/releases/<current-version>/...
 *   3. 全局安装：node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolvePiCli() {
	const explicit = process.env.PI_CLI_PATH;
	if (explicit) {
		if (!existsSync(explicit)) throw new Error(`PI_CLI_PATH 指向的文件不存在: ${explicit}`);
		return explicit;
	}

	const installRoot = process.env.PI_MANAGED_INSTALL_ROOT ?? join(homedir(), ".pi", "agent", "install");
	const versionFile = join(installRoot, "current-version");
	if (existsSync(versionFile)) {
		const version = readFileSync(versionFile, "utf8").trim();
		const pkgDir = join(
			installRoot,
			"releases",
			version,
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
		);
		const pkgJsonPath = join(pkgDir, "package.json");
		if (existsSync(pkgJsonPath)) {
			const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
			const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
			if (bin) {
				const cli = join(pkgDir, bin);
				if (existsSync(cli)) return cli;
			}
		}
	}

	throw new Error(
		[
			"找不到 pi CLI。请先安装：",
			"  powershell -c \"irm https://pi.dev/install.ps1 | iex\"",
			"或用 PI_CLI_PATH 指向 @earendil-works/pi-coding-agent 的 dist/bundle/cli.js",
		].join("\n"),
	);
}
