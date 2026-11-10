/**
 * Agent 调度器（M1）
 *
 * 一个 agent = 一个 `pi --mode rpc` 子进程。
 * 职责：
 *   - 创建/启动子进程，绑定角色、提示词、工具白名单、模型
 *   - 把 pi 的原始事件归一化成领域事件（落库 + 广播给 WebUI）
 *   - 子 agent 完成后，把结构化摘要作为「系统通知」唤醒父 agent
 *   - 支持用户对任意 agent 用自然语言继续对话（运行中 steer、空闲 prompt）
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { PiRpcClient, waitForPiReady } from "../../../packages/agent-runtime/src/index.mjs";
import {
	AGENT_DIR,
	KIT_LOG,
	PI_KIT_ENTRY,
	ROLES_DIR,
	activeModelEnv,
	llmApiKeyEnv,
	projectSessionDir,
	resolvePiCliPath,
} from "./config.mjs";
import { renderBrief } from "./brief.mjs";

const ROLE_TOOLS = {
	commander: ["dispatch_agent", "fact_write", "fact_query", "get_brief"],
	recon: ["powershell", "fact_write", "fact_query", "get_brief"],
	jwt: ["powershell", "fact_write", "fact_query", "get_brief"],
};
const ROLE_LABELS = { commander: "指挥官", recon: "侦察员", jwt: "JWT 专家" };
const ROLE_OBJECTIVES = {
	commander: "负责项目的渗透测试调度与结论汇总（不直接接触目标）",
	recon: "对目标做信息收集，把可复用的发现写入事实库",
	jwt: "对目标做 JWT 专项测试，验证 alg=none / 弱密钥 / claim 篡改",
};

let counter = 0;
const nextId = (prefix) => `${prefix}-${String(++counter).padStart(4, "0")}`;

export class Supervisor {
	constructor({ store, broadcast, serverUrl }) {
		this.store = store;
		this.broadcast = broadcast;
		this.serverUrl = serverUrl;
		this.token = randomBytes(16).toString("hex");
		this.clients = new Map(); // agentId -> ctx
	}

	hasClient(agentId) {
		const ctx = this.clients.get(agentId);
		return Boolean(ctx?.client) && !ctx.client.closed;
	}

	/* ------------------------------ 生命周期 ------------------------------ */

	async createProject({ name, target }) {
		const projectId = nextId("proj");
		const project = this.store.createProject({ id: projectId, name, target, scope: [target] });
		const commander = await this.createAgent({
			projectId,
			parentId: null,
			role: "commander",
			objective: ROLE_OBJECTIVES.commander,
			targets: [target],
			factIds: [],
		});

		// 启动后自动踢第一脚，让主 agent 开始调度
		setTimeout(() => {
			const ctx = this.clients.get(commander.id);
			if (!ctx) return;
			const kickoff = [
				"你的职责：负责本项目的渗透测试调度与结论汇总，不直接接触目标。",
				`项目目标：${target}`,
				`授权范围：${target}（本地靶场，仅用于流程验证）`,
				"请开始：先派 recon 侦察，再根据结果决定下一步。",
			].join("\n");
			this.userMessage(commander.id, kickoff).catch((error) => {
				this.store.appendEvent({
					projectId,
					agentId: commander.id,
					type: "error",
					payload: { message: String(error?.message ?? error) },
				});
			});
		}, 1500);

		return { project, commander };
	}

	async createAgent({ projectId, parentId, role, objective, targets, factIds }) {
		const project = this.store.getProject(projectId);
		if (!project) throw new Error(`项目不存在: ${projectId}`);
		if (!ROLE_TOOLS[role]) throw new Error(`未知角色: ${role}`);
		const activeModel = activeModelEnv();
		if (!activeModel) throw new Error("未配置模型：请先在「模型设置」里填写 API");

		const { provider, model } = activeModel;
		const agent = this.store.createAgent({
			id: nextId("agent"),
			projectId,
			parentId,
			role,
			objective,
			targets: targets?.length ? targets : [project.target],
			factIds: factIds ?? [],
			status: "starting",
			model: `${provider}/${model}`,
		});
		this.broadcast({
			projectId,
			agentId: agent.id,
			type: "agent.created",
			payload: { agent },
		});
		await this.spawn(agent);
		// 根 agent（commander）由 createProject 下发 kickoff；子 agent 在这里下发任务书
		if (agent.parentId) await this.startTask(this.store.getAgent(agent.id));
		return this.store.getAgent(agent.id);
	}

	/** 给刚启动的 agent 下发任务书（作为它的第一条 user 消息）。 */
	async startTask(agent) {
		const project = this.store.getProject(agent.projectId);
		const ctx = this.clients.get(agent.id);
		if (!ctx?.client) return;
		const lines = [
			`任务：${agent.objective}`,
			`目标：${(agent.targets ?? []).join(", ") || project?.target || ""}`,
			agent.factIds?.length ? `参考事实：${agent.factIds.join(", ")}` : "",
			"",
			"请开始执行。每有可复用的发现就立即 fact_write；结束前给出结论（确认了什么、排除了什么、下一步建议）。",
		].filter(Boolean);
		const task = lines.join("\n");
		this.appendUserMessage(agent, task, false);
		ctx.client.prompt(task).catch((error) => {
			this.setStatus(agent.id, "error", `任务下发失败: ${String(error?.message ?? error)}`);
		});
	}

	async spawn(agent) {
		const project = this.store.getProject(agent.projectId);
		const roleFile = join(ROLES_DIR, `${agent.role}.md`);
		if (!existsSync(roleFile)) throw new Error(`角色提示词缺失: ${roleFile}`);

		const { provider, model } = activeModelEnv() ?? {};
		if (!provider || !model) throw new Error("未配置模型");
		const thinking = process.env.PENTEST_THINKING ?? "medium";
		const cli = resolvePiCliPath();
		const sessionDir = projectSessionDir(agent.projectId);
		const ctx = {
			agent,
			project,
			client: null,
			current: null,
			lastAssistantText: "",
			msgSeq: 0,
			stderr: "",
		};

		const client = PiRpcClient.start({
			cli,
			cwd: sessionDir,
			args: [
				"--session-dir",
				sessionDir,
				"--name",
				`${agent.role}-${agent.id.split("-").pop()}`,
				"--provider",
				provider,
				"--model",
				`${provider}/${model}`,
				"--thinking",
				thinking,
				"--append-system-prompt",
				roleFile,
				"--tools",
				ROLE_TOOLS[agent.role].join(","),
				"--no-skills",
				"-e",
				PI_KIT_ENTRY,
			],
			env: {
				PI_CODING_AGENT_DIR: AGENT_DIR,
				PI_OFFLINE: "1",
				NO_COLOR: "1",
				PENTEST_SERVER_URL: this.serverUrl,
				PENTEST_TOKEN: this.token,
				PENTEST_PROJECT_ID: agent.projectId,
				PENTEST_AGENT_ID: agent.id,
				PENTEST_ROLE: agent.role,
				PENTEST_TARGET: project?.target ?? "",
				PENTEST_KIT_LOG: KIT_LOG,
				PENTEST_LLM_KEY: llmApiKeyEnv(),
			},
			commandTimeoutMs: 120_000,
		});

		ctx.client = client;
		this.clients.set(agent.id, ctx);

		client.on("event", (event) => this.onPiEvent(ctx, event));
		client.on("stderr", (chunk) => {
			ctx.stderr += chunk;
		});
		client.on("exit", ({ code, signal }) => {
			const current = this.store.getAgent(agent.id);
			if (current && current.status !== "starting" && current.status !== "idle") {
				this.setStatus(agent.id, "error", `pi 进程退出 code=${code} signal=${signal}`);
			}
			this.clients.delete(agent.id);
		});

		try {
			await waitForPiReady(client, 90_000);
			const state = (await client.getState()).data ?? {};
			const fresh = this.store.getAgent(agent.id);
			this.store.saveAgent({
				...fresh,
				status: "idle",
				sessionFile: state.sessionFile ?? null,
				startedAt: Date.now(),
			});
			this.broadcast({ projectId: agent.projectId, agentId: agent.id, type: "agent.updated", payload: { agent: this.store.getAgent(agent.id) } });
		} catch (error) {
			this.setStatus(agent.id, "error", `启动失败: ${String(error?.message ?? error)}\n${ctx.stderr.slice(-800)}`);
			throw error;
		}
	}

	setStatus(agentId, status, error) {
		const agent = this.store.getAgent(agentId);
		if (!agent) return;
		const saved = this.store.saveAgent({
			...agent,
			status,
			error: error ?? null,
			endedAt: status === "idle" || status === "error" || status === "aborted" ? Date.now() : agent.endedAt,
		});
		this.broadcast({ projectId: agent.projectId, agentId, type: "agent.updated", payload: { agent: saved } });
		return saved;
	}

	/* ------------------------------ pi 事件 ------------------------------ */

	onPiEvent(ctx, event) {
		const { agent } = ctx;
		switch (event.type) {
			case "agent_start": {
				this.setStatus(agent.id, "running");
				break;
			}
			case "message_start": {
				const message = event.message;
				if (message.role !== "assistant" && message.role !== "toolResult") break;
				const id = `${agent.id}-m${++ctx.msgSeq}`;
				ctx.current = { id, role: message.role };
				this.broadcast({
					projectId: agent.projectId,
					agentId: agent.id,
					type: "message.start",
					payload: { id, role: message.role },
				});
				break;
			}
			case "message_update": {
				const update = event.assistantMessageEvent;
				if (!update || !ctx.current) break;
				const delta = deltaOf(update);
				if (!delta) break;
				this.broadcast({
					projectId: agent.projectId,
					agentId: agent.id,
					type: "message.delta",
					payload: { id: ctx.current.id, ...delta },
				});
				break;
			}
			case "message_end": {
				const message = event.message;
				const id = ctx.current?.id ?? `${agent.id}-m${++ctx.msgSeq}`;
				ctx.current = null;
				// 用户消息由 appendUserMessage 自己落库（在 prompt 之前），pi 也会为它发 message_end，跳过避免重复
				if (message?.role === "user") break;
				this.store.appendEvent({
					projectId: agent.projectId,
					agentId: agent.id,
					type: "message",
					payload: { id, message },
				});
				this.broadcast({
					projectId: agent.projectId,
					agentId: agent.id,
					type: "message.end",
					payload: { id, message },
				});
				if (message?.role === "assistant") {
					ctx.lastAssistantText = textOfMessage(message);
					this.applyUsage(agent.id, message.usage);
				}
				break;
			}
			case "tool_execution_start": {
				this.broadcast({
					projectId: agent.projectId,
					agentId: agent.id,
					type: "tool.start",
					payload: { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args },
				});
				break;
			}
			case "tool_execution_end": {
				this.broadcast({
					projectId: agent.projectId,
					agentId: agent.id,
					type: "tool.end",
					payload: {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						isError: event.isError,
						durationMs: event.durationMs,
					},
				});
				break;
			}
			case "agent_settled": {
				const fresh = this.store.getAgent(agent.id);
				if (!fresh) break;
				const saved = this.store.saveAgent({
					...fresh,
					status: "idle",
					endedAt: Date.now(),
				});
				this.broadcast({
					projectId: agent.projectId,
					agentId: agent.id,
					type: "agent.updated",
					payload: { agent: saved, settled: true, aborted: event.aborted },
				});
				// 剧本/部分 provider 不返回 usage：用会话统计里的上下文 token 兜底
				if (!saved.tokensIn) this.applyContextUsage(agent.id).catch(() => {});
				if (saved.parentId && !saved.reportedAt && !event.aborted) {
					this.reportToParent(saved).catch((error) =>
						this.setStatus(saved.id, "error", `汇报失败: ${String(error?.message ?? error)}`),
					);
				}
				break;
			}
			default:
				break;
		}
	}

	applyUsage(agentId, usage) {
		if (!usage) return;
		const agent = this.store.getAgent(agentId);
		if (!agent) return;
		const saved = this.store.saveAgent({
			...agent,
			tokensIn: agent.tokensIn + (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
			tokensOut: agent.tokensOut + (usage.output ?? 0),
			cost: agent.cost + (usage.cost?.total ?? 0),
			turns: agent.turns + 1,
		});
		this.broadcast({ projectId: agent.projectId, agentId, type: "agent.updated", payload: { agent: saved } });
	}

	/** usage 缺失时（剧本模型/部分 provider）用会话统计里的上下文 token 兜底。 */
	async applyContextUsage(agentId) {
		const ctx = this.clients.get(agentId);
		if (!ctx?.client) return;
		try {
			const stats = (await ctx.client.getStats()).data ?? {};
			const tokens =
				stats.contextUsage?.tokens ??
				stats.tokens?.total ??
				stats.tokens?.input ??
				0;
			if (!tokens) return;
			const agent = this.store.getAgent(agentId);
			if (!agent || agent.tokensIn) return;
			const saved = this.store.saveAgent({ ...agent, tokensIn: tokens });
			this.broadcast({ projectId: agent.projectId, agentId, type: "agent.updated", payload: { agent: saved } });
		} catch {
			/* 忽略统计失败 */
		}
	}

	/* ------------------------------ 用户对话 ------------------------------ */

	async userMessage(agentId, text) {
		const agent = this.store.getAgent(agentId);
		if (!agent) throw new Error(`agent 不存在: ${agentId}`);
		const ctx = this.clients.get(agentId);
		if (!ctx?.client) throw new Error("agent 进程不在运行");

		this.appendUserMessage(agent, text, false);

		const state = (await ctx.client.getState()).data ?? {};
		if (state.isStreaming) {
			await ctx.client.send({ type: "steer", message: text });
			return { delivered: "steer" };
		}
		ctx.client.prompt(text).catch((error) => {
			this.setStatus(agentId, "error", `prompt 失败: ${String(error?.message ?? error)}`);
		});
		return { delivered: "prompt" };
	}

	appendUserMessage(agent, text, systemNotice) {
		const id = `${agent.id}-u${Date.now()}`;
		const message = {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
			systemNotice,
		};
		this.store.appendEvent({
			projectId: agent.projectId,
			agentId: agent.id,
			type: "message",
			payload: { id, message },
		});
		this.broadcast({
			projectId: agent.projectId,
			agentId: agent.id,
			type: "message.end",
			payload: { id, message },
		});
	}

	async abort(agentId) {
		const ctx = this.clients.get(agentId);
		if (!ctx?.client) return;
		await ctx.client.abort();
		this.setStatus(agentId, "aborted", "用户中止");
	}

	/* ------------------------------ 子 agent 汇报 ------------------------------ */

	async reportToParent(child) {
		const parent = this.store.getAgent(child.parentId);
		if (!parent) return;
		const ctx = this.clients.get(parent.id);
		const facts = this.store.factsByAgent(child.projectId, child.id);
		const summary =
			this.clients.get(child.id)?.lastAssistantText ||
			lastAssistantTextFromEvents(this.store, child) ||
			"（子 agent 没有输出总结）";

		const lines = [
			`[系统通知] 子 agent ${child.id}（${ROLE_LABELS[child.role] ?? child.role}）已完成。`,
			`任务：${child.objective}`,
			`结论：${truncate(summary, 1200)}`,
			facts.length
				? `新增事实：\n${facts.map((fact) => `- ${fact.id} [${fact.kind}] ${fact.title}`).join("\n")}`
				: "新增事实：无",
			"请用 fact_query 查看完整事实，再决定下一步；如果没有更多要验证的，请给出最终结论。",
		];
		const notice = lines.join("\n");

		const fresh = this.store.getAgent(child.id);
		this.store.saveAgent({ ...fresh, reportedAt: Date.now() });
		this.appendUserMessage(parent, notice, true);

		if (!ctx?.client) return;
		const state = (await ctx.client.getState()).data ?? {};
		if (state.isStreaming) {
			await ctx.client.send({ type: "follow_up", message: notice });
		} else {
			ctx.client.prompt(notice).catch((error) =>
				this.setStatus(parent.id, "error", `唤醒失败: ${String(error?.message ?? error)}`),
			);
		}
	}

	/* ------------------------------ 内部查询 ------------------------------ */

	buildBrief(agentId) {
		const agent = this.store.getAgent(agentId);
		if (!agent) throw new Error("agent 不存在");
		return renderBrief({
			project: this.store.getProject(agent.projectId),
			agent,
			agents: this.store.listAgents(agent.projectId),
			facts: this.store.listFacts(agent.projectId),
			roleLabels: ROLE_LABELS,
		});
	}

	addFact({ projectId, agentId, kind, title, value, confidence }) {
		const fact = this.store.addFact({ projectId, sourceAgent: agentId, kind, title, value, confidence });
		this.broadcast({ projectId, agentId, type: "fact.created", payload: { fact } });
		return fact;
	}

	async shutdown() {
		for (const ctx of this.clients.values()) {
			await ctx.client?.stop().catch(() => {});
		}
		this.clients.clear();
	}
}

/* ------------------------------ 工具函数 ------------------------------ */

function deltaOf(update) {
	const index = update.contentIndex ?? 0;
	switch (update.type) {
		case "text_delta":
			return { kind: "text", contentIndex: index, delta: update.delta };
		case "thinking_delta":
			return { kind: "thinking", contentIndex: index, delta: update.delta };
		case "toolcall_delta":
			return { kind: "toolcall", contentIndex: index, delta: update.delta };
		case "toolcall_end":
			return { kind: "toolcall-end", contentIndex: index };
		default:
			return null;
	}
}

function textOfMessage(message) {
	if (!message?.content) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((block) => {
			if (block?.type === "text") return block.text ?? "";
			if (block?.type === "thinking") return "";
			return "";
		})
		.join("\n")
		.trim();
}

function lastAssistantTextFromEvents(store, agent) {
	const events = store.eventsForAgent(agent.id).filter((event) => event.type === "message");
	for (let index = events.length - 1; index >= 0; index--) {
		const message = events[index].payload.message;
		if (message?.role === "assistant") {
			const text = textOfMessage(message);
			if (text) return text;
		}
	}
	return "";
}

function truncate(text, max) {
	if (!text) return "";
	return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断）`;
}
