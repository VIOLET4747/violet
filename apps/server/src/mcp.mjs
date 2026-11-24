/**
 * 极简 MCP 客户端管理：连接 stdio / http / sse 三种 MCP Server，
 * 缓存 tools 列表，供工具箱 UI 与 agent 的 list_tools / run_tool 使用。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CONNECT_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 60_000;

function withTimeout(promise, ms, message) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class McpManager {
	constructor() {
		/** toolId -> { client, transport, tools, connectedAt } */
		this.servers = new Map();
	}

	transportFor(tool) {
		const cfg = tool.mcp ?? {};
		const headers = cfg.headers ?? {};
		if (cfg.transport === "stdio") {
			if (!cfg.command) throw new Error("MCP stdio 需要 command");
			return new StdioClientTransport({
				command: cfg.command,
				args: cfg.args ?? [],
				cwd: cfg.cwd || undefined,
				env: { ...process.env, ...(cfg.env ?? {}) },
				stderr: "ignore",
			});
		}
		if (cfg.transport === "http") {
			if (!cfg.url) throw new Error("MCP http 需要 url");
			return new StreamableHTTPClientTransport(new URL(cfg.url), {
				requestInit: { headers },
			});
		}
		if (cfg.transport === "sse") {
			if (!cfg.url) throw new Error("MCP sse 需要 url");
			return new SSEClientTransport(new URL(cfg.url), { requestInit: { headers } });
		}
		throw new Error(`不支持的 MCP transport: ${cfg.transport}`);
	}

	async connect(tool) {
		const cached = this.servers.get(tool.id);
		if (cached && Date.now() - cached.connectedAt < CACHE_TTL_MS) return cached;

		await this.close(tool.id);
		const client = new Client({ name: "pi-pentest", version: "0.3.0" }, { capabilities: {} });
		const transport = this.transportFor(tool);
		await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `MCP ${tool.id} 连接超时`);
		const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `MCP ${tool.id} tools/list 超时`);
		const entry = {
			client,
			transport,
			tools: (listed.tools ?? []).map((item) => ({
				name: item.name,
				description: item.description ?? "",
				inputSchema: item.inputSchema ?? { type: "object", properties: {} },
			})),
			connectedAt: Date.now(),
		};
		this.servers.set(tool.id, entry);
		return entry;
	}

	async listTools(tool) {
		try {
			const entry = await this.connect(tool);
			return { ok: true, tools: entry.tools };
		} catch (error) {
			await this.close(tool.id);
			return { ok: false, error: String(error?.message ?? error), tools: [] };
		}
	}

	async callTool(tool, name, args = {}, timeoutMs = 120_000) {
		const entry = await this.connect(tool);
		const result = await withTimeout(
			entry.client.callTool({ name, arguments: args ?? {} }),
			timeoutMs,
			`MCP ${tool.id}/${name} 调用超时`,
		);
		return result;
	}

	async close(toolId) {
		const entry = this.servers.get(toolId);
		if (!entry) return;
		this.servers.delete(toolId);
		try {
			await entry.client.close();
		} catch {
			/* ignore */
		}
	}

	async closeAll() {
		for (const id of [...this.servers.keys()]) await this.close(id);
	}
}

/** MCP tool 结果 -> 纯文本（text / json / 资源引用） */
export function mcpResultText(result) {
	const blocks = result?.content ?? [];
	const parts = [];
	for (const block of blocks) {
		if (block?.type === "text") parts.push(block.text ?? "");
		else if (block?.type === "resource") parts.push(JSON.stringify(block.resource ?? block));
		else if (block?.type === "image") parts.push(`[image ${block.mimeType ?? ""} base64=${(block.data ?? "").length} chars]`);
		else parts.push(JSON.stringify(block));
	}
	if (!parts.length && result?.structuredContent) parts.push(JSON.stringify(result.structuredContent));
	if (!parts.length) parts.push(JSON.stringify(result ?? {}));
	return parts.join("\n");
}
