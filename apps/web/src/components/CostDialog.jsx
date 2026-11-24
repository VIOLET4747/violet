import { useEffect, useState } from "react";
import { api } from "../api.js";

function fmtTokens(n) {
	if (!n) return "0";
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtCost(n) {
	if (!n) return "$0";
	return `$${n.toFixed(4)}`;
}

export function CostDialog({ projectId, onClose }) {
	const [data, setData] = useState(null);
	const [error, setError] = useState("");

	useEffect(() => {
		if (!projectId) return;
		api
			.get(`/api/usage?projectId=${projectId}`)
			.then(setData)
			.catch((err) => setError(String(err?.message ?? err)));
	}, [projectId]);

	const total = data?.usage?.total;
	const tokenLimit = data?.limits?.projectTokenLimit ?? 0;
	const costLimit = data?.limits?.projectCostLimit ?? 0;
	const tokens = (total?.tokensIn ?? 0) + (total?.tokensOut ?? 0);
	const tokenPct = tokenLimit > 0 ? Math.min(100, (tokens / tokenLimit) * 100) : 0;
	const costPct = costLimit > 0 ? Math.min(100, ((total?.cost ?? 0) / costLimit) * 100) : 0;

	return (
		<div className="modal-mask" onClick={onClose}>
			<div className="modal wide cost-modal" onClick={(event) => event.stopPropagation()}>
				<div className="modal-head">
					<h3>成本与用量</h3>
					<button className="ghost" onClick={onClose}>✕</button>
				</div>
				<div className="cost-body">
					{error ? <div className="error-text">{error}</div> : null}
					{data ? (
						<>
							<div className="cost-cards">
								<div className="cost-card">
									<span className="cost-label">项目 tokens</span>
									<span className="cost-value">{fmtTokens(tokens)}</span>
									<span className="cost-sub">in {fmtTokens(total.tokensIn)} · out {fmtTokens(total.tokensOut)}</span>
								</div>
								<div className="cost-card">
									<span className="cost-label">成本</span>
									<span className="cost-value">{fmtCost(total.cost)}</span>
									<span className="cost-sub">{total.turns} 轮 · {total.agents} 个 agent</span>
								</div>
								{tokenLimit > 0 ? (
									<div className="cost-card">
										<span className="cost-label">token 配额</span>
										<div className="cost-bar"><span className={tokenPct >= 80 ? "warn" : ""} style={{ width: `${tokenPct}%` }} /></div>
										<span className="cost-sub">{fmtTokens(tokens)} / {fmtTokens(tokenLimit)}</span>
									</div>
								) : null}
								{costLimit > 0 ? (
									<div className="cost-card">
										<span className="cost-label">成本配额</span>
										<div className="cost-bar"><span className={costPct >= 80 ? "warn" : ""} style={{ width: `${costPct}%` }} /></div>
										<span className="cost-sub">{fmtCost(total.cost)} / {fmtCost(costLimit)}</span>
									</div>
								) : null}
							</div>

							<div className="settings-card">
								<div className="settings-card-title">按角色</div>
								<table className="cost-table">
									<thead>
										<tr><th>角色</th><th>agents</th><th>tokens in/out</th><th>成本</th></tr>
									</thead>
									<tbody>
										{(data.usage.byRole ?? []).map((row) => (
											<tr key={row.role}>
												<td>{row.role}</td>
												<td>{row.agents}</td>
												<td>{fmtTokens(row.tokensIn)} / {fmtTokens(row.tokensOut)}</td>
												<td>{fmtCost(row.cost)}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>

							<div className="settings-card">
								<div className="settings-card-title">按 agent</div>
								<table className="cost-table">
									<thead>
										<tr><th>agent</th><th>角色</th><th>状态</th><th>turns</th><th>tokens in/out</th><th>成本</th></tr>
									</thead>
									<tbody>
										{(data.usage.byAgent ?? []).map((row) => (
											<tr key={row.id}>
												<td>{row.id}</td>
												<td>{row.role}</td>
												<td>{row.status}</td>
												<td>{row.turns}</td>
												<td>{fmtTokens(row.tokensIn)} / {fmtTokens(row.tokensOut)}</td>
												<td>{fmtCost(row.cost)}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</>
					) : (
						<div className="center-note"><div className="note-sub">加载中…</div></div>
					)}
				</div>
			</div>
		</div>
	);
}
