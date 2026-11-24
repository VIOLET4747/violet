/**
 * M7：工具审批队列 + 审计日志
 *
 * - shell（powershell/bash）与高风险 run_tool 在 tool_call hook 处阻塞，等待人工/策略决定
 * - 超时 fail-closed（默认过期 = 拒绝），并写审计
 * - 审计日志 append-only：.runtime/audit.log（JSONL）
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS, RUNTIME } from "./config.mjs";

const AUDIT_LOG = join(RUNTIME, "audit.log");

export class ApprovalBroker {
	constructor({ store, broadcast, toolRegistry }) {
		this.store = store;
		this.broadcast = broadcast;
		this.toolRegistry = toolRegistry;
		this.pending = new Map();
		mkdirSync(RUNTIME, { recursive: true });
	}

	audit(action, data = {}) {
		try {
			appendFileSync(AUDIT_LOG, `${JSON.stringify({ ts: Date.now(), action, ...data })}\n`, "utf8");
		} catch {
			/* 审计失败不影响主流程 */
		}
	}

	/** 判断一次 tool_call 是否需要审批 */
	classify(tool, args = {}) {
		if (LIMITS.approvalMode === "off") return { approval: false, risk: "passive" };
		if (LIMITS.approvalMode === "all") return { approval: true, risk: "medium", reason: "approval mode = all" };
		if (tool === "powershell" || tool === "bash") {
			return { approval: true, risk: "high", reason: `${tool} 会在本机执行命令` };
		}
		if (tool === "run_tool") {
			const def = this.toolRegistry?.get?.(args.tool);
			const risk = def?.risk ?? "active";
			if (risk === "passive") return { approval: false, risk };
			return { approval: true, risk, reason: `工具 ${args.tool ?? "?"} 风险等级 ${risk}` };
		}
		return { approval: false, risk: "passive" };
	}

	async request({ projectId, agentId, role, tool, args = {} }) {
		const verdict = this.classify(tool, args);
		if (!verdict.approval) return { status: "approved", auto: true, risk: verdict.risk };

		const approval = this.store.addApproval({
			projectId,
			agentId,
			tool,
			args,
			risk: verdict.risk,
			reason: verdict.reason,
		});
		this.audit("approval.requested", { approvalId: approval.id, projectId, agentId, role, tool, risk: verdict.risk, args });
		this.broadcast?.({ projectId, agentId, type: "approval.created", payload: { approval } });

		const decision = await new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(approval.id);
				const expired = this.store.decideApproval({ id: approval.id, status: "expired", decidedBy: "timeout" });
				this.audit("approval.expired", { approvalId: approval.id, projectId, agentId, tool });
				this.broadcast?.({ projectId, agentId, type: "approval.updated", payload: { approval: expired } });
				resolve({ status: "expired", approvalId: approval.id, reason: "审批超时（fail-closed）" });
			}, LIMITS.approvalTimeoutMs);
			this.pending.set(approval.id, {
				resolve: (result) => {
					clearTimeout(timer);
					resolve(result);
				},
			});
		});
		return decision;
	}

	decide(id, status, decidedBy = "ui", reason = "") {
		if (!["approved", "denied"].includes(status)) throw new Error("decision 必须是 approved 或 denied");
		const approval = this.store.getApproval(id);
		if (!approval) throw new Error(`审批不存在: ${id}`);
		if (approval.status !== "pending") throw new Error(`审批状态 ${approval.status} 不能再决策`);
		const updated = this.store.decideApproval({ id, status, decidedBy });
		this.audit(`approval.${status}`, {
			approvalId: id,
			projectId: approval.projectId,
			agentId: approval.agentId,
			tool: approval.tool,
			decidedBy,
			reason,
		});
		const pending = this.pending.get(id);
		this.pending.delete(id);
		pending?.resolve({ status, approvalId: id, reason: reason || `人工${status === "approved" ? "通过" : "拒绝"}` });
		this.broadcast?.({
			projectId: approval.projectId,
			agentId: approval.agentId,
			type: "approval.updated",
			payload: { approval: updated },
		});
		return updated;
	}

	list(projectId) {
		return this.store.listApprovals(projectId);
	}

	/** 项目删除/停止时：挂起的审批一律按拒绝处理，避免 pi 子进程永久等待 */
	cancelProject(projectId) {
		for (const [id, pending] of [...this.pending.entries()]) {
			const approval = this.store.getApproval(id);
			if (!approval || approval.projectId !== projectId) continue;
			this.pending.delete(id);
			this.store.decideApproval({ id, status: "expired", decidedBy: "project-stopped" });
			this.audit("approval.expired", { approvalId: id, projectId, agentId: approval.agentId, tool: approval.tool, reason: "project stopped" });
			pending.resolve({ status: "expired", approvalId: id, reason: "项目已停止" });
		}
	}

	readAudit(limit = 200) {
		if (!existsSync(AUDIT_LOG)) return [];
		const lines = readFileSync(AUDIT_LOG, "utf8").split("\n").filter(Boolean);
		return lines
			.slice(-limit)
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	}
}
