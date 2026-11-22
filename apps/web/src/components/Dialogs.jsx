import { useState } from "react";
import { api } from "../api.js";
import { Modal } from "./Modal.jsx";

const KIND_LABELS = {
	asset: "资产",
	endpoint: "接口",
	tech: "技术栈",
	credential: "凭据",
	behavior: "行为",
	finding: "发现",
	negative: "已排除",
};

export function FactsDialog({ facts, onClose }) {
	return (
		<Modal wide onClose={onClose}>
			<div className="modal-head">
				<h3>项目事实库 · {facts.length} 条</h3>
				<button className="ghost" onClick={onClose}>
					✕
				</button>
			</div>
			<div className="modal-body">
				{facts.length === 0 ? <div className="muted">还没有事实。子 agent 执行 fact_write 后会出现在这里。</div> : null}
				<div className="fact-list">
					{facts.map((fact) => (
						<div className="fact-row" key={fact.id}>
							<div className="fact-head">
								<span className="fact-id">{fact.id}</span>
								<span className={`fact-kind ${fact.kind}`}>{KIND_LABELS[fact.kind] ?? fact.kind}</span>
								<span className="fact-source">{fact.sourceAgent ?? ""}</span>
							</div>
							<div className="fact-title">{fact.title}</div>
							<details>
								<summary>详情</summary>
								<pre>{JSON.stringify(fact.value, null, 2)}</pre>
							</details>
						</div>
					))}
				</div>
			</div>
		</Modal>
	);
}

export function NewProjectDialog({ onClose, onCreated, configured }) {
	const [name, setName] = useState("本地靶场演示");
	const [target, setTarget] = useState("http://127.0.0.1:8099");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");

	async function create() {
		setSaving(true);
		setError("");
		try {
			const data = await api.post("/api/projects", { name, target });
			onCreated(data.project);
			onClose();
		} catch (err) {
			setError(String(err?.message ?? err));
		} finally {
			setSaving(false);
		}
	}

	return (
		<Modal onClose={onClose}>
			<div className="modal-head">
				<h3>新建项目</h3>
				<button className="ghost" onClick={onClose}>
					✕
				</button>
			</div>
			<div className="modal-body">
				{!configured ? <div className="error-text">请先配置模型，再新建项目。</div> : null}
				<div className="field">
					<label>项目名</label>
					<input value={name} onChange={(event) => setName(event.target.value)} />
				</div>
				<div className="field">
					<label>目标地址</label>
					<input value={target} onChange={(event) => setTarget(event.target.value)} />
					<div className="desc">新建后会自动启动一个指挥官 agent，并派发侦察任务</div>
				</div>
				{error ? <div className="error-text">{error}</div> : null}
			</div>
			<div className="modal-foot">
				<button onClick={onClose}>取消</button>
				<button className="primary" onClick={create} disabled={saving || !configured}>
					{saving ? "创建中…" : "创建"}
				</button>
			</div>
		</Modal>
	);
}
