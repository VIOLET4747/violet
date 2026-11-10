import { useState } from "react";
import { api } from "../api.js";
import { ModelForm } from "./ModelForm.jsx";

export function SettingsDialog({ config, onClose, onSaved }) {
	return (
		<div className="modal-mask" onClick={onClose}>
			<div className="modal" onClick={(event) => event.stopPropagation()}>
				<div className="modal-head">
					<h3>模型设置</h3>
					<button className="ghost" onClick={onClose}>
						✕
					</button>
				</div>
				<div className="modal-body">
					<div className="field">
						<label>当前生效</label>
						<div className="desc">
							{config?.configured ? `${config.active.provider} / ${config.active.model}` : "尚未配置"}
						</div>
						<div className="desc">修改只影响之后新派发的 agent，正在运行的 agent 保持原模型。</div>
					</div>
					<ModelForm
						config={config}
						submitLabel="保存"
						onSaved={(next) => {
							onSaved(next);
							onClose();
						}}
					/>
				</div>
			</div>
		</div>
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
		<div className="modal-mask" onClick={onClose}>
			<div className="modal" onClick={(event) => event.stopPropagation()}>
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
			</div>
		</div>
	);
}
