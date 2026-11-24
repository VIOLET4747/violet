import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";

const STATUS_LABELS = {
	candidate: "候选",
	verifying: "验证中",
	verified: "已验证",
	disputed: "有争议",
	false_positive: "误报",
	fixed: "已修复",
};

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function FindingsDialog({ projectId, onClose }) {
	const [tab, setTab] = useState("findings");
	const [findings, setFindings] = useState([]);
	const [coverage, setCoverage] = useState([]);
	const [selectedId, setSelectedId] = useState(null);
	const [detail, setDetail] = useState(null);
	const [error, setError] = useState("");

	useEffect(() => {
		if (!projectId) return;
		Promise.all([
			api.get(`/api/projects/${projectId}/findings`),
			api.get(`/api/projects/${projectId}/coverage`),
		])
			.then(([findingData, coverageData]) => {
				setFindings(findingData.findings);
				setCoverage(coverageData.coverage);
				setSelectedId(findingData.findings[0]?.id ?? null);
			})
			.catch((err) => setError(String(err?.message ?? err)));
	}, [projectId]);

	useEffect(() => {
		if (!selectedId) {
			setDetail(null);
			return;
		}
		api
			.get(`/api/findings/${selectedId}`)
			.then(setDetail)
			.catch((err) => setError(String(err?.message ?? err)));
	}, [selectedId]);

	const sorted = useMemo(
		() => [...findings].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)),
		[findings],
	);

	async function copyCurl(text) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			setError("复制失败（浏览器不允许剪贴板）");
		}
	}

	return (
		<div className="modal-mask" onClick={onClose}>
			<div className="modal wide findings-modal" onClick={(event) => event.stopPropagation()}>
				<div className="modal-head">
					<h3>证据链 · {findings.length}</h3>
					<div className="tools-head-actions">
						<button className={`ghost ${tab === "findings" ? "active" : ""}`} onClick={() => setTab("findings")}>
							漏洞
						</button>
						<button className={`ghost ${tab === "coverage" ? "active" : ""}`} onClick={() => setTab("coverage")}>
							覆盖率
						</button>
						<button className="ghost" onClick={onClose}>
							✕
						</button>
					</div>
				</div>

				{tab === "findings" ? (
					<div className="tools-body">
						<aside className="tools-list findings-list">
							{sorted.length === 0 ? <div className="tools-hint" style={{ padding: 8 }}>还没有 finding</div> : null}
							{sorted.map((finding) => (
								<button
									key={finding.id}
									className={`finding-item ${selectedId === finding.id ? "active" : ""}`}
									onClick={() => setSelectedId(finding.id)}
								>
									<span className={`severity ${finding.severity}`}>{finding.severity}</span>
									<span className="finding-title">{finding.title}</span>
									<span className={`finding-status ${finding.status}`}>{STATUS_LABELS[finding.status] ?? finding.status}</span>
								</button>
							))}
						</aside>

						<section className="tools-main">
							{detail ? (
								<>
									<div className="finding-head">
										<h4>{detail.finding.title}</h4>
										<div className="finding-meta">
											<span className={`severity ${detail.finding.severity}`}>{detail.finding.severity}</span>
											<span>{detail.finding.category}</span>
											<span>{detail.finding.target}</span>
											<span className={`finding-status ${detail.finding.status}`}>
												{STATUS_LABELS[detail.finding.status] ?? detail.finding.status}
											</span>
											<span>confidence: {detail.finding.confidence}</span>
										</div>
									</div>
									<div className="finding-section">
										<div className="tools-label">摘要</div>
										<p className="finding-text">{detail.finding.summary}</p>
									</div>
									<div className="finding-section">
										<div className="tools-label">技术分析</div>
										<p className="finding-text">{detail.finding.technicalAnalysis}</p>
									</div>
									<div className="finding-section">
										<div className="tools-label">影响</div>
										<p className="finding-text">{detail.finding.impact}</p>
									</div>
									<div className="finding-section">
										<div className="tools-label">为什么不是误报</div>
										<p className="finding-text">{detail.finding.counterevidence}</p>
									</div>
									<div className="finding-section">
										<div className="tools-label">PoC 步骤</div>
										<ol className="finding-steps">
											{detail.finding.poc?.steps?.map((step, index) => (
												<li key={index}>{step}</li>
											))}
										</ol>
										<div className="tools-hint">
											expect：{detail.finding.poc?.expect?.match} = {detail.finding.poc?.expect?.value}
										</div>
									</div>
									<div className="finding-section">
										<div className="tools-label">
											证据（{detail.evidence.length}）
											{detail.finding.verifiedBy ? <span className="tools-hint">verified_by {detail.finding.verifiedBy}</span> : null}
										</div>
										{detail.evidence.map((item) => (
											<div key={item.artifact.id} className="evidence-card">
												<div className="evidence-head">
													<span className="tools-id">
														{item.artifact.id} · {item.role} · {item.artifact.bytes} bytes
													</span>
													{item.curl ? (
														<button className="ghost" onClick={() => copyCurl(item.curl)}>
															复制 curl
														</button>
													) : null}
												</div>
												{item.exchange ? (
													<div className="evidence-panes">
														<div>
															<div className="tools-label">
																Request · {item.exchange.method} {item.exchange.url}
															</div>
															<pre className="tools-output evidence-pane">
																{`${item.exchange.method} ${item.exchange.url}\n${JSON.stringify(item.exchange.requestHeaders, null, 1)}\n\n${item.exchange.requestBody ?? ""}`}
															</pre>
														</div>
														<div>
															<div className="tools-label">Response · {item.exchange.status ?? "ERROR"}</div>
															<pre className="tools-output evidence-pane">
																{`status: ${item.exchange.status ?? "ERROR"}\n${JSON.stringify(item.exchange.responseHeaders, null, 1)}\n\n${item.exchange.responseBody ?? ""}`}
															</pre>
														</div>
													</div>
												) : (
													<div className="tools-hint">非 HTTP 证据：{item.artifact.path}</div>
												)}
											</div>
										))}
									</div>
								</>
							) : (
								<div className="center-note">
									<div className="note-sub">{findings.length ? "选择左侧 finding 查看详情" : "还没有 finding"}</div>
								</div>
							)}
						</section>
					</div>
				) : (
					<div className="coverage-table">
						{coverage.length === 0 ? (
							<div className="tools-hint">账本为空：agent 还没记录覆盖率</div>
						) : (
							<table>
								<thead>
									<tr>
										<th>测试类</th>
										<th>结果</th>
										<th>控制点 / 说明</th>
									</tr>
								</thead>
								<tbody>
									{coverage.map((item) => (
										<tr key={item.id}>
											<td>{item.testClass}</td>
											<td>
												<span className={`finding-status ${item.outcome}`}>{item.outcome}</span>
											</td>
											<td>
												{item.controlPoint ? <code>{item.controlPoint}</code> : null} {item.rationale}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
					</div>
				)}

				{error ? <div className="error-text" style={{ padding: "0 14px 10px" }}>{error}</div> : null}
			</div>
		</div>
	);
}
