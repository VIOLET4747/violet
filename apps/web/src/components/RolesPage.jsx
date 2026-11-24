import { useEffect, useState } from "react";
import { api } from "../api.js";

const THINKING_OPTIONS = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

const NEW_SKILL = `---
name: my-skill
description: 说明这个技能做什么、什么时候应该加载它。
---

# 技能说明

写清楚执行步骤、判定标准、注意事项。
`;

export function RolesPage({ onClose }) {
	const [tab, setTab] = useState("roles");
	const [roles, setRoles] = useState([]);
	const [skills, setSkills] = useState([]);
	const [wordlists, setWordlists] = useState([]);
	const [selectedRole, setSelectedRole] = useState(null);
	const [draft, setDraft] = useState(null);
	const [selectedSkill, setSelectedSkill] = useState(null);
	const [skillDraft, setSkillDraft] = useState({ id: "", content: NEW_SKILL });
	const [selectedDict, setSelectedDict] = useState(null);
	const [dictDraft, setDictDraft] = useState({ name: "", content: "" });
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");

	useEffect(() => {
		loadRoles();
		loadSkills();
		loadWordlists();
	}, []);

	async function loadRoles(keep = true) {
		try {
			const data = await api.get("/api/roles");
			setRoles(data.roles);
			const id = keep && selectedRole ? selectedRole : data.roles[0]?.role;
			const role = data.roles.find((item) => item.role === id) ?? data.roles[0];
			setSelectedRole(role?.role ?? null);
			setDraft(role ? { ...role, modelProvider: role.model?.provider ?? "", modelId: role.model?.model ?? "" } : null);
		} catch (err) {
			setError(String(err?.message ?? err));
		}
	}

	async function loadSkills() {
		try {
			const data = await api.get("/api/skills");
			setSkills(data.skills);
		} catch (err) {
			setError(String(err?.message ?? err));
		}
	}

	async function loadWordlists() {
		try {
			const data = await api.get("/api/wordlists");
			setWordlists(data.wordlists);
		} catch (err) {
			setError(String(err?.message ?? err));
		}
	}

	function pickRole(role) {
		setSelectedRole(role.role);
		setDraft({ ...role, modelProvider: role.model?.provider ?? "", modelId: role.model?.model ?? "" });
		setError("");
		setMessage("");
	}

	function toggleList(field, value) {
		const current = new Set(draft[field] ?? []);
		if (current.has(value)) current.delete(value);
		else current.add(value);
		setDraft({ ...draft, [field]: [...current] });
	}

	async function saveRole() {
		setError("");
		setMessage("");
		try {
			const patch = {
				tools: draft.tools,
				skills: draft.skills,
				thinking: draft.thinking || null,
				maxTurns: draft.maxTurns || null,
				maxTokens: draft.maxTokens || null,
				model:
					draft.modelProvider && draft.modelId
						? { provider: draft.modelProvider.trim(), model: draft.modelId.trim() }
						: null,
			};
			await api.put(`/api/roles/${selectedRole}`, patch);
			setMessage("已保存（下一轮新 agent 生效）");
			await loadRoles();
		} catch (err) {
			setError(String(err?.message ?? err));
		}
	}

	async function resetRoleConfig() {
		if (!selectedRole) return;
		try {
			await api.post(`/api/roles/${selectedRole}/reset`, {});
			setMessage("已恢复默认");
			await loadRoles();
		} catch (err) {
			setError(String(err?.message ?? err));
		}
	}

	async function pickSkill(id) {
		setSelectedSkill(id);
		setMessage("");
		setError("");
		if (!id) {
			setSkillDraft({ id: "", content: NEW_SKILL });
			return;
		}
		try {
			const data = await api.get(`/api/skills/${id}`);
			setSkillDraft({ id, content: data.skill.content });
		} catch (err) {
			setError(String(err?.message ?? err));
		}
	}

	async function saveSkill() {
		setError("");
		setMessage("");
		try {
			const id = skillDraft.id.trim();
			if (!id) throw new Error("先填技能 id");
			await api.put(`/api/skills/${id}`, { content: skillDraft.content });
			setMessage(`已保存 ${id}`);
			setSelectedSkill(id);
			await loadSkills();
			await loadRoles(false);
		} catch (err) {
			setError(String(err?.message ?? err));
		}
	}

	async function removeSkill() {
		if (!selectedSkill || !window.confirm(`删除技能 ${selectedSkill}？`)) return;
		try {
			await fetch(`/api/skills/${selectedSkill}`, { method: "DELETE" });
			setSelectedSkill(null);
			setSkillDraft({ id: "", content: NEW_SKILL });
			await loadSkills();
			await loadRoles(false);
		} catch (err) {
			setError(String(err?.message ?? err));
		}
	}

	async function pickDict(name) {
		setSelectedDict(name);
		setMessage("");
		setError("");
		if (!name) {
			setDictDraft({ name: "", content: "" });
			return;
		}
		try {
			const data = await api.get(`/api/wordlists/${name}`);
			setDictDraft({ name, content: data.wordlist.content });
		} catch (err) {
			setError(String(err?.message ?? err));
		}
	}

	async function saveDict() {
		setError("");
		setMessage("");
		try {
			const name = dictDraft.name.trim();
			if (!name) throw new Error("先填字典名");
			await api.put(`/api/wordlists/${name}`, { content: dictDraft.content });
			setMessage(`已保存 ${name}（.runtime/wordlists/${name}.txt）`);
			setSelectedDict(name);
			await loadWordlists();
		} catch (err) {
			setError(String(err?.message ?? err));
		}
	}

	async function removeDict() {
		if (!selectedDict || !window.confirm(`删除字典 ${selectedDict}？`)) return;
		try {
			await fetch(`/api/wordlists/${selectedDict}`, { method: "DELETE" });
			setSelectedDict(null);
			setDictDraft({ name: "", content: "" });
			await loadWordlists();
		} catch (err) {
			setError(String(err?.message ?? err));
		}
	}

	const activeSkill = skills.find((item) => item.id === selectedSkill);

	return (
		<div className="settings-page roles-page">
			<aside className="settings-side">
				<div className="settings-side-title">角色与技能</div>
				<nav className="settings-nav">
					<button className={`settings-nav-item ${tab === "roles" ? "active" : ""}`} onClick={() => setTab("roles")}>
						<span className="settings-nav-icon">◉</span>角色
					</button>
					<button className={`settings-nav-item ${tab === "skills" ? "active" : ""}`} onClick={() => setTab("skills")}>
						<span className="settings-nav-icon">◆</span>Skills
					</button>
					<button className={`settings-nav-item ${tab === "dicts" ? "active" : ""}`} onClick={() => setTab("dicts")}>
						<span className="settings-nav-icon">▤</span>字典
					</button>
				</nav>
			</aside>

			<section className="settings-main">
				<header className="settings-head">
					<h2>{tab === "roles" ? "角色配置" : tab === "skills" ? "Skills" : "字典管理"}</h2>
					<button className="icon" onClick={onClose} title="关闭">
						✕
					</button>
				</header>

				<div className="settings-body">
					{tab === "roles" && draft ? (
						<div className="roles-layout">
							<aside className="tools-list">
								{roles.map((role) => (
									<button
										key={role.role}
										className={`tools-item ${selectedRole === role.role ? "active" : ""}`}
										onClick={() => pickRole(role)}
									>
										<span className="tools-id">{role.role}</span>
										<span className="tools-source">{role.label}</span>
									</button>
								))}
							</aside>
							<div className="roles-form">
								<div className="settings-card">
									<div className="settings-card-title">{draft.label}（{draft.role}）</div>
									<div className="settings-card-sub">{draft.objective}</div>
									<div className="roles-grid">
										<label>
											模型 provider
											<input
												value={draft.modelProvider}
												placeholder="留空继承全局"
												onChange={(event) => setDraft({ ...draft, modelProvider: event.target.value })}
											/>
										</label>
										<label>
											模型 ID
											<input
												value={draft.modelId}
												placeholder="留空继承全局"
												onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
											/>
										</label>
										<label>
											thinking
											<select value={draft.thinking ?? ""} onChange={(event) => setDraft({ ...draft, thinking: event.target.value })}>
												{THINKING_OPTIONS.map((option) => (
													<option key={option} value={option}>
														{option || "继承全局"}
													</option>
												))}
											</select>
										</label>
										<label>
											maxTurns
											<input
												type="number"
												min="1"
												value={draft.maxTurns ?? ""}
												placeholder="继承全局"
												onChange={(event) => setDraft({ ...draft, maxTurns: event.target.value ? Number(event.target.value) : null })}
											/>
										</label>
										<label>
											maxTokens
											<input
												type="number"
												min="1"
												value={draft.maxTokens ?? ""}
												placeholder="继承全局"
												onChange={(event) => setDraft({ ...draft, maxTokens: event.target.value ? Number(event.target.value) : null })}
											/>
										</label>
									</div>
								</div>

								<div className="settings-card">
									<div className="settings-card-title">工具白名单（--tools）</div>
									<div className="check-grid">
										{(draft.availableTools ?? []).map((tool) => (
											<label key={tool} className="check-item">
												<input type="checkbox" checked={draft.tools.includes(tool)} onChange={() => toggleList("tools", tool)} />
												{tool}
											</label>
										))}
									</div>
								</div>

								<div className="settings-card">
									<div className="settings-card-title">技能白名单（--skill）</div>
									<div className="check-grid">
										{(draft.availableSkills ?? []).map((skill) => (
											<label key={skill.id} className="check-item" title={skill.description}>
												<input type="checkbox" checked={draft.skills.includes(skill.id)} onChange={() => toggleList("skills", skill.id)} />
												{skill.id}
												<span className="tools-source">{skill.source}</span>
											</label>
										))}
									</div>
								</div>

								<div className="tools-actions">
									<button className="primary" onClick={saveRole}>保存</button>
									<button className="ghost" onClick={resetRoleConfig}>恢复默认</button>
									{message ? <span className="tools-msg">{message}</span> : null}
								</div>
							</div>
						</div>
					) : null}

					{tab === "skills" ? (
						<div className="tools-body">
							<aside className="tools-list">
								<button className="foot-btn" onClick={() => pickSkill(null)}>
									＋ 新建技能
								</button>
								{skills.map((skill) => (
									<button
										key={skill.id}
										className={`tools-item ${selectedSkill === skill.id ? "active" : ""}`}
										onClick={() => pickSkill(skill.id)}
									>
										<span className="tools-id">{skill.id}</span>
										<span className="tools-source">{skill.source}</span>
									</button>
								))}
							</aside>
							<div className="tools-main">
								<div className="tools-label">技能 id（目录名）</div>
								<input
									className="tools-input"
									value={skillDraft.id}
									disabled={Boolean(activeSkill) && activeSkill.source === "repo"}
									onChange={(event) => setSkillDraft({ ...skillDraft, id: event.target.value })}
									placeholder="my-skill"
								/>
								<div className="tools-label">
									SKILL.md
									<span className="tools-hint">frontmatter 必须有 name / description；仓库 skills/ 为只读示例，保存写入 .runtime/skills/</span>
								</div>
								<textarea
									className="tools-yaml"
									value={skillDraft.content}
									spellCheck={false}
									onChange={(event) => setSkillDraft({ ...skillDraft, content: event.target.value })}
								/>
								<div className="tools-actions">
									<button className="primary" onClick={saveSkill}>保存</button>
									{activeSkill?.source === "runtime" ? (
										<button className="danger-ghost" onClick={removeSkill}>删除</button>
									) : null}
									{message ? <span className="tools-msg">{message}</span> : null}
								</div>
							</div>
						</div>
					) : null}

					{tab === "dicts" ? (
						<div className="tools-body">
							<aside className="tools-list">
								<button className="foot-btn" onClick={() => pickDict(null)}>
									＋ 新建字典
								</button>
								{wordlists.map((item) => (
									<button
										key={item.name}
										className={`tools-item ${selectedDict === item.name ? "active" : ""}`}
										onClick={() => pickDict(item.name)}
									>
										<span className="tools-id">{item.name}</span>
										<span className="tools-source">{item.lines} 行</span>
									</button>
								))}
							</aside>
							<div className="tools-main">
								<div className="tools-label">字典名（.runtime/wordlists/&lt;name&gt;.txt）</div>
								<input
									className="tools-input"
									value={dictDraft.name}
									onChange={(event) => setDictDraft({ ...dictDraft, name: event.target.value })}
									placeholder="passwords"
								/>
								<div className="tools-label">
									内容（每行一条）
									{selectedDict ? <span className="tools-hint">{wordlists.find((item) => item.name === selectedDict)?.path}</span> : null}
								</div>
								<textarea
									className="tools-yaml"
									value={dictDraft.content}
									spellCheck={false}
									onChange={(event) => setDictDraft({ ...dictDraft, content: event.target.value })}
								/>
								<div className="tools-actions">
									<button className="primary" onClick={saveDict}>保存</button>
									{selectedDict ? (
										<button className="danger-ghost" onClick={removeDict}>删除</button>
									) : null}
									{message ? <span className="tools-msg">{message}</span> : null}
								</div>
							</div>
						</div>
					) : null}

					{error ? <div className="error-text" style={{ padding: "0 20px 12px" }}>{error}</div> : null}
				</div>
			</section>
		</div>
	);
}
