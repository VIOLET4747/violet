/**
 * pi-kit（M1）
 *
 * 所有渗透业务逻辑收敛在这一个 pi 扩展里：
 *   - 注入项目简报（brief）到 system prompt
 *   - 平台工具：dispatch_agent / fact_write / fact_query / get_brief
 *   - 工具输出截断（防止一次 curl 打爆上下文）
 *   - 生命周期打点（文件日志，绝不写 stdout）
 *
 * 注意：RPC 模式下 stdout 只允许协议记录，任何 console.log 都会破坏 JSONL。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

const SERVER_URL = process.env.PENTEST_SERVER_URL ?? "http://127.0.0.1:8787";
const TOKEN = process.env.PENTEST_TOKEN ?? "";
const PROJECT_ID = process.env.PENTEST_PROJECT_ID ?? "";
const AGENT_ID = process.env.PENTEST_AGENT_ID ?? "";
const ROLE = process.env.PENTEST_ROLE ?? "unknown";
const TARGET = process.env.PENTEST_TARGET ?? "";
const LOG_PATH = process.env.PENTEST_KIT_LOG;

const MAX_MODEL_OUTPUT_CHARS = 12_000;

function log(event: string, data: Record<string, unknown> = {}): void {
	if (!LOG_PATH) return;
	try {
		mkdirSync(dirname(LOG_PATH), { recursive: true });
		appendFileSync(
			LOG_PATH,
			`${JSON.stringify({ ts: Date.now(), agentId: AGENT_ID, role: ROLE, event, ...data })}\n`,
			"utf8",
		);
	} catch {
		/* 日志失败不影响 agent */
	}
}

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
	const response = await fetch(`${SERVER_URL}${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			"x-pi-pentest-token": TOKEN,
			...(init.headers ?? {}),
		},
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${path} -> ${response.status}: ${text.slice(0, 500)}`);
	return (text ? JSON.parse(text) : {}) as T;
}

let briefCache: { at: number; text: string } | undefined;

async function fetchBrief(force = false): Promise<string> {
	if (!force && briefCache && Date.now() - briefCache.at < 15_000) return briefCache.text;
	const data = await api<{ brief: string }>(`/internal/brief?agentId=${encodeURIComponent(AGENT_ID)}`);
	briefCache = { at: Date.now(), text: data.brief };
	return data.brief;
}

export default function piKit(pi: ExtensionAPI): void {
	log("extension_loaded", { pid: process.pid, projectId: PROJECT_ID });

	pi.on("session_start", () => log("session_start"));

	// 把简报作为 system prompt 的附加段注入（不整段替换，保留 pi 的缓存与 transcript 增量）
	pi.on("before_agent_start", async (event) => {
		let brief = "";
		try {
			brief = await fetchBrief();
		} catch (error) {
			log("brief_error", { error: String(error) });
		}
		const base = (event as { systemPrompt?: string }).systemPrompt ?? "";
		const injected = [
			`[pi-pentest-role: ${ROLE}]`,
			TARGET ? `[pi-pentest-target: ${TARGET}]` : "",
			brief,
		]
			.filter(Boolean)
			.join("\n");
		if (!injected) return undefined;
		return { systemPrompt: `${base}\n\n${injected}` };
	});

	pi.on("tool_call", (event) => {
		log("tool_call", {
			toolName: (event as { toolName?: string }).toolName,
			input: (event as { input?: unknown }).input,
		});
	});

	// 输出截断：M3 会改成落 artifact，这里先做字符上限，避免 curl 整页 HTML 塞爆上下文
	pi.on("tool_result", (event) => {
		const content = (event as { content?: Array<{ type: string; text?: string }> }).content;
		if (!Array.isArray(content)) return undefined;
		let truncated = false;
		const next = content.map((block) => {
			if (block?.type !== "text" || typeof block.text !== "string") return block;
			if (block.text.length <= MAX_MODEL_OUTPUT_CHARS) return block;
			truncated = true;
			const head = block.text.slice(0, MAX_MODEL_OUTPUT_CHARS);
			return {
				...block,
				text: `${head}\n\n…[输出已截断：原始 ${block.text.length} 字符，只保留前 ${MAX_MODEL_OUTPUT_CHARS}]`,
			};
		});
		if (!truncated) return undefined;
		log("output_truncated");
		return { content: next };
	});

	pi.on("agent_settled", () => log("agent_settled"));

	pi.registerTool(
		defineTool({
			name: "dispatch_agent",
			label: "派发子 Agent",
			description:
				"把一个自包含的子任务派发给专职 agent。必须写清：具体目标、要验证的假设、成功判据。本工具立即返回，子 agent 完成后你会收到系统通知。派发后本轮结束，不要重复派发。",
			parameters: Type.Object({
				role: Type.Union([Type.Literal("recon"), Type.Literal("jwt")], {
					description: "子 agent 角色",
				}),
				objective: Type.String({
					description: "任务书：目标 + 假设 + 判据，一句话说清",
				}),
				targets: Type.Optional(Type.Array(Type.String(), { description: "目标 URL / 主机" })),
				fact_ids: Type.Optional(
					Type.Array(Type.String(), { description: "要一并交给子 agent 的事实 id，如 fact-0001" }),
				),
			}),
			async execute(_toolCallId, params) {
				const result = await api<{ agentId: string; role: string }>("/internal/dispatch", {
					method: "POST",
					body: JSON.stringify({
						parentAgentId: AGENT_ID,
						projectId: PROJECT_ID,
						role: params.role,
						objective: params.objective,
						targets: params.targets ?? [TARGET].filter(Boolean),
						factIds: params.fact_ids ?? [],
					}),
				});
				log("dispatched", { child: result.agentId, role: params.role });
				return {
					content: [
						{
							type: "text",
							text: `已派发 ${result.agentId}（${params.role}）。本轮结束，等系统通知；收到通知后再 fact_query 查看它的产出。`,
						},
					],
					details: result,
					// 派发是异步的：跳过自动续跑，等子 agent 完成后再由平台唤醒
					terminate: true,
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "fact_write",
			label: "写入事实库",
			description:
				"把一条可复用的客观发现写入项目事实库（所有 agent 共享）。必须基于实际执行结果，不得编造。",
			parameters: Type.Object({
				kind: Type.Union(
					[
						Type.Literal("asset"),
						Type.Literal("endpoint"),
						Type.Literal("tech"),
						Type.Literal("credential"),
						Type.Literal("behavior"),
						Type.Literal("finding"),
						Type.Literal("negative"),
					],
					{ description: "事实类型" },
				),
				title: Type.String({ description: "一句话标题" }),
				value: Type.Record(Type.String(), Type.Unknown(), {
					description: "结构化详情（URL、参数、证据摘要、复现命令等）",
				}),
				confidence: Type.Optional(Type.Number({ description: "0..1" })),
			}),
			async execute(_toolCallId, params) {
				const result = await api<{ id: string }>("/internal/facts", {
					method: "POST",
					body: JSON.stringify({
						projectId: PROJECT_ID,
						agentId: AGENT_ID,
						kind: params.kind,
						title: params.title,
						value: params.value,
						confidence: params.confidence ?? 0.8,
					}),
				});
				log("fact_written", { id: result.id, kind: params.kind });
				return {
					content: [{ type: "text", text: `已写入 ${result.id}：${params.title}` }],
					details: result,
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "fact_query",
			label: "查询事实库",
			description: "查询项目事实库（所有 agent 共享的发现）。按关键词/类型过滤。",
			parameters: Type.Object({
				query: Type.Optional(Type.String({ description: "关键词，匹配标题与内容" })),
				kind: Type.Optional(Type.String({ description: "事实类型过滤" })),
				limit: Type.Optional(Type.Number({ description: "最多返回条数，默认 20" })),
			}),
			async execute(_toolCallId, params) {
				const search = new URLSearchParams({
					projectId: PROJECT_ID,
					limit: String(params.limit ?? 20),
				});
				if (params.query) search.set("q", params.query);
				if (params.kind) search.set("kind", params.kind);
				const data = await api<{ facts: Array<{ id: string; kind: string; title: string; value: unknown }> }>(
					`/internal/facts?${search.toString()}`,
				);
				const lines = data.facts.map(
					(fact) =>
						`${fact.id} [${fact.kind}] ${fact.title}\n  ${JSON.stringify(fact.value).slice(0, 400)}`,
				);
				return {
					content: [{ type: "text", text: lines.length ? lines.join("\n\n") : "（事实库为空）" }],
					details: { count: data.facts.length },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "get_brief",
			label: "刷新项目简报",
			description: "重新获取项目简报（目标、范围、已知事实、同级 agent 状态）。",
			parameters: Type.Object({}),
			async execute() {
				const brief = await fetchBrief(true);
				return { content: [{ type: "text", text: brief }], details: { length: brief.length } };
			},
		}),
	);
}
