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

	// 会话启动时把 brief 快照写进会话树（只做审计，不进模型上下文）
	pi.on("session_start", async () => {
		log("session_start");
		try {
			const brief = await fetchBrief(true);
			pi.appendEntry("pentest.brief", { at: Date.now(), brief });
		} catch (error) {
			log("brief_entry_error", { error: String(error) });
		}
	});

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
				role: Type.Union([Type.Literal("recon"), Type.Literal("jwt"), Type.Literal("verifier")], {
					description: "子 agent 角色：recon 侦察 / jwt 专项 / verifier 独立验证",
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
			name: "run_tool",
			description:
				"执行工具箱里的本地工具（扫描器/探测/编码等）。优先用它而不是自己拼命令。输出过大时会落 artifact，只返回截断文本和 artifact id；需要全文用 read_artifact。",
			parameters: Type.Object({
				tool: Type.String({ description: "工具 id（用 list_tools 查看）" }),
				args: Type.Optional(
					Type.Record(Type.String(), Type.Unknown(), { description: "工具参数对象" }),
				),
			}),
			async execute(_toolCallId, params) {
				const result = await api<{
					text: string;
					artifactId: string;
					exitCode: number;
					truncated: boolean;
				}>("/internal/tools/run", {
					method: "POST",
					body: JSON.stringify({
						projectId: PROJECT_ID,
						agentId: AGENT_ID,
						toolId: params.tool,
						args: params.args ?? {},
					}),
				});
				log("tool_ran", { tool: params.tool, artifactId: result.artifactId });
				return {
					content: [{ type: "text", text: result.text }],
					details: {
						artifactId: result.artifactId,
						exitCode: result.exitCode,
						truncated: result.truncated,
					},
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "list_tools",
			description: "列出当前工具箱里所有可用工具（id、说明、参数）。",
			parameters: Type.Object({}),
			async execute() {
				const data = await api<{ tools: Array<{ id: string; name: string; description: string; params: unknown[] }> }>(
					"/internal/tools",
				);
				const lines = data.tools.map(
					(tool) =>
						`- ${tool.id}（${tool.name}）：${tool.description}${tool.params?.length ? ` · 参数：${JSON.stringify(tool.params)}` : ""}`,
				);
				return {
					content: [{ type: "text", text: lines.join("\n") || "（工具箱为空）" }],
					details: { count: data.tools.length },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "read_artifact",
			description: "读取 artifact（工具完整输出）的片段。先用 run_tool 返回的 artifact id。",
			parameters: Type.Object({
				artifact_id: Type.String({ description: "artifact id，如 art-0001" }),
				offset: Type.Optional(Type.Number({ description: "字符偏移，默认 0" })),
				limit: Type.Optional(Type.Number({ description: "最多读取字符数，默认 20000" })),
			}),
			async execute(_toolCallId, params) {
				const data = await api<{
					text: string;
					totalBytes: number;
					offset: number;
					limit: number;
					hasMore: boolean;
				}>("/internal/artifacts/read", {
					method: "POST",
					body: JSON.stringify({
						artifactId: params.artifact_id,
						offset: params.offset ?? 0,
						limit: params.limit ?? 20000,
					}),
				});
				const meta = `[artifact ${params.artifact_id} · offset=${data.offset} · 本段 ${data.limit} / 总 ${data.totalBytes} 字节${data.hasMore ? " · 还有更多" : ""}]`;
				return {
					content: [{ type: "text", text: `${meta}\n${data.text}` }],
					details: { totalBytes: data.totalBytes, hasMore: data.hasMore },
				};
			},
		}),
	);

	/* ------------------------------ M4：证据链 ------------------------------ */

	pi.registerTool(
		defineTool({
			name: "http_send",
			description:
				"通过平台发 HTTP 请求：完整 request/response 原文会落 artifact（sha256），返回状态码、摘录和 artifact id。所有漏洞声称必须先用它拿到证据，不能只靠推理。目标必须在授权 scope 内。",
			parameters: Type.Object({
				url: Type.String({ description: "完整 URL，必须在项目 scope 内" }),
				method: Type.Optional(Type.String({ description: "HTTP 方法，默认 GET" })),
				headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "请求头" })),
				body: Type.Optional(Type.String({ description: "请求体（字符串）" })),
			}),
			async execute(_toolCallId, params) {
				const data = await api<{
					exchangeId: string;
					status: number | null;
					bodyExcerpt: string;
					requestArtifact: string;
					responseArtifact: string | null;
					error: string | null;
				}>("/internal/http/send", {
					method: "POST",
					body: JSON.stringify({
						projectId: PROJECT_ID,
						agentId: AGENT_ID,
						method: params.method ?? "GET",
						url: params.url,
						headers: params.headers ?? {},
						body: params.body,
					}),
				});
				log("http_send", { exchangeId: data.exchangeId, status: data.status, url: params.url });
				const text = [
					`exchange=${data.exchangeId} status=${data.status ?? "ERROR"}${data.error ? ` error=${data.error}` : ""}`,
					`artifact: request=${data.requestArtifact} response=${data.responseArtifact ?? "（无，请求失败）"}`,
					"",
					data.bodyExcerpt,
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: { exchangeId: data.exchangeId, status: data.status, requestArtifact: data.requestArtifact, responseArtifact: data.responseArtifact },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "finding_submit",
			description:
				"提交漏洞候选。服务端会硬校验：字段完整、evidence_ids 真实存在且属于本项目、至少一条 http-response 证据、target 在 scope 内、去重。被拒会返回具体原因，按提示补证据/改字段后重试。",
			parameters: Type.Object({
				title: Type.String({ description: "漏洞标题，≥8 字" }),
				category: Type.String({ description: "类别，如 jwt / idor / auth-bypass" }),
				severity: Type.String({ description: "critical | high | medium | low | info" }),
				target: Type.String({ description: "受影响 URL/接口，必须在 scope 内" }),
				summary: Type.String({ description: "漏洞摘要，≥20 字" }),
				technical_analysis: Type.String({ description: "技术分析，≥30 字" }),
				impact: Type.String({ description: "影响，≥20 字" }),
				preconditions: Type.Array(Type.String(), { description: "前置条件" }),
				evidence_ids: Type.Array(Type.String(), { description: "证据 artifact id（http_send 返回）" }),
				poc: Type.Object({
					type: Type.String({ description: "http | script | manual" }),
					steps: Type.Array(Type.String(), { description: "可复现步骤，≥1 条" }),
					expect: Type.Object({
						match: Type.String({ description: "status | body_regex | header_regex" }),
						value: Type.String({ description: "匹配值，如 200 或正则" }),
					}),
					request_artifact_ids: Type.Optional(Type.Array(Type.String())),
				}),
				counterevidence: Type.String({ description: "为什么不是误报，≥10 字" }),
				severity_change_conditions: Type.Optional(Type.String()),
				confidence: Type.String({ description: "high | medium | low" }),
				confidence_rationale: Type.String({ description: "置信度依据，≥10 字" }),
			}),
			async execute(_toolCallId, params) {
				const data = await api<{ finding?: { id: string; status: string }; duplicate_of?: string }>(
					"/internal/findings/submit",
					{
						method: "POST",
						body: JSON.stringify({ projectId: PROJECT_ID, agentId: AGENT_ID, finding: params }),
					},
				);
				if (data.duplicate_of) {
					return { content: [{ type: "text", text: `已存在相同 finding：${data.duplicate_of}（未重复创建）` }], details: data };
				}
				return {
					content: [{ type: "text", text: `finding 已提交：${data.finding?.id}（status=${data.finding?.status}，等待 verifier 独立重放）` }],
					details: data,
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "finding_query",
			description: "查询本项目的 finding 列表（候选/已验证/争议）。",
			parameters: Type.Object({
				status: Type.Optional(Type.String({ description: "candidate | verified | disputed，省略为全部" })),
			}),
			async execute(_toolCallId, params) {
				const data = await api<{
					findings: Array<{ id: string; title: string; severity: string; status: string; target: string; confidence: string }>;
				}>(`/internal/findings?projectId=${encodeURIComponent(PROJECT_ID)}`);
				const list = params.status ? data.findings.filter((item) => item.status === params.status) : data.findings;
				const lines = list.map(
					(item) => `${item.id} [${item.status}/${item.severity}] ${item.title} · ${item.target} · confidence=${item.confidence}`,
				);
				return { content: [{ type: "text", text: lines.join("\n") || "（暂无 finding）" }], details: { count: list.length } };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "finding_verify",
			description:
				"verifier 专用：用独立的新证据重放，服务端会按 poc.expect 自动比对；PASS → verified，FAIL → disputed。不能复用原 finding 的证据。",
			parameters: Type.Object({
				finding_id: Type.String({ description: "finding id" }),
				evidence_ids: Type.Array(Type.String(), { description: "本次重放新产生的 artifact id（http_send 返回）" }),
				verdict: Type.String({ description: "verified | disputed" }),
				rationale: Type.Optional(Type.String({ description: "判定说明" })),
			}),
			async execute(_toolCallId, params) {
				const data = await api<{
					finding: { id: string; status: string };
					evaluation: { matched: boolean; detail: unknown };
					note: string;
				}>("/internal/findings/verify", {
					method: "POST",
					body: JSON.stringify({
						projectId: PROJECT_ID,
						agentId: AGENT_ID,
						findingId: params.finding_id,
						evidenceIds: params.evidence_ids,
						verdict: params.verdict,
						rationale: params.rationale ?? "",
					}),
				});
				const text = `finding ${data.finding.id} → ${data.finding.status}（expect matched=${data.evaluation.matched}）\n${data.note}`;
				return { content: [{ type: "text", text }], details: data };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "coverage_update",
			description:
				"更新覆盖率账本：confirmed / ruled_out / open_proof_gap。ruled_out 必须写具体 control_point（文件:行号 / WAF 规则 id），说不出来只能记 open_proof_gap。",
			parameters: Type.Object({
				test_class: Type.String({ description: "测试类，如 sqli / jwt / idor" }),
				outcome: Type.String({ description: "confirmed | ruled_out | open_proof_gap" }),
				control_point: Type.Optional(Type.String({ description: "ruled_out 必填：具体控制点" })),
				rationale: Type.Optional(Type.String()),
				evidence_ids: Type.Optional(Type.Array(Type.String())),
				target: Type.Optional(Type.String()),
			}),
			async execute(_toolCallId, params) {
				const data = await api<{ coverage: { id: string; outcome: string; testClass: string } }>(
					"/internal/coverage/update",
					{
						method: "POST",
						body: JSON.stringify({
							projectId: PROJECT_ID,
							agentId: AGENT_ID,
							coverage: {
								test_class: params.test_class,
								outcome: params.outcome,
								control_point: params.control_point,
								rationale: params.rationale,
								evidence_ids: params.evidence_ids,
								target: params.target ?? TARGET,
							},
						}),
					},
				);
				return {
					content: [{ type: "text", text: `coverage 已更新：${data.coverage.testClass} → ${data.coverage.outcome}` }],
					details: data,
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "coverage_query",
			description: "查询覆盖率账本（哪些已确认 / 已排除 / 仍有证明缺口）。",
			parameters: Type.Object({
				outcome: Type.Optional(Type.String({ description: "confirmed | ruled_out | open_proof_gap" })),
			}),
			async execute(_toolCallId, params) {
				const data = await api<{
					coverage: Array<{ testClass: string; outcome: string; controlPoint?: string; rationale?: string }>;
				}>(`/internal/coverage?projectId=${encodeURIComponent(PROJECT_ID)}`);
				const list = params.outcome ? data.coverage.filter((item) => item.outcome === params.outcome) : data.coverage;
				const lines = list.map(
					(item) =>
						`${item.testClass} → ${item.outcome}${item.controlPoint ? `（控制点：${item.controlPoint}）` : ""}${item.rationale ? ` · ${item.rationale}` : ""}`,
				);
				return { content: [{ type: "text", text: lines.join("\n") || "（账本为空）" }], details: { count: list.length } };
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
