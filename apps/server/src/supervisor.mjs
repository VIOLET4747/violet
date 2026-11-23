/**
 * Agent 调度器（M1 收口版）
 *
 * 一个 agent = 一个 `pi --mode rpc` 子进程。
 * 职责：
 *   - 队列 + 并发上限：同时最多 N 个 agent，其余排队
 *   - 生命周期：queued → starting → running → idle | failed | aborted
 *   - 墙钟超时 + 心跳兜底：卡死/超长任务会被中止并标记 failed
 *   - 级联中止：中止父 agent 会带走它的整棵子树
 *   - 事件归一化：落库 + 广播给 WebUI
 *   - 子 agent 完成后，把摘要作为「系统通知」唤醒父 agent（空闲时合并，忙碌时排队）
 *   - 用户对任意 agent 的自然语言对话（运行中 steer、空闲 prompt）
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PiRpcClient, waitForPiReady } from "../../../packages/agent-runtime/src/index.mjs";
import {
	AGENT_DIR,
	KIT_LOG,
	LIMITS,
	PI_KIT_ENTRY,
	ROLES_DIR,
	activeModelEnv,
	llmApiKeyEnv,
	projectSessionDir,
	projectWorkspaceDir,
	resolvePiCliPath,
} from "./config.mjs";
import { renderBrief } from "./brief.mjs";

const ROLE_TOOLS = {
	commander: ["dispatch_agent", "fact_write", "fact_query", "get_brief"],
	recon: ["powershell", "run_tool", "list_tools", "read_artifact", "fact_write", "fact_query", "get_brief"],
	jwt: ["powershell", "run_tool", "list_tools", "read_artifact", "fact_write", "fact_query", "get_brief"],
};
const ROLE_LABELS = { commander: "指挥官", recon: "侦察员", jwt: "JWT 专家" };
const ROLE_OBJECTIVES = {
	commander: "负责项目的渗透测试调度与结论汇总（不直接接触目标）",
	recon: "对目标做信息收集，把可复用的发现写入事实库",
	jwt: "对目标做 JWT 专项测试，验证 alg=none / 弱密钥 / claim 篡改",
};
const TERMINAL_STATUSES = new Set(["idle", "failed", "aborted", "error"]);

let counter = 0;
const nextId = (prefix) => `${prefix}-${String(++counter).padStart(4, "0")}`;

/**
 * 从已有数据库恢复 ID 计数器，避免服务重启后新 id 撞已有主键。
 */
export function seedIdCounter(store) {
	let max = 0;
	const bump = (id) => {
		const match = /-(\d+)$/.exec(id ?? "");
		if (match) max = Math.max(max, Number(match[1]));
	};
	for (const project of store.listProjects()) {
		bump(project.id);
		for (const agent of store.listAgents(project.id)) bump(agent.id);
	}
	counter = max;
	return max;
}

export class Supervisor {
	constructor({ store, broadcast, serverUrl }) {
		this.store = store;
		this.broadcast = broadcast;
		this.serverUrl = serverUrl;
		this.token = randomBytes(16).toString("hex");
		this.clients = new Map(); // agentId -> ctx（已启动的）
		this.queue = []; // 等待启动的 agentId
		this.active = new Set(); // 正在占用并发槽的 agentId
		this.kickoffs = new Map(); // agentId -> 启动后要下发的第一条消息
		this.pendingNotices = new Map(); // parentId -> string[]
		this.noticeTimers = new Map(); // parentId -> {debounce?, maxWait?}
	}

	hasClient(agentId) {
		const ctx = this.clients.get(agentId);
		return Boolean(ctx?.client) && !ctx.client.closed;
	}

	hasCapacity() {
		return this.active.size < LIMITS.maxConcurrentAgents;
	}

	/* ------------------------------ 项目 ------------------------------ */

	async createProject({ name, target, kickoff }) {
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
		this.kickoffs.set(
			commander.id,
			kickoff ||
				[
					"你的职责：负责本项目的渗透测试调度与结论汇总，不直接接触目标。",
					`项目目标：${target}`,
					`授权范围：${target}（本地靶场，仅用于流程验证）`,
					"请开始：先派 recon 侦察，再根据结果决定下一步。",
				].join("\n"),
		);
		this.pump();
		return { project, commander: this.store.getAgent(commander.id) };
	}

	async createAgent({ projectId, parentId, role, objective, targets, factIds }) {
		const project = this.store.getProject(projectId);
		if (!project) throw new Error(`项目不存在: ${projectId}`);
		if (!ROLE_TOOLS[role]) throw new Error(`未知角色: ${role}`);
		if (parentId) {
			const children = this.store.listAgents(projectId).filter((agent) => agent.parentId);
			if (children.length >= LIMITS.maxChildrenPerProject) {
				throw new Error(`本项目子 agent 已达上限 ${LIMITS.maxChildrenPerProject}，请先汇总现有结论`);
			}
		}
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
			status: "queued",
			model: `${provider}/${model}`,
		});
		this.broadcast({ projectId, agentId: agent.id, type: "agent.created", payload: { agent } });
		this.queue.push(agent.id);
		this.pump();
		return this.store.getAgent(agent.id);
	}

	/* ------------------------------ 队列与启动 ------------------------------ */

	pump() {
		while (this.queue.length > 0 && this.hasCapacity()) {
			const agentId = this.queue.shift();
			const agent = this.store.getAgent(agentId);
			if (!agent || agent.status !== "queued") continue;
			this.active.add(agentId);
			this.startAgent(agent).catch((error) => {
				this.finishAgent(agentId, "failed", `启动失败: ${String(error?.message ?? error)}`);
			});
		}
	}

	async startAgent(agent) {
		this.setStatus(agent.id, "starting");
		await this.spawn(agent);
		const ctx = this.clients.get(agent.id);
		if (!ctx) return;
		const kickoff = this.kickoffs.get(agent.id);
		if (kickoff) {
			this.kickoffs.delete(agent.id);
			await this.sendPrompt(agent, kickoff, false);
			return;
		}
		if (agent.parentId) await this.startTask(agent);
	}

	/**
	 * 恢复一个被中断/失败的 agent：新起一个 pi 进程，切换回原来的会话文件。
	 * 不自动下发任务，用户可以继续对话，或由父 agent 重新派发。
	 */
	async resumeAgent(agentId) {
		const agent = this.store.getAgent(agentId);
		if (!agent) throw new Error(`agent 不存在: ${agentId}`);
		const existing = this.clients.get(agentId);
		if (existing && !existing.finished) throw new Error("agent 已在运行，无需恢复");
		if (!agent.sessionFile || !existsSync(agent.sessionFile)) {
			throw new Error("没有找到可恢复的会话文件（可能已被清理）");
		}
		// 终态后旧 pi 进程可能还在退出：先停掉，避免两个进程写同一个会话文件
		if (existing) {
			existing.silent = true;
			this.clearTimers(existing);
			await existing.client?.abort().catch(() => {});
			await existing.client?.stop().catch(() => {});
			for (let i = 0; i < 50 && this.clients.get(agentId); i += 1) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			if (this.clients.get(agentId)) this.clients.delete(agentId);
			this.active.delete(agentId);
		}
		if (!this.hasCapacity()) throw new Error("并发已满，请稍后再试");
		this.active.add(agentId);
		this.setStatus(agentId, "starting");
		try {
			await this.spawn(agent, { resumeSession: agent.sessionFile });
			// 恢复后清掉旧汇报标记：再次失败时仍然要通知父 agent
			const current = this.store.getAgent(agentId);
			if (current) this.store.saveAgent({ ...current, reportedAt: null });
			// 崩溃期间积压的唤醒通知，在恢复后补投
			this.flushNotices(agentId).catch(() => {});
			return this.store.getAgent(agentId);
		} catch (error) {
			this.finishAgent(agentId, "failed", `恢复失败: ${String(error?.message ?? error)}`);
			throw error;
		}
	}

	async spawn(agent, options = {}) {
		const project = this.store.getProject(agent.projectId);
		const roleFile = join(ROLES_DIR, `${agent.role}.md`);
		if (!existsSync(roleFile)) throw new Error(`角色提示词缺失: ${roleFile}`);

		const { provider, model } = activeModelEnv() ?? {};
		if (!provider || !model) throw new Error("未配置模型");
		const thinking = process.env.PENTEST_THINKING ?? "medium";
		const cli = resolvePiCliPath();
		const sessionDir = projectSessionDir(agent.projectId);
		const workspaceDir = projectWorkspaceDir(agent.projectId);
		const ctx = {
			agent,
			project,
			client: null,
			current: null,
			lastAssistantText: "",
			lastStopReason: "stop",
			lastErrorMessage: "",
			msgSeq: 0,
			stderr: "",
			finished: false,
			silent: false,
			timeoutTimer: null,
			heartbeatTimer: null,
			// 正在执行的工具：工具执行期间没有 pi 事件，心跳不能误判卡死
			activeTools: new Set(),
			// 预算基线：恢复时从这里重新计算，避免预算耗尽的 agent 恢复后立刻再次失败
			budgetBaseTurns: 0,
			budgetBaseTokens: 0,
		};
		const snapshot = this.store.getAgent(agent.id) ?? agent;
		ctx.budgetBaseTurns = snapshot.turns ?? 0;
		ctx.budgetBaseTokens = (snapshot.tokensIn ?? 0) + (snapshot.tokensOut ?? 0);

		const client = PiRpcClient.start({
			cli,
			// 工具产物进 workspace，会话 JSONL 只放 sessions/，两者互不污染
			cwd: workspaceDir,
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
			const message = `pi 进程退出 code=${code} signal=${signal}`;
			const current = this.store.getAgent(agent.id);
			if (!ctx.finished && current && !TERMINAL_STATUSES.has(current.status)) {
				this.finishAgent(agent.id, "failed", message);
			}
			this.clients.delete(agent.id);
			this.active.delete(agent.id);
			this.pump();
		});

		await waitForPiReady(client, 90_000);
		if (options.resumeSession) {
			await client.send({ type: "switch_session", sessionPath: options.resumeSession });
		}
		const state = (await client.getState()).data ?? {};
		const fresh = this.store.getAgent(agent.id);
		if (!fresh || fresh.status === "aborted") return;
		this.store.saveAgent({
			...fresh,
			status: "idle",
			sessionFile: state.sessionFile ?? options.resumeSession ?? fresh.sessionFile ?? null,
			startedAt: fresh.startedAt ?? Date.now(),
			endedAt: null,
			error: null,
		});
		this.broadcast({
			projectId: agent.projectId,
			agentId: agent.id,
			type: "agent.updated",
			payload: { agent: this.store.getAgent(agent.id) },
		});
		// 不在 spawn 后启动计时器：空闲等待用户对话的 agent 不应该被心跳判死。
		// 计时器在 agent_start 时启动，在 settle/终态时清除。
	}

	armTimers(ctx) {
		const { agent } = ctx;
		ctx.timeoutTimer = setTimeout(() => {
			this.failWithHandoff(agent.id, `超过墙钟上限 ${Math.round(LIMITS.agentTimeoutMs / 60000)} 分钟`);
			this.abortWithKill(ctx);
		}, LIMITS.agentTimeoutMs);
		this.resetHeartbeat(ctx);
	}

	resetHeartbeat(ctx) {
		if (ctx.finished) return;
		clearTimeout(ctx.heartbeatTimer);
		ctx.heartbeatTimer = setTimeout(() => {
			// 工具执行期间没有 pi 事件是正常的（nmap/sqlmap 可能跑很久），交给墙钟兜底
			if (ctx.activeTools?.size > 0) {
				this.resetHeartbeat(ctx);
				return;
			}
			this.failWithHandoff(
				ctx.agent.id,
				`心跳超时：${Math.round(LIMITS.heartbeatMs / 60000)} 分钟没有收到 agent 事件`,
			);
			this.abortWithKill(ctx);
		}, LIMITS.heartbeatMs);
	}

	/** 中止后如果 pi 进程不退出，宽限 10s 强制结束，避免僵尸进程占着会话和并发槽。 */
	abortWithKill(ctx) {
		ctx.client?.abort().catch(() => {});
		const timer = setTimeout(() => {
			if (this.clients.get(ctx.agent.id) === ctx) ctx.client?.stop().catch(() => {});
		}, 10_000);
		timer.unref?.();
	}

	clearTimers(ctx) {
		clearTimeout(ctx.timeoutTimer);
		clearTimeout(ctx.heartbeatTimer);
		ctx.timeoutTimer = null;
		ctx.heartbeatTimer = null;
	}

	/** 统一的终态收尾：只生效一次。 */
	finishAgent(agentId, status, error, extras = {}) {
		const ctx = this.clients.get(agentId);
		if (ctx?.finished && status !== "idle") return this.store.getAgent(agentId);
		if (ctx) {
			ctx.finished = status !== "idle";
			this.clearTimers(ctx);
		}
		const agent = this.store.getAgent(agentId);
		if (!agent) return undefined;

		// 排队中的 agent 直接终止
		this.queue = this.queue.filter((id) => id !== agentId);
		this.active.delete(agentId);

		const saved = this.store.saveAgent({
			...agent,
			status,
			error: error ?? null,
			endedAt: Date.now(),
		});
		if (extras.handoff) {
			this.store.appendEvent({
				projectId: agent.projectId,
				agentId,
				type: "handoff",
				payload: { reason: error ?? "", note: extras.handoff },
			});
		}
		this.broadcast({
			projectId: agent.projectId,
			agentId,
			type: "agent.updated",
			payload: { agent: saved, settled: status !== "failed" },
		});

		if (saved.parentId && !saved.reportedAt && !ctx?.silent) {
			this.reportToParent(saved, status, error, extras.handoff).catch((err) =>
				this.setStatus(saved.id, "error", `汇报失败: ${String(err?.message ?? err)}`),
			);
		}
		this.pump();
		return this.store.getAgent(agentId);
	}

	/* ------------------------------ pi 事件 ------------------------------ */

	onPiEvent(ctx, event) {
		const { agent } = ctx;
		this.resetHeartbeat(ctx);
		switch (event.type) {
			case "agent_start": {
				this.setStatus(agent.id, "running");
				if (!ctx.timeoutTimer) this.armTimers(ctx);
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
					ctx.lastStopReason = message.stopReason ?? "stop";
					ctx.lastErrorMessage = message.errorMessage ?? "";
					this.applyUsage(agent.id, message.usage);
					this.checkBudget(ctx).catch(() => {});
				}
				break;
			}
			case "tool_execution_start": {
				ctx.activeTools?.add(event.toolCallId);
				this.broadcast({
					projectId: agent.projectId,
					agentId: agent.id,
					type: "tool.start",
					payload: { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args },
				});
				break;
			}
			case "tool_execution_end": {
				ctx.activeTools?.delete(event.toolCallId);
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
				if (event.aborted) {
					this.finishAgent(agent.id, "aborted");
					break;
				}
				if (ctx.lastStopReason === "error") {
					this.finishAgent(agent.id, "failed", ctx.lastErrorMessage || "模型调用失败");
					break;
				}
				// 输出被 token 上限截断：不能当成"已完成"交给父 agent
				if (ctx.lastStopReason === "length") {
					this.failWithHandoff(agent.id, "模型输出被截断（stopReason=length）");
					break;
				}
				const saved = this.finishAgent(agent.id, "idle");
				if (saved && !saved.tokensIn) this.applyContextUsage(agent.id).catch(() => {});
				this.flushNotices(agent.id).catch(() => {});
				break;
			}
			default:
				break;
		}
	}

	applyUsage(agentId, usage) {
		const agent = this.store.getAgent(agentId);
		if (!agent) return;
		const saved = this.store.saveAgent({
			...agent,
			// 每完成一条 assistant 消息就记一轮，不依赖 provider 是否回传 usage
			turns: agent.turns + 1,
			tokensIn: agent.tokensIn + (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0),
			tokensOut: agent.tokensOut + (usage?.output ?? 0),
			cost: agent.cost + (usage?.cost?.total ?? 0),
		});
		this.broadcast({ projectId: agent.projectId, agentId, type: "agent.updated", payload: { agent: saved } });
	}

	/** 轮次/token 预算：软提醒 → 硬中止 + Handoff Note。预算按"本次运行"计，恢复后重新计算。 */
	async checkBudget(ctx) {
		if (ctx.finished) return;
		const agent = this.store.getAgent(ctx.agent.id);
		if (!agent) return;
		const turns = agent.turns;
		const tokens = agent.tokensIn + agent.tokensOut;
		const usedTurns = Math.max(0, turns - (ctx.budgetBaseTurns ?? 0));
		const usedTokens = Math.max(0, tokens - (ctx.budgetBaseTokens ?? 0));
		const turnPct = LIMITS.maxTurns > 0 ? usedTurns / LIMITS.maxTurns : 0;
		const tokenPct = LIMITS.maxTokens > 0 ? usedTokens / LIMITS.maxTokens : 0;
		const pct = Math.max(turnPct, tokenPct);

		if (pct >= 1) {
			const reason = `预算耗尽（本轮 turns ${usedTurns}/${LIMITS.maxTurns}，tokens ${usedTokens}/${LIMITS.maxTokens}；累计 ${turns} 轮）`;
			this.failWithHandoff(agent.id, reason);
			this.abortWithKill(ctx);
			return;
		}
		if (pct >= LIMITS.budgetSoftRatio && !ctx.budgetWarned && ctx.lastStopReason === "toolUse") {
			ctx.budgetWarned = true;
			const reminder = `【预算提醒】本轮已使用 turns ${usedTurns}/${LIMITS.maxTurns}、tokens ${usedTokens}/${LIMITS.maxTokens}。请立即收尾：输出已确认结论、未完成事项、下一步建议，然后结束本轮。`;
			ctx.client?.send({ type: "steer", message: reminder }).catch(() => {});
		}
	}

	/** 预算/超时/心跳失败时生成结构化交接说明，供父 agent 决定是否重派。 */
	buildHandoff(agent, reason) {
		const facts = this.store.factsByAgent(agent.projectId, agent.id);
		const last = this.clients.get(agent.id)?.lastAssistantText || lastAssistantTextFromEvents(this.store, agent);
		return [
			`交接原因：${reason}`,
			`任务：${agent.objective}`,
			`最后输出：${truncate(last || "（无）", 800)}`,
			facts.length
				? `已写入事实：${facts.map((fact) => `${fact.id}[${fact.kind}]`).join(", ")}`
				: "已写入事实：无",
			"未完成部分：由父 agent 判断是否重派或收尾。",
		].join("\n");
	}

	failWithHandoff(agentId, reason) {
		const agent = this.store.getAgent(agentId);
		if (!agent) return;
		this.finishAgent(agentId, "failed", reason, { handoff: this.buildHandoff(agent, reason) });
	}

	/** usage 缺失时用会话统计里的上下文 token 兜底。 */
	async applyContextUsage(agentId) {
		const ctx = this.clients.get(agentId);
		if (!ctx?.client) return;
		try {
			const stats = (await ctx.client.getStats()).data ?? {};
			const tokens = stats.contextUsage?.tokens ?? stats.tokens?.total ?? stats.tokens?.input ?? 0;
			if (!tokens) return;
			const agent = this.store.getAgent(agentId);
			if (!agent || agent.tokensIn) return;
			const saved = this.store.saveAgent({ ...agent, tokensIn: tokens });
			this.broadcast({ projectId: agent.projectId, agentId, type: "agent.updated", payload: { agent: saved } });
		} catch {
			/* 忽略统计失败 */
		}
	}

	setStatus(agentId, status, error) {
		const agent = this.store.getAgent(agentId);
		if (!agent) return;
		const saved = this.store.saveAgent({ ...agent, status, error: error ?? null });
		this.broadcast({ projectId: agent.projectId, agentId, type: "agent.updated", payload: { agent: saved } });
		return saved;
	}

	/* ------------------------------ 用户对话 ------------------------------ */

	async userMessage(agentId, text) {
		const agent = this.store.getAgent(agentId);
		if (!agent) throw new Error(`agent 不存在: ${agentId}`);
		if (agent.status === "queued") throw new Error("agent 排队中，请稍后再发");
		const ctx = this.clients.get(agentId);
		if (!ctx?.client) throw new Error("agent 进程不在运行");
		return this.sendPrompt(agent, text, false);
	}

	async sendPrompt(agent, text, systemNotice) {
		const ctx = this.clients.get(agent.id);
		if (!ctx?.client) throw new Error("agent 进程不在运行");
		this.appendUserMessage(agent, text, systemNotice);
		const state = (await ctx.client.getState()).data ?? {};
		if (state.isStreaming) {
			await ctx.client.send({ type: "steer", message: text });
			return { delivered: "steer" };
		}
		ctx.client.prompt(text).catch((error) => {
			this.finishAgent(agent.id, "failed", `prompt 失败: ${String(error?.message ?? error)}`);
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

	/** 给刚启动的子 agent 下发任务书。 */
	async startTask(agent) {
		const project = this.store.getProject(agent.projectId);
		const lines = [
			`任务：${agent.objective}`,
			`目标：${(agent.targets ?? []).join(", ") || project?.target || ""}`,
			agent.factIds?.length ? `参考事实：${agent.factIds.join(", ")}` : "",
			"",
			"请开始执行。每有可复用的发现就立即 fact_write；结束前给出结论（确认了什么、排除了什么、下一步建议）。",
		].filter(Boolean);
		await this.sendPrompt(agent, lines.join("\n"), false);
	}

	/* ------------------------------ 中止 ------------------------------ */

	descendantsOf(agentId) {
		const agent = this.store.getAgent(agentId);
		if (!agent) return [agentId];
		const all = this.store.listAgents(agent.projectId);
		const result = [agentId];
		const queue = [agentId];
		while (queue.length) {
			const current = queue.shift();
			for (const candidate of all) {
				if (candidate.parentId === current && !result.includes(candidate.id)) {
					result.push(candidate.id);
					queue.push(candidate.id);
				}
			}
		}
		return result;
	}

	/** 中止一个 agent 及其整棵子树。 */
	async abort(agentId) {
		const ids = this.descendantsOf(agentId);
		for (const id of ids) {
			const ctx = this.clients.get(id);
			if (ctx) ctx.silent = true;
			this.queue = this.queue.filter((queued) => queued !== id);
			if (ctx) this.abortWithKill(ctx);
			else {
				// 排队中的 agent 没有进程，直接标记中止
				const queuedAgent = this.store.getAgent(id);
				if (queuedAgent) this.finishAgent(id, "aborted", "用户中止");
			}
			const agent = this.store.getAgent(id);
			if (agent && !TERMINAL_STATUSES.has(agent.status)) {
				this.finishAgent(id, "aborted", "用户中止");
			}
		}
		return { aborted: ids };
	}

	/** 删除项目前停掉它的所有 agent（后台进程不能留着）。 */
	async stopProject(projectId) {
		const agents = this.store.listAgents(projectId);
		for (const agent of agents) {
			const ctx = this.clients.get(agent.id);
			if (!ctx) continue;
			ctx.silent = true;
			this.clearTimers(ctx);
			ctx.finished = true;
			await ctx.client?.abort().catch(() => {});
			await ctx.client?.stop().catch(() => {});
			this.clients.delete(agent.id);
			this.active.delete(agent.id);
		}
		this.queue = this.queue.filter((id) => !agents.some((agent) => agent.id === id));
		this.pump();
	}

	/**
	 * 服务重启后补投"子 agent 已完成但父 agent 没收到通知"的情况：
	 * 崩溃发生在 finishAgent 已落状态、reportToParent 还没执行完时，父 agent 会永远等不到唤醒。
	 */
	async reconcileAfterBoot() {
		let count = 0;
		for (const project of this.store.listProjects()) {
			for (const agent of this.store.listAgents(project.id)) {
				if (!agent.parentId || agent.reportedAt || agent.turns <= 0) continue;
				// 卡在 interrupted 但 endedAt 已写入：说明崩溃前已经 settle 过（不是跑到一半），也要补投
				const settledInterrupted = agent.status === "interrupted" && Boolean(agent.endedAt);
				const terminal = ["idle", "failed", "error"].includes(agent.status);
				if (!terminal && !settledInterrupted) continue;
				const parent = this.store.getAgent(agent.parentId);
				if (!parent) continue;
				const outcome =
					agent.status === "failed" || agent.status === "error" ? "failed" : "idle";
				try {
					await this.reportToParent(agent, outcome, agent.error);
					count += 1;
				} catch {
					/* 单个失败不影响其它补投 */
				}
			}
		}
		return count;
	}

	/* ------------------------------ 子 agent 汇报 ------------------------------ */

	async reportToParent(child, outcome = "idle", error, handoff) {
		const parent = this.store.getAgent(child.parentId);
		if (!parent) return;
		const facts = this.store.factsByAgent(child.projectId, child.id);
		const summary =
			this.clients.get(child.id)?.lastAssistantText || lastAssistantTextFromEvents(this.store, child) || "";

		const failed = outcome === "failed" || outcome === "error";
		const aborted = outcome === "aborted";
		const statusText = failed ? "失败" : aborted ? "已中止" : "已完成";
		const lines = [
			`[系统通知] 子 agent ${child.id}（${ROLE_LABELS[child.role] ?? child.role}）${statusText}。`,
			`任务：${child.objective}`,
			failed
				? `失败原因：${truncate(error || "未知错误", 500)}`
				: `结论：${truncate(summary || "（没有输出总结）", 1200)}`,
			handoff ? `交接说明：\n${truncate(handoff, 1500)}` : "",
			facts.length
				? `新增事实：\n${facts.map((fact) => `- ${fact.id} [${fact.kind}] ${fact.title}`).join("\n")}`
				: "新增事实：无",
			failed || aborted
				? "请判断是否重派或改用其他测试方向；如果无法继续，请给出当前结论。"
				: "请用 fact_query 查看完整事实，再决定下一步；如果没有更多要验证的，请给出最终结论。",
		].filter(Boolean);

		const fresh = this.store.getAgent(child.id);
		if (fresh) this.store.saveAgent({ ...fresh, reportedAt: Date.now() });
		await this.queueNotice(parent.id, lines.join("\n"));
	}

	/** 通知排队：父 agent 空闲时防抖合并，忙碌时等它 settle 再发。 */
	async queueNotice(parentId, notice) {
		const pending = this.pendingNotices.get(parentId) ?? [];
		pending.push(notice);
		this.pendingNotices.set(parentId, pending);

		const parent = this.store.getAgent(parentId);
		const ctx = this.clients.get(parentId);
		if (!parent || !ctx?.client) return;

		const state = (await ctx.client.getState()).data ?? {};
		const timers = this.noticeTimers.get(parentId) ?? {};
		if (state.isStreaming) {
			// 父 agent 在跑，等它结束；同时设一个兜底计时，避免它一直不结束导致通知永远不投递
			if (!timers.maxWait) {
				timers.maxWait = setTimeout(() => this.flushNotices(parentId).catch(() => {}), LIMITS.wakeMaxWaitMs);
				this.noticeTimers.set(parentId, timers);
			}
			return;
		}
		if (!timers.debounce) {
			timers.debounce = setTimeout(() => this.flushNotices(parentId).catch(() => {}), LIMITS.wakeDebounceMs);
			this.noticeTimers.set(parentId, timers);
		}
	}

	/** 把积压的通知合并成一条系统消息投递给父 agent。 */
	async flushNotices(parentId) {
		const notices = this.pendingNotices.get(parentId);
		if (!notices || notices.length === 0) return;
		this.pendingNotices.delete(parentId);
		const timers = this.noticeTimers.get(parentId);
		if (timers) {
			clearTimeout(timers.debounce);
			clearTimeout(timers.maxWait);
			this.noticeTimers.delete(parentId);
		}

		const parent = this.store.getAgent(parentId);
		const ctx = this.clients.get(parentId);
		if (!parent || !ctx?.client) return;

		const text = notices.join("\n\n────────\n\n");
		await this.sendPrompt(parent, text, true);
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
			ctx.silent = true;
			this.clearTimers(ctx);
			await ctx.client?.stop().catch(() => {});
		}
		this.clients.clear();
		this.active.clear();
		this.queue = [];
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
		.map((block) => (block?.type === "text" ? block.text ?? "" : ""))
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
