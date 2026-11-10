/**
 * 最小可用的 pi RPC 客户端（M0 版）。
 *
 * 这是 packages/agent-runtime 的骨架：负责
 *   - spawn `pi --mode rpc`
 *   - 把 stdin 写成严格 JSONL 命令
 *   - 按 LF 切 stdout（不能用 readline：它会在 U+2028/U+2029 误断）
 *   - 按 id 关联 command / response
 *   - 把 session event 转成 EventEmitter 事件
 *   - 等 agent_settled（不是 agent_end）判定"这轮真的结束了"
 *
 * 后续 M1 会在此基础上加：事件持久化、会话恢复、并发管理。
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export class PiRpcClient extends EventEmitter {
	#child;
	#buffer = "";
	#pending = new Map();
	#seq = 0;
	#settledWaiters = [];
	#closed = false;
	#stderrText = "";
	#commandTimeoutMs;

	constructor(child, options = {}) {
		super();
		this.#child = child;
		this.#commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
		this.#wire();
	}

	static start({ cli, cwd, args = [], env = {}, commandTimeoutMs } = {}) {
		const child = spawn(process.execPath, [cli, "--mode", "rpc", ...args], {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		return new PiRpcClient(child, { commandTimeoutMs });
	}

	get closed() {
		return this.#closed;
	}

	get stderrText() {
		return this.#stderrText;
	}

	#wire() {
		this.#child.stdout.setEncoding("utf8");
		this.#child.stdout.on("data", (chunk) => this.#onStdout(chunk));

		this.#child.stderr.setEncoding("utf8");
		this.#child.stderr.on("data", (chunk) => {
			this.#stderrText += chunk;
			this.emit("stderr", chunk);
		});

		this.#child.on("error", (error) => {
			this.#failAll(error);
			this.emit("error", error);
		});

		this.#child.on("exit", (code, signal) => {
			this.#closed = true;
			const error = new Error(`pi 进程退出: code=${code} signal=${signal}`);
			this.#failAll(error);
			for (const waiter of this.#settledWaiters.splice(0)) {
				waiter.reject(error);
			}
			this.emit("exit", { code, signal });
		});

		this.#child.stdin.on("error", () => {
			/* 进程退出时写入会 EPIPE，由 exit 统一处理 */
		});
	}

	#onStdout(chunk) {
		this.#buffer += chunk;
		let newlineIndex = this.#buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			let line = this.#buffer.slice(0, newlineIndex);
			this.#buffer = this.#buffer.slice(newlineIndex + 1);
			newlineIndex = this.#buffer.indexOf("\n");
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;
			this.#onRecord(line);
		}
	}

	#onRecord(line) {
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			this.emit("protocol-error", line);
			return;
		}

		if (record.type === "response") {
			const key = record.id;
			const pending = key !== undefined ? this.#pending.get(key) : undefined;
			if (pending) {
				this.#pending.delete(key);
				pending.resolve(record);
			} else {
				this.emit("orphan-response", record);
			}
			return;
		}

		this.emit("record", record);
		this.emit("event", record);

		if (record.type === "agent_settled") {
			for (const waiter of this.#settledWaiters.splice(0)) {
				waiter.resolve(record);
			}
		}
	}

	#failAll(error) {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}

	/** 发送一条 RPC 命令，返回对应的 response 记录。 */
	send(command) {
		if (this.#closed) return Promise.reject(new Error("pi 进程已退出，无法发送命令"));
		const id = command.id ?? `cmd-${++this.#seq}`;
		const payload = { ...command, id };
		const line = `${JSON.stringify(payload)}\n`;

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`命令超时 ${this.#commandTimeoutMs}ms: ${command.type}`));
			}, this.#commandTimeoutMs);
			timer.unref?.();

			this.#pending.set(id, {
				resolve: (record) => {
					clearTimeout(timer);
					if (record.success === false) {
						reject(new Error(`命令失败 ${command.type}: ${record.error ?? "unknown"}`));
						return;
					}
					resolve(record);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});

			this.#child.stdin.write(line, (error) => {
				if (!error) return;
				clearTimeout(timer);
				this.#pending.delete(id);
				reject(error);
			});
		});
	}

	async getState() {
		return this.send({ type: "get_state" });
	}

	async getStats() {
		return this.send({ type: "get_session_stats" });
	}

	async prompt(message) {
		return this.send({ type: "prompt", message });
	}

	async abort() {
		return this.send({ type: "abort" });
	}

	async getMessages() {
		return this.send({ type: "get_messages" });
	}

	async getLastAssistantText() {
		return this.send({ type: "get_last_assistant_text" });
	}

	/** 等待下一次 agent_settled。必须在 prompt 之前调用，避免竞态。 */
	waitForSettled(timeoutMs = 120_000) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const index = this.#settledWaiters.findIndex((waiter) => waiter.timer === timer);
				if (index !== -1) this.#settledWaiters.splice(index, 1);
				reject(new Error(`等待 agent_settled 超时 ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref?.();
			this.#settledWaiters.push({
				timer,
				resolve: (record) => {
					clearTimeout(timer);
					resolve(record);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
		});
	}

	/** 有序关闭：先关 stdin 让 pi 释放运行时，再兜底 kill。 */
	async stop({ timeoutMs = 5_000 } = {}) {
		if (this.#closed) return;
		this.#child.stdin.end();
		const exited = new Promise((resolve) => this.#child.once("exit", resolve));
		const timeout = new Promise((resolve) => {
			const timer = setTimeout(() => resolve("timeout"), timeoutMs);
			timer.unref?.();
		});
		const result = await Promise.race([exited, timeout]);
		if (result === "timeout") {
			this.#child.kill();
			await new Promise((resolve) => this.#child.once("exit", resolve));
		}
	}
}

/** 轮询 get_state 直到 pi 完成启动（会话、扩展、MCP 都就绪）。 */
export async function waitForPiReady(client, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			await client.getState();
			return;
		} catch (error) {
			lastError = error;
			if (client.closed) break;
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	}
	throw new Error(`pi 启动失败: ${lastError?.message ?? "unknown"}`);
}
