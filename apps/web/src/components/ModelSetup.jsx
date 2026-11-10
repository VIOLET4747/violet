import { ModelForm } from "./ModelForm.jsx";

/**
 * 首次启动 / 未配置模型时的引导页。
 * 没有模型就没有 agent，所以这里必须先把 provider 填清楚。
 */
export function ModelSetup({ config, onSaved }) {
	return (
		<div className="setup-page">
			<div className="setup-card">
				<div className="setup-brand">
					<span className="dot" />
					Pi-Pentest
				</div>
				<h1>先配置一个模型</h1>
				<p className="setup-desc">
					平台不内置任何模型。填入任意兼容 OpenAI / Anthropic 协议的 API 即可开始；
					推荐用推理型模型（如 <code>deepseek-reasoner</code>），这样 agent 的「推理过程」才有内容。
				</p>
				<ModelForm config={config} submitLabel="保存并进入平台" onSaved={onSaved} />
				<div className="setup-note">
					Key 只保存在本机 <code>.runtime/secrets.json</code>，不会写入模型配置，也不会提交到 git。
					<br />
					保存后页面会自动进入平台，然后点「新建项目」开始。
				</div>
			</div>
		</div>
	);
}
