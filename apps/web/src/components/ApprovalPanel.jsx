import { useState } from "react";
import { api } from "../api.js";

const RISK_LABEL = { high: "高危", medium: "中危", active: "主动", intrusive: "侵入", passive: "被动" };

export function ApprovalPanel({ approvals, onDecided }) {
	const [busy, setBusy] = useState({});
	const [error, setError] = useState("");

	if (!approvals.length) return null;

	async function decide(id, status) {
		setBusy((prev) => ({ ...prev, [id]: true }));
		setError("");
		try {
			await api.post(`/api/approvals/${id}/decide`, { status });
			onDecided?.(id, status);
		} catch (err) {
			setError(String(err?.message ?? err));
		} finally {
			setBusy((prev) => ({ ...prev, [id]: false }));
		}
	}

	return (
		<div className="approval-stack">
			{approvals.map((approval) => (
				<div key={approval.id} className="approval-card">
					<div className="approval-head">
						<span className={`severity ${approval.risk === "high" || approval.risk === "intrusive" ? "critical" : "high"}`}>
							{RISK_LABEL[approval.risk] ?? approval.risk}
						</span>
						<span>需要审批：{approval.tool}</span>
					</div>
					<div className="approval-meta">
						{approval.agentId ?? "?"} · {approval.reason ?? ""}
					</div>
					<pre className="approval-args">{JSON.stringify(approval.args ?? {}, null, 2).slice(0, 1200)}</pre>
					<div className="approval-actions">
						<button className="primary" disabled={busy[approval.id]} onClick={() => decide(approval.id, "approved")}>
							批准
						</button>
						<button className="danger-ghost" disabled={busy[approval.id]} onClick={() => decide(approval.id, "denied")}>
							拒绝
						</button>
					</div>
				</div>
			))}
			{error ? <div className="error-text">{error}</div> : null}
		</div>
	);
}
