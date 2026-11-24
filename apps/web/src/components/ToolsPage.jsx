import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { Modal } from "./Modal.jsx";

const TYPE_OPTIONS = [
	{ id: "website", label: "网站" },
	{ id: "cmd", label: "命令行" },
	{ id: "gui", label: "图形界面" },
	{ id: "mcp", label: "MCP" },
];

const TYPE_LABEL = { website: "网站", cmd: "CMD", gui: "GUI", mcp: "MCP" };

const ICON_PRESETS = [
	"🧰",
	"🔧",
	"🛠️",
	"🎯",
	"🌐",
	"📡",
	"☢️",
	"🔍",
	"🕵️",
	"🤖",
	"💻",
	"🖥️",
	"🛰️",
	"📶",
	"🧪",
	"🔐",
	"📝",
	"📦",
	"⚙️",
	"🚀",
];

function slugify(name) {
	const ascii = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	return ascii || `tool-${Date.now().toString(36)}`;
}

function emptyForm(category) {
	return {
		id: "",
		name: "",
		type: "cmd",
		category: category && category !== "全部应用" ? category : "综合工具",
		description: "",
		icon: "",
		version: "",
		runtime: "",
		homepage: "",
		workdir: "",
		executable: "",
		argsText: "",
		url: "",
		mcpTransport: "stdio",
		mcpCommand: "",
		mcpArgsText: "",
		mcpUrl: "",
		mcpEnvText: "",
		paramsText: "[]",
	};
}

function formFromTool(tool) {
	const cmdArgs = tool.argv?.length ? tool.argv.slice(1) : tool.args ?? [];
	return {
		...emptyForm(tool.category),
		id: tool.id,
		name: tool.name,
		type: tool.type,
		category: tool.category ?? "综合工具",
		description: tool.description ?? "",
		icon: tool.icon ?? "",
		version: tool.version ?? "",
		runtime: tool.runtime ?? "",
		homepage: tool.homepage ?? "",
		workdir: tool.workdir ?? "",
		executable: tool.executable ?? tool.argv?.[0] ?? "",
		argsText: cmdArgs.join("\n"),
		url: tool.url ?? "",
		mcpTransport: tool.mcp?.transport ?? "stdio",
		mcpCommand: tool.mcp?.command ?? "",
		mcpArgsText: (tool.mcp?.args ?? []).join("\n"),
		mcpUrl: tool.mcp?.url ?? "",
		mcpEnvText: Object.entries(tool.mcp?.env ?? {})
			.map(([key, value]) => `${key}=${value}`)
			.join("\n"),
		paramsText: JSON.stringify(tool.params ?? [], null, 2),
	};
}

function toolFromForm(form) {
	const tool = {
		id: form.id || slugify(form.name),
		name: form.name.trim(),
		type: form.type,
		category: form.category.trim() || "综合工具",
		description: form.description.trim(),
		icon: form.icon.trim(),
		version: form.version.trim(),
		runtime: form.runtime.trim(),
		homepage: form.homepage.trim(),
		workdir: form.workdir.trim(),
	};
	if (form.type === "website") tool.url = form.url.trim();
	if (form.type === "mcp") {
		let env = {};
		try {
			for (const line of form.mcpEnvText.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;
				const index = trimmed.indexOf("=");
				if (index > 0) env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1);
			}
		} catch {
			env = {};
		}
		tool.mcp = {
			transport: form.mcpTransport,
			command: form.mcpCommand.trim(),
			args: form.mcpArgsText
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean),
			url: form.mcpUrl.trim(),
			env,
		};
	}
	if (form.type === "cmd" || form.type === "gui") {
		tool.executable = form.executable.trim();
		tool.args = form.argsText
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		try {
			tool.params = JSON.parse(form.paramsText || "[]");
		} catch {
			tool.params = [];
		}
	}
	return tool;
}

function iconText(tool) {
	const icon = (tool.icon ?? "").trim();
	if (icon) return icon.length > 2 ? icon.slice(0, 2) : icon;
	return (tool.name ?? tool.id ?? "?").slice(0, 1).toUpperCase();
}

function TypeTag({ type, aiUsable }) {
	return (
		<span className="tool-tag">
			<span className={`tool-type ${type}`}>{TYPE_LABEL[type] ?? type}</span>
			{aiUsable ? <span className="tool-ai">AI</span> : null}
		</span>
	);
}

function ToolForm({ initial, categories, onClose, onSaved }) {
	const [form, setForm] = useState(initial);
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);
	const [newCategory, setNewCategory] = useState("");
	const [addingCategory, setAddingCategory] = useState(false);
	const [iconPickerOpen, setIconPickerOpen] = useState(() => {
		try {
			return new URLSearchParams(window.location.search).get("icons") === "1";
		} catch {
			return false;
		}
	});
	const iconFieldRef = useRef(null);
	const editing = Boolean(initial.id);

	useEffect(() => {
		if (!iconPickerOpen) return;
		const onPointerDown = (event) => {
			if (iconFieldRef.current && !iconFieldRef.current.contains(event.target)) {
				setIconPickerOpen(false);
			}
		};
		document.addEventListener("mousedown", onPointerDown);
		return () => document.removeEventListener("mousedown", onPointerDown);
	}, [iconPickerOpen]);

	const categoryOptions = useMemo(() => {
		return [...new Set([...categories, form.category].filter(Boolean))];
	}, [categories, form.category]);

	function fallbackIcon() {
		const name = (form.name ?? "").trim();
		return name ? name.slice(0, 1).toUpperCase() : "?";
	}

	function set(key, value) {
		setForm((prev) => ({ ...prev, [key]: value }));
	}

	async function commitNewCategory() {
		const name = newCategory.trim();
		if (!name) {
			setAddingCategory(false);
			return;
		}
		try {
			await api.post("/api/tool-categories", { name });
		} catch {
			/* 分类保存失败不阻塞工具保存，工具落库后分类也会出现 */
		}
		set("category", name);
		setNewCategory("");
		setAddingCategory(false);
	}

	async function save() {
		if (!form.name.trim()) return setError("请填写工具名称");
		setSaving(true);
		setError("");
		try {
			const tool = toolFromForm(form);
			const result = editing
				? await api.put(`/api/tools/${initial.id}`, { tool })
				: await api.post("/api/tools", { tool });
			onSaved(result.tool);
		} catch (err) {
			setError(String(err?.message ?? err));
		} finally {
			setSaving(false);
		}
	}

	const cmdLike = form.type === "cmd" || form.type === "gui";

	return (
		<Modal wide onClose={onClose}>
			<div className="modal-head">
				<h3>{editing ? "编辑工具" : "添加工具"}</h3>
				<button className="ghost" onClick={onClose}>
					✕
				</button>
			</div>
			<div className="modal-body tool-form">
				<div className="tool-form-row">
					<div className="field">
						<label>所属分类</label>
						{addingCategory ? (
							<div className="cat-new-row">
								<input
									autoFocus
									value={newCategory}
									placeholder="新分类名称"
									onChange={(event) => setNewCategory(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											commitNewCategory();
										} else if (event.key === "Escape") {
											setAddingCategory(false);
											setNewCategory("");
										}
									}}
								/>
								<button className="ghost" onClick={commitNewCategory}>
									确定
								</button>
								<button
									className="ghost"
									onClick={() => {
										setAddingCategory(false);
										setNewCategory("");
									}}
								>
									取消
								</button>
							</div>
						) : (
							<select
								value={form.category}
								onChange={(event) => {
									if (event.target.value === "__new__") {
										setAddingCategory(true);
										setNewCategory("");
										return;
									}
									set("category", event.target.value);
								}}
							>
								{categoryOptions.map((name) => (
									<option key={name} value={name}>
										{name}
									</option>
								))}
								<option value="__new__">＋ 新建分类…</option>
							</select>
						)}
					</div>
					<div className="field">
						<label>工具名称 *</label>
						<input
							value={form.name}
							placeholder="例如：dirsearch、sqlmap"
							onChange={(e) => set("name", e.target.value)}
						/>
					</div>
				</div>

				<div className="field">
					<label>工具类型 *</label>
					<div className="type-options">
						{TYPE_OPTIONS.map((option) => (
							<label key={option.id} className={`type-option ${form.type === option.id ? "active" : ""}`}>
								<input
									type="radio"
									name="tool-type"
									checked={form.type === option.id}
									onChange={() => set("type", option.id)}
								/>
								{option.label}
							</label>
						))}
					</div>
				</div>

				{cmdLike ? (
					<>
						<div className="field">
							<label>{form.type === "gui" ? "可执行文件" : "可执行文件 / 命令"} *</label>
							<input
								value={form.executable}
								placeholder="例如：C:\\Python39\\python.exe 或 curl"
								onChange={(e) => set("executable", e.target.value)}
							/>
						</div>
						<div className="field">
							<label>参数（每行一个，支持 {"{参数名}"} 占位）</label>
							<textarea
								className="mono"
								value={form.argsText}
								placeholder={"dirsearch.py\n-u\n{url}"}
								onChange={(e) => set("argsText", e.target.value)}
							/>
						</div>
						<div className="tool-form-row">
							<div className="field">
								<label>工作目录</label>
								<input value={form.workdir} placeholder="默认：可执行文件所在目录" onChange={(e) => set("workdir", e.target.value)} />
							</div>
							<div className="field">
								<label>运行环境</label>
								<input value={form.runtime} placeholder="例如：python 3.9.21（可选）" onChange={(e) => set("runtime", e.target.value)} />
							</div>
						</div>
						{form.type === "cmd" ? (
							<div className="field">
								<label>AI 调用参数定义（JSON 数组，可选）</label>
								<textarea
									className="mono"
									value={form.paramsText}
									onChange={(e) => set("paramsText", e.target.value)}
								/>
							</div>
						) : null}
					</>
				) : null}

				{form.type === "website" ? (
					<div className="field">
						<label>网站 URL *</label>
						<input value={form.url} placeholder="https://example.com" onChange={(e) => set("url", e.target.value)} />
					</div>
				) : null}

				{form.type === "mcp" ? (
					<>
						<div className="field">
							<label>传输方式 *</label>
							<select value={form.mcpTransport} onChange={(e) => set("mcpTransport", e.target.value)}>
								<option value="stdio">stdio（本地命令）</option>
								<option value="http">streamable HTTP</option>
								<option value="sse">SSE</option>
							</select>
						</div>
						{form.mcpTransport === "stdio" ? (
							<>
								<div className="field">
									<label>启动命令 *</label>
									<input value={form.mcpCommand} placeholder="npx" onChange={(e) => set("mcpCommand", e.target.value)} />
								</div>
								<div className="field">
									<label>命令参数（每行一个）</label>
									<textarea
										className="mono"
										value={form.mcpArgsText}
										placeholder={"-y\n@modelcontextprotocol/server-filesystem\nD:\\\\workspace"}
										onChange={(e) => set("mcpArgsText", e.target.value)}
									/>
								</div>
								<div className="field">
									<label>环境变量（KEY=VALUE，每行一个）</label>
									<textarea className="mono" value={form.mcpEnvText} onChange={(e) => set("mcpEnvText", e.target.value)} />
								</div>
							</>
						) : (
							<div className="field">
								<label>MCP Server URL *</label>
								<input value={form.mcpUrl} placeholder="http://127.0.0.1:3000/mcp" onChange={(e) => set("mcpUrl", e.target.value)} />
							</div>
						)}
					</>
				) : null}

				<div className="tool-form-row">
					<div className="field icon-field" ref={iconFieldRef}>
						<label>图标（可留空）</label>
						<div className={`icon-input-wrap ${iconPickerOpen ? "open" : ""}`}>
							<input
								value={form.icon}
								placeholder="点击选择，或直接输入；留空用名称首字"
								onFocus={() => setIconPickerOpen(true)}
								onClick={() => setIconPickerOpen(true)}
								onChange={(event) => set("icon", event.target.value)}
							/>
							<span className="icon-preview" title="图标预览">
								{form.icon || fallbackIcon()}
							</span>
						</div>
						{iconPickerOpen ? (
							<div className="icon-popover">
								<div className="icon-popover-head">
									<span>常用图标</span>
									<button
										type="button"
										className="icon-popover-clear"
										onClick={() => {
											set("icon", "");
											setIconPickerOpen(false);
										}}
									>
										留空（用首字）
									</button>
								</div>
								<div className="icon-presets">
									{ICON_PRESETS.map((emoji) => (
										<button
											type="button"
											key={emoji}
											className={`icon-preset ${form.icon === emoji ? "active" : ""}`}
											onClick={() => {
												set("icon", emoji);
												setIconPickerOpen(false);
											}}
											title={`使用 ${emoji}`}
										>
											{emoji}
										</button>
									))}
								</div>
							</div>
						) : null}
					</div>
					<div className="field">
						<label>版本</label>
						<input value={form.version} placeholder="1.0.0（可选）" onChange={(e) => set("version", e.target.value)} />
					</div>
				</div>

				<div className="field">
					<label>工具主页</label>
					<input value={form.homepage} placeholder="https://github.com/xxx/xxx（可选）" onChange={(e) => set("homepage", e.target.value)} />
				</div>
				<div className="field">
					<label>描述</label>
					<textarea value={form.description} placeholder="简单介绍一下这个工具…" onChange={(e) => set("description", e.target.value)} />
				</div>

				{error ? <div className="error-text">{error}</div> : null}
			</div>
			<div className="modal-foot">
				<button onClick={onClose}>取消</button>
				<button className="primary" onClick={save} disabled={saving}>
					{saving ? "保存中…" : "保存"}
				</button>
			</div>
		</Modal>
	);
}

function LaunchPanel({ launch, onClose }) {
	const [run, setRun] = useState(launch?.run ?? null);
	const [mcpTools, setMcpTools] = useState(launch?.tools ?? null);
	const [argsText, setArgsText] = useState("{}");
	const [result, setResult] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const timerRef = useRef(null);

	useEffect(() => {
		if (!run || run.status !== "running") return;
		timerRef.current = setInterval(async () => {
			try {
				const data = await api.get(`/api/tool-runs/${run.id}`);
				setRun(data.run);
				if (data.run.status !== "running") clearInterval(timerRef.current);
			} catch {
				/* ignore */
			}
		}, 1200);
		return () => clearInterval(timerRef.current);
	}, [run?.id, run?.status]);

	async function rerun() {
		if (!launch?.toolId) return;
		setBusy(true);
		setError("");
		try {
			const parsed = JSON.parse(argsText || "{}");
			const data = await api.post(`/api/tools/${launch.toolId}/launch`, { args: parsed });
			setRun(data.run ?? null);
			setResult("");
		} catch (err) {
			setError(String(err?.message ?? err));
		} finally {
			setBusy(false);
		}
	}

	async function callMcp(toolName) {
		setBusy(true);
		setError("");
		try {
			const parsed = JSON.parse(argsText || "{}");
			const data = await api.post(`/api/tools/${launch.toolId}/mcp/call`, { tool: toolName, args: parsed });
			setResult(data.result?.text ?? JSON.stringify(data));
		} catch (err) {
			setError(String(err?.message ?? err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="launch-panel">
			<div className="launch-head">
				<span>{launch?.title ?? "运行"}</span>
				<button className="icon" onClick={onClose}>
					✕
				</button>
			</div>
			<div className="launch-body">
				{launch?.kind === "website" ? (
					<div className="launch-note">已在浏览器打开：{launch.url}</div>
				) : null}
				{launch?.kind === "gui" ? (
					<div className="launch-note">
						已启动 GUI 进程{launch.pid ? `（pid ${launch.pid}）` : ""}：{launch.argv?.join(" ")}
					</div>
				) : null}
				{launch?.kind === "mcp" ? (
					<>
						{launch.ok ? (
							<>
								<div className="launch-note">已连接，发现 {mcpTools?.length ?? 0} 个 MCP 工具</div>
								<div className="mcp-tools">
									{(mcpTools ?? []).map((item) => (
										<div className="mcp-tool-row" key={item.name}>
											<div>
												<div className="mcp-tool-name">{item.name}</div>
												<div className="mcp-tool-desc">{item.description}</div>
											</div>
											<button className="ghost" onClick={() => callMcp(item.name)}>
												调用
											</button>
										</div>
									))}
								</div>
							</>
						) : (
							<div className="error-text">连接失败：{launch.error}</div>
						)}
						<div className="launch-label">参数（JSON）</div>
						<textarea className="mono" value={argsText} onChange={(e) => setArgsText(e.target.value)} />
						{result ? <pre className="launch-output">{result}</pre> : null}
					</>
				) : null}
				{launch?.kind === "cmd" ? (
					<>
						<div className="launch-label">参数（JSON）</div>
						<textarea className="mono" value={argsText} onChange={(e) => setArgsText(e.target.value)} />
						<div className="launch-actions">
							<button className="ghost" onClick={rerun} disabled={busy}>
								{busy ? "启动中…" : "重新运行"}
							</button>
							{run ? (
								<span className="launch-status">
									{run.status === "running" ? "运行中…" : run.status === "failed" ? "失败" : `exit ${run.exitCode}`}
								</span>
							) : null}
						</div>
						{run?.text ? <pre className="launch-output">{run.text}</pre> : null}
						{run?.error ? <div className="error-text">{run.error}</div> : null}
					</>
				) : null}
				{error ? <div className="error-text">{error}</div> : null}
			</div>
		</div>
	);
}

export function ToolsPage({ onClose }) {
	const [tools, setTools] = useState([]);
	const [categories, setCategories] = useState([]);
	const [activeCategory, setActiveCategory] = useState("全部应用");
	const [query, setQuery] = useState("");
	const [editing, setEditing] = useState(null);
	const [launch, setLaunch] = useState(null);
	const [error, setError] = useState("");
	const [addingCategory, setAddingCategory] = useState(false);
	const [newCategoryName, setNewCategoryName] = useState("");

	useEffect(() => {
		load();
	}, []);

	async function createCategory() {
		const name = newCategoryName.trim();
		if (!name) {
			setAddingCategory(false);
			return;
		}
		try {
			await api.post("/api/tool-categories", { name });
			setAddingCategory(false);
			setNewCategoryName("");
			setActiveCategory(name);
			await load();
		} catch (err) {
			setError(String(err?.message ?? err));
		}
	}

	async function deleteCategory(name) {
		if (!window.confirm(`删除分类「${name}」？（分类下不能有工具）`)) return;
		try {
			const response = await fetch(`/api/tool-categories/${encodeURIComponent(name)}`, { method: "DELETE" });
			const data = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(data.error ?? `删除失败：${response.status}`);
			if (activeCategory === name) setActiveCategory("全部应用");
			await load();
		} catch (err) {
			setError(String(err?.message ?? err));
		}
	}

	async function load() {
		try {
			const data = await api.get("/api/tools");
			setTools(data.tools);
			setCategories(data.categories ?? []);
		} catch (err) {
			setError(String(err?.message ?? err));
		}
	}

	const filtered = useMemo(() => {
		const keyword = query.trim().toLowerCase();
		return tools.filter((tool) => {
			if (activeCategory !== "全部应用" && (tool.category ?? "综合工具") !== activeCategory) return false;
			if (!keyword) return true;
			return `${tool.id} ${tool.name} ${tool.description} ${tool.category}`.toLowerCase().includes(keyword);
		});
	}, [tools, activeCategory, query]);

	const categoryList = useMemo(
		() =>
			categories.filter(
				(item) => item.count > 0 || !item.builtin || activeCategory === item.name,
			),
		[categories, activeCategory],
	);

	useEffect(() => {
		try {
			const params = new URLSearchParams(window.location.search);
			if (params.get("add") === "1") setEditing(emptyForm("综合工具"));
		} catch {
			/* ignore */
		}
	}, []);

	async function launchTool(tool) {
		setError("");
		try {
			const data = await api.post(`/api/tools/${tool.id}/launch`, { args: {} });
			if (data.kind === "mcp") {
				setLaunch({ kind: "mcp", toolId: tool.id, title: tool.name, ok: data.ok, tools: data.tools, error: data.error });
			} else if (data.kind === "cmd") {
				setLaunch({ kind: "cmd", toolId: tool.id, title: tool.name, run: data.run });
			} else if (data.kind === "website") {
				setLaunch({ kind: "website", toolId: tool.id, title: tool.name, url: data.url });
			} else {
				setLaunch({ kind: "gui", toolId: tool.id, title: tool.name, pid: data.pid, argv: data.argv });
			}
		} catch (err) {
			setError(String(err?.message ?? err));
		}
	}

	async function removeTool(tool) {
		if (!window.confirm(`删除工具「${tool.name}」？`)) return;
		try {
			const response = await fetch(`/api/tools/${tool.id}`, { method: "DELETE" });
			if (!response.ok) throw new Error(`删除失败：${response.status}`);
			await load();
		} catch (err) {
			setError(String(err?.message ?? err));
		}
	}

	return (
		<div className="tools-page">
			<aside className="tools-page-side">
				<div className="tools-brand">工具箱</div>
				<button
					className={`tools-nav ${activeCategory === "全部应用" ? "active" : ""}`}
					onClick={() => setActiveCategory("全部应用")}
				>
					<span className="tools-nav-icon">★</span>
					全部应用
					<span className="tools-nav-count">{tools.length}</span>
				</button>
				<div className="tools-nav-group">
					<span>分类</span>
					<button className="tools-cat-add" onClick={() => setAddingCategory(true)} title="新建分类">
						＋ 新建
					</button>
				</div>
				{addingCategory ? (
					<div className="tools-cat-new">
						<input
							autoFocus
							value={newCategoryName}
							placeholder="新分类名称"
							onChange={(event) => setNewCategoryName(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									createCategory();
								} else if (event.key === "Escape") {
									setAddingCategory(false);
									setNewCategoryName("");
								}
							}}
						/>
						<button className="tools-cat-ok" onClick={createCategory} title="确定">
							✓
						</button>
						<button
							className="tools-cat-cancel"
							onClick={() => {
								setAddingCategory(false);
								setNewCategoryName("");
							}}
							title="取消"
						>
							✕
						</button>
					</div>
				) : null}
				{categoryList.map((item) => (
					<div className="tools-nav-wrap" key={item.name}>
						<button
							className={`tools-nav ${activeCategory === item.name ? "active" : ""}`}
							onClick={() => setActiveCategory(item.name)}
						>
							<span className="tools-nav-icon">·</span>
							{item.name}
							<span className="tools-nav-count">{item.count}</span>
						</button>
						{item.deletable ? (
							<button
								className="tools-cat-del"
								title="删除分类"
								onClick={() => deleteCategory(item.name)}
							>
								✕
							</button>
						) : null}
					</div>
				))}
				<div className="tools-page-side-foot">
					<button className="ghost" onClick={onClose}>
						返回对话
					</button>
				</div>
			</aside>

			<main className="tools-page-main">
				<header className="tools-page-head">
					<input
						className="tools-search"
						placeholder="搜索工具…"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<span className="tools-total">共 {filtered.length} 个工具</span>
					<button className="primary" onClick={() => setEditing(emptyForm(activeCategory))}>
						添加工具
					</button>
					<button className="ghost" onClick={onClose}>
						关闭
					</button>
				</header>

				{error ? <div className="error-text tools-page-error">{error}</div> : null}

				<div className="tools-grid">
					{filtered.map((tool) => (
						<div className="tool-card" key={tool.id}>
							<div className={`tool-card-icon ${tool.type}`}>{iconText(tool)}</div>
							<div className="tool-card-main">
								<div className="tool-card-title">
									<span className="tool-card-name">{tool.name}</span>
									<TypeTag type={tool.type} aiUsable={tool.aiUsable} />
								</div>
								<div className="tool-card-meta">
									<span className="tool-card-category">{tool.category}</span>
									{tool.runtime ? <span>{tool.runtime}</span> : null}
									{tool.version ? <span>v{tool.version}</span> : null}
									{tool.source === "repo" ? <span className="tool-card-repo">示例</span> : null}
								</div>
								<div className="tool-card-desc">{tool.description || "暂无描述"}</div>
							</div>
							<div className="tool-card-actions">
								<button className="tool-play" title="启动" onClick={() => launchTool(tool)}>
									▶
								</button>
								<button className="icon" title="编辑" onClick={() => setEditing(formFromTool(tool))}>
									✎
								</button>
								{tool.source === "runtime" ? (
									<button className="icon danger" title="删除" onClick={() => removeTool(tool)}>
										✕
									</button>
								) : null}
							</div>
						</div>
					))}
					{filtered.length === 0 ? <div className="tools-empty">这个分类下还没有工具</div> : null}
				</div>
			</main>

			{editing ? (
				<ToolForm
					initial={editing}
					categories={categories.map((item) => item.name)}
					onClose={() => setEditing(null)}
					onSaved={async () => {
						setEditing(null);
						await load();
					}}
				/>
			) : null}
			{launch ? <LaunchPanel launch={launch} onClose={() => setLaunch(null)} /> : null}
		</div>
	);
}
