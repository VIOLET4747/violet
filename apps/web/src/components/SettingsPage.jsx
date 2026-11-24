import { useEffect, useState } from "react";
import { ModelForm } from "./ModelForm.jsx";
import { applyTheme, getTheme } from "../theme.js";

const NAV_ITEMS = [
	{ id: "model", label: "模型", icon: "◈" },
	{ id: "system", label: "系统设置", icon: "◐" },
];

const THEME_OPTIONS = [
	{ id: "dark", label: "深色" },
	{ id: "light", label: "浅色" },
];

export function SettingsPage({ config, onClose, onSaved }) {
	const [tab, setTab] = useState("model");
	const [theme, setTheme] = useState(getTheme);

	useEffect(() => {
		const onKey = (event) => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	const current = NAV_ITEMS.find((item) => item.id === tab) ?? NAV_ITEMS[0];

	return (
		<div className="settings-page">
			<aside className="settings-side">
				<div className="settings-side-title">设置</div>
				<nav className="settings-nav">
					{NAV_ITEMS.map((item) => (
						<button
							key={item.id}
							className={`settings-nav-item ${tab === item.id ? "active" : ""}`}
							onClick={() => setTab(item.id)}
						>
							<span className="settings-nav-icon">{item.icon}</span>
							{item.label}
						</button>
					))}
				</nav>
			</aside>

			<section className="settings-main">
				<header className="settings-head">
					<h2>{current.label}</h2>
					<button className="icon" onClick={onClose} title="关闭设置">
						✕
					</button>
				</header>

				<div className="settings-body">
					{tab === "model" ? (
						<>
							<div className="settings-card">
								<div className="settings-card-title">当前生效</div>
								<div className="settings-active">
									<span className={`dot ${config?.configured ? "live" : "idle"}`} />
									{config?.configured ? (
										<>
											<span className="settings-active-name">
												{config.active.provider} / {config.active.model}
											</span>
											{config.custom?.baseUrl ? (
												<span className="settings-active-url">{config.custom.baseUrl}</span>
											) : null}
										</>
									) : (
										<span className="settings-active-name">尚未配置模型</span>
									)}
								</div>
							</div>

							<div className="settings-card">
								<div className="settings-card-title">模型配置</div>
								<div className="settings-card-sub">
									支持 OpenAI / Anthropic 兼容接口。修改只影响之后派发的 agent，正在运行的 agent 保持原模型。
								</div>
								<ModelForm config={config} submitLabel="保存配置" onSaved={onSaved} />
							</div>

							<div className="settings-hint">
								配置文件：<code>.runtime/config.json</code> · 密钥：<code>.runtime/secrets.json</code>
								（不会提交到 git）
							</div>
						</>
					) : (
						<>
							<div className="settings-card">
								<div className="settings-card-title">外观</div>
								<div className="settings-card-sub">
									选择界面配色，立即生效。偏好保存在浏览器 localStorage，不影响服务端。
								</div>
								<div className="theme-options">
									{THEME_OPTIONS.map((option) => (
										<button
											key={option.id}
											className={`theme-option ${theme === option.id ? "active" : ""}`}
											onClick={() => setTheme(applyTheme(option.id))}
										>
											<span className={`theme-preview ${option.id}`} />
											<span>{option.label}</span>
										</button>
									))}
								</div>
							</div>
						</>
					)}
				</div>
			</section>
		</div>
	);
}
