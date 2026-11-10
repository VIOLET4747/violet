import { useState } from "react";
import { api } from "../api.js";

export const API_TYPES = [
	["openai-completions", "OpenAI Chat Completions（DeepSeek / Ollama / vLLM / 网关）"],
	["openai-responses", "OpenAI Responses API"],
	["anthropic-messages", "Anthropic Messages"],
	["google-generative-ai", "Google Generative AI"],
];

export const PRESETS = [
	{
		label: "DeepSeek",
		baseUrl: "https://api.deepseek.com/v1",
		api: "openai-completions",
		models: "deepseek-chat / deepseek-reasoner",
		defaultModel: "deepseek-chat",
	},
	{
		label: "OpenRouter",
		baseUrl: "https://openrouter.ai/api/v1",
		api: "openai-completions",
		models: "任意 OpenRouter 模型 ID",
		defaultModel: "anthropic/claude-sonnet-4",
	},
	{
		label: "Ollama（本地）",
		baseUrl: "http://127.0.0.1:11434/v1",
		api: "openai-completions",
		models: "本地已 pull 的模型名",
		defaultModel: "qwen2.5-coder:7b",
	},
];

export function ModelForm({ config, onSaved, submitLabel = "保存" }) {
	const custom = config?.custom;
	const [form, setForm] = useState({
		name: custom?.name ?? "自定义模型",
		baseUrl: custom?.baseUrl ?? "https://api.deepseek.com/v1",
		api: custom?.api ?? "openai-completions",
		modelId: custom?.modelId ?? "deepseek-chat",
		apiKey: "",
	});
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");

	function applyPreset(preset) {
		setForm((prev) => ({
			...prev,
			name: preset.label,
			baseUrl: preset.baseUrl,
			api: preset.api,
			modelId: preset.defaultModel,
		}));
	}

	async function save() {
		setSaving(true);
		setError("");
		try {
			if (!form.baseUrl.trim()) throw new Error("Base URL 必填");
			if (!form.modelId.trim()) throw new Error("模型 ID 必填");
			const next = await api.put("/api/config", { ...form });
			onSaved(next);
		} catch (err) {
			setError(String(err?.message ?? err));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="model-form">
			<div className="preset-row">
				{PRESETS.map((preset) => (
					<button key={preset.label} className="ghost" onClick={() => applyPreset(preset)}>
						{preset.label}
					</button>
				))}
			</div>

			<div className="field">
				<label>显示名</label>
				<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
			</div>
			<div className="field">
				<label>Base URL</label>
				<input
					value={form.baseUrl}
					onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
					placeholder="https://api.deepseek.com/v1"
				/>
			</div>
			<div className="field">
				<label>API 类型</label>
				<select value={form.api} onChange={(event) => setForm({ ...form, api: event.target.value })}>
					{API_TYPES.map(([value, label]) => (
						<option key={value} value={value}>
							{label}
						</option>
					))}
				</select>
			</div>
			<div className="field">
				<label>模型 ID</label>
				<input
					value={form.modelId}
					onChange={(event) => setForm({ ...form, modelId: event.target.value })}
					placeholder="deepseek-chat / deepseek-reasoner"
				/>
				<div className="desc">
					推理型模型（如 deepseek-reasoner、o 系列）会真实输出思考过程，界面里的「推理过程」才有内容
				</div>
			</div>
			<div className="field">
				<label>API Key</label>
				<input
					type="password"
					value={form.apiKey}
					onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
					placeholder={custom?.hasKey ? "已保存，留空表示不修改" : "sk-..."}
				/>
				<div className="desc">保存在 .runtime/secrets.json，不会写进模型配置，也不会进 git</div>
			</div>

			{error ? <div className="error-text">{error}</div> : null}

			<div className="modal-foot" style={{ padding: "4px 0 0" }}>
				<button className="primary" onClick={save} disabled={saving}>
					{saving ? "保存中…" : submitLabel}
				</button>
			</div>
		</div>
	);
}
