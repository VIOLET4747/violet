import { useEffect, useState } from "react";
import { api } from "../api.js";

export function ReportDialog({ projectId, onClose }) {
	const [summary, setSummary] = useState(null);
	const [error, setError] = useState("");

	useEffect(() => {
		if (!projectId) return;
		api
			.get(`/api/projects/${projectId}/report`)
			.then((data) => setSummary(data))
			.catch((err) => setError(String(err?.message ?? err)));
	}, [projectId]);

	const candidates = summary?.downloads;
	const htmlUrl = candidates?.html;

	return (
		<div className="modal-mask" onClick={onClose}>
			<div className="modal report-modal" onClick={(event) => event.stopPropagation()}>
				<div className="modal-head">
					<h3>
						报告
						{summary ? (
							<span className="tools-hint">
								{summary.summary.findings} 条 finding · {Object.entries(summary.summary.severity ?? {})
									.map(([key, value]) => `${key} ${value}`)
									.join(" / ")}
							</span>
						) : null}
					</h3>
					<div className="tools-head-actions">
						{candidates ? (
							<>
								<a className="ghost" href={candidates.markdown} download>
									MD
								</a>
								<a className="ghost" href={candidates.html} target="_blank" rel="noreferrer">
									HTML
								</a>
								<a className="ghost" href={candidates.pdf} download>
									PDF
								</a>
								{candidates.sarif ? (
									<a className="ghost" href={candidates.sarif} download>
										SARIF
									</a>
								) : null}
								<a className="ghost" href={candidates.pocZip} download>
									PoC ZIP
								</a>
								<a className="ghost" href={candidates.evidenceZip} download>
									证据 ZIP
								</a>
							</>
						) : null}
						<button className="ghost" onClick={onClose}>
							✕
						</button>
					</div>
				</div>
				{htmlUrl ? (
					<iframe className="report-preview" title="报告预览" src={htmlUrl} />
				) : (
					<div className="center-note">
						<div className="note-sub">{error || "生成中…"}</div>
					</div>
				)}
			</div>
		</div>
	);
}
