import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { applyDelta, normalizeMessage, upsertMessage } from "./normalize.js";
import { AgentList } from "./components/AgentTree.jsx";
import { Conversation } from "./components/Conversation.jsx";
import { NewProjectDialog, FactsDialog } from "./components/Dialogs.jsx";
import { SettingsPage } from "./components/SettingsPage.jsx";
import { ToolsPage } from "./components/ToolsPage.jsx";
import { FindingsDialog } from "./components/FindingsDialog.jsx";
import { ReportDialog } from "./components/ReportDialog.jsx";
import { RolesPage } from "./components/RolesPage.jsx";
import { ApprovalPanel } from "./components/ApprovalPanel.jsx";
import { CostDialog } from "./components/CostDialog.jsx";
import { ModelSetup } from "./components/ModelSetup.jsx";

function useProjectStream(projectId, onEvent, enabled = true) {
	const [status, setStatus] = useState("idle");
	const handlerRef = useRef(onEvent);
	handlerRef.current = onEvent;

	useEffect(() => {
		if (!projectId || !enabled) return undefined;
		let closed = false;
		let source;
		let retryTimer;
		let lastId = 0;

		const connect = () => {
			if (closed) return;
			source = new EventSource(`/api/projects/${projectId}/events?after=${lastId}`);
			source.onopen = () => setStatus("live");
			source.onerror = () => {
				setStatus("reconnecting");
				source.close();
				if (!closed) retryTimer = setTimeout(connect, 1500);
			};
			source.onmessage = (event) => {
				if (event.lastEventId) lastId = Number(event.lastEventId) || lastId;
				try {
					handlerRef.current(JSON.parse(event.data));
				} catch {
					/* ignore bad frame */
				}
			};
		};

		setStatus("connecting");
		connect();
		return () => {
			closed = true;
			clearTimeout(retryTimer);
			source?.close();
			setStatus("idle");
		};
	}, [projectId, enabled]);

	return status;
}

export default function App() {
	const params = new URLSearchParams(window.location.search);
	const agent = params.get("agent");
	const project = params.get("project");
	if (agent && project) {
		document.body.classList.add("standalone");
		return <StandaloneAgent agentId={agent} projectId={project} streamEnabled={params.get("static") !== "1"} />;
	}
	return (
		<MainApp
			streamEnabled={params.get("static") !== "1"}
			initialTools={params.get("tools") === "1"}
			initialFindings={params.get("findings") === "1"}
			initialReport={params.get("report") === "1"}
			initialRoles={params.get("roles") === "1"}
			initialCost={params.get("cost") === "1"}
		/>
	);
}

function MainApp({ streamEnabled = true, initialTools = false, initialFindings = false, initialReport = false, initialRoles = false, initialCost = false }) {
	const [config, setConfig] = useState(null);
	const [projects, setProjects] = useState([]);
	const [projectId, setProjectId] = useState(null);
	const [agents, setAgents] = useState([]);
	const [facts, setFacts] = useState([]);
	const [selectedId, setSelectedId] = useState(null);
	const [messagesByAgent, setMessagesByAgent] = useState({});
	const [loadedAgents, setLoadedAgents] = useState(() => new Set());
	const [showThinking, setShowThinking] = useState(true);
	const [showSettings, setShowSettings] = useState(false);
	const [showNewProject, setShowNewProject] = useState(false);
	const [showFacts, setShowFacts] = useState(false);
	const [showTools, setShowTools] = useState(initialTools);
	const [showFindings, setShowFindings] = useState(initialFindings);
	const [showReport, setShowReport] = useState(initialReport);
	const [showRoles, setShowRoles] = useState(initialRoles);
	const [showCost, setShowCost] = useState(initialCost);
	const [approvals, setApprovals] = useState([]);
	const [findings, setFindings] = useState([]);
	const [error, setError] = useState("");
	const [backendOnline, setBackendOnline] = useState(true);
	const [limits, setLimits] = useState(null);
	const wasOffline = useRef(false);

	const selectedAgent = agents.find((item) => item.id === selectedId) ?? null;
	const messages = selectedId ? messagesByAgent[selectedId] ?? [] : [];

	useEffect(() => {
		api
			.get("/api/config")
			.then(setConfig)
			.catch((err) => setError(String(err?.message ?? err)));
		api
			.get("/api/projects")
			.then((data) => {
				setProjects(data.projects);
				if (data.projects[0]) setProjectId(data.projects[0].id);
			})
			.catch((err) => setError(String(err?.message ?? err)));
	}, []);

	// 后端健康检查：断开时给出可操作的提示，恢复后自动刷新
	useEffect(() => {
		let stopped = false;
		const check = async () => {
			try {
				const health = await api.get("/api/health");
				if (stopped) return;
				if (health.limits) setLimits(health.limits);
				setBackendOnline(true);
				if (wasOffline.current) {
					wasOffline.current = false;
					window.location.reload();
				}
			} catch {
				if (stopped) return;
				wasOffline.current = true;
				setBackendOnline(false);
			}
		};
		check();
		const timer = setInterval(check, 5000);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, []);

	useEffect(() => {
		if (!projectId) return;
		setAgents([]);
		setFacts([]);
		setFindings([]);
		setSelectedId(null);
		setMessagesByAgent({});
		setLoadedAgents(new Set());
		setApprovals([]);
		Promise.all([
			api.get(`/api/projects/${projectId}/agents`),
			api.get(`/api/projects/${projectId}/facts`),
			api.get(`/api/projects/${projectId}/findings`),
			api.get(`/api/approvals?projectId=${projectId}&status=pending`),
		])
			.then(([agentData, factData, findingData, approvalData]) => {
				setAgents(agentData.agents);
				setFacts(factData.facts);
				setFindings(findingData.findings);
				setApprovals(approvalData.approvals ?? []);
				const root = agentData.agents.find((item) => !item.parentId) ?? agentData.agents[0];
				if (root) setSelectedId(root.id);
			})
			.catch((err) => setError(String(err?.message ?? err)));
	}, [projectId]);

	const onStreamEvent = useCallback((event) => {
		const { type, agentId, payload } = event;
		if (type === "agent.created") {
			setAgents((prev) => (prev.some((item) => item.id === payload.agent.id) ? prev : [...prev, payload.agent]));
			return;
		}
		if (type === "agent.updated") {
			// SSE 里没有 connected 字段（只有 REST 列表会算），合并时保留已有值
			setAgents((prev) =>
				prev.map((item) => (item.id === payload.agent.id ? { ...item, ...payload.agent } : item)),
			);
			return;
		}
		if (type === "message.start") {
			if (payload.role !== "assistant") return;
			setMessagesByAgent((prev) => {
				const list = prev[agentId] ?? [];
				if (list.some((item) => item.id === payload.id)) return prev;
				return { ...prev, [agentId]: [...list, { id: payload.id, role: "assistant", blocks: [] }] };
			});
			return;
		}
		if (type === "message.delta") {
			setMessagesByAgent((prev) => ({ ...prev, [agentId]: applyDelta(prev[agentId] ?? [], payload.id, payload) }));
			return;
		}
		if (type === "message.end") {
			const normalized = normalizeMessage(payload.id, payload.message);
			if (!normalized) return;
			setMessagesByAgent((prev) => ({ ...prev, [agentId]: upsertMessage(prev[agentId] ?? [], normalized) }));
			return;
		}
		if (type === "fact.created") {
			setFacts((prev) => (prev.some((item) => item.id === payload.fact.id) ? prev : [...prev, payload.fact]));
			return;
		}
		if (type === "finding.created" || type === "finding.updated") {
			setFindings((prev) => {
				const exists = prev.some((item) => item.id === payload.finding.id);
				return exists ? prev.map((item) => (item.id === payload.finding.id ? { ...item, ...payload.finding } : item)) : [...prev, payload.finding];
			});
			return;
		}
		if (type === "approval.created" || type === "approval.updated") {
			const approval = payload.approval;
			setApprovals((prev) => {
				const next = prev.filter((item) => item.id !== approval.id);
				return approval.status === "pending" ? [...next, approval] : next;
			});
			return;
		}
	}, []);

	const streamStatus = useProjectStream(projectId, onStreamEvent, streamEnabled);

	useEffect(() => {
		if (!selectedId || loadedAgents.has(selectedId)) return;
		api
			.get(`/api/agents/${selectedId}/messages`)
			.then((data) => {
				const normalized = data.messages.map((item) => normalizeMessage(item.id, item.message)).filter(Boolean);
				setMessagesByAgent((prev) => ({ ...prev, [selectedId]: normalized }));
				setLoadedAgents((prev) => new Set(prev).add(selectedId));
			})
			.catch(() => {});
	}, [selectedId, loadedAgents]);

	// 断线重连后补状态：agents / facts / 当前会话消息（SSE 的 after 有 500 条上限，可能补不全）
	useEffect(() => {
		if (!streamEnabled || streamStatus !== "live" || !projectId) return;
		api.get(`/api/projects/${projectId}/agents`).then((data) => setAgents(data.agents)).catch(() => {});
		api.get(`/api/projects/${projectId}/facts`).then((data) => setFacts(data.facts)).catch(() => {});
		if (selectedId) {
			api
				.get(`/api/agents/${selectedId}/messages`)
				.then((data) => {
					const normalized = data.messages.map((item) => normalizeMessage(item.id, item.message)).filter(Boolean);
					setMessagesByAgent((prev) => ({ ...prev, [selectedId]: normalized }));
				})
				.catch(() => {});
		}
	}, [streamStatus, projectId, streamEnabled, selectedId]);

	async function sendMessage(text) {
		if (!selectedId) return;
		await api.post(`/api/agents/${selectedId}/messages`, { text });
	}

	async function resumeAgent(agentId) {
		const data = await api.post(`/api/agents/${agentId}/resume`, {});
		setAgents((prev) => prev.map((item) => (item.id === agentId ? data.agent : item)));
	}

	async function decideApproval(approvalId, status) {
		await api.post(`/api/approvals/${approvalId}/decide`, { status });
		setApprovals((prev) => prev.filter((item) => item.id !== approvalId));
	}

	function popout(item) {
		window.open(
			`${window.location.origin}/?agent=${item.id}&project=${projectId}`,
			`pentest-agent-${item.id}`,
			"width=760,height=860",
		);
	}

	if (error) {
		return (
			<div className="center-note">
				<div className="error-text">{error}</div>
				<button className="primary" onClick={() => window.location.reload()}>
					重试
				</button>
			</div>
		);
	}
	if (!config) return <div className="center-note">加载中…</div>;
	if (!config.configured) return <ModelSetup config={config} onSaved={setConfig} />;

	return (
		<>
			{!backendOnline ? (
				<div className="offline-banner">
					后端服务未连接（127.0.0.1:8787）。请在项目目录运行 <code>npm run dev</code>，恢复后本页会自动刷新。
				</div>
			) : null}
			<div className={`layout ${backendOnline ? "" : "offline"}`}>
				<aside className="sidebar">
				<div className="side-brand">Pi-Pentest</div>

				<div className="side-projects">
					<select
						value={projectId ?? ""}
						onChange={(event) => setProjectId(event.target.value)}
						disabled={projects.length === 0}
					>
						{projects.length === 0 ? <option value="">没有项目</option> : null}
						{projects.map((item) => (
							<option key={item.id} value={item.id}>
								{item.name}
							</option>
						))}
					</select>
					<button
						className="icon"
						title={backendOnline ? "新建项目" : "后端未连接"}
						onClick={() => backendOnline && setShowNewProject(true)}
						disabled={!backendOnline}
					>
						＋
					</button>
				</div>

				<div className="side-list">
					<AgentList agents={agents} selectedId={selectedId} onSelect={setSelectedId} />
				</div>

				<div className="side-foot">
					<button className="foot-btn" onClick={() => setShowFacts(true)}>
						<span>事实库</span>
						<span className="fact-count">{facts.length}</span>
					</button>
					<button className="foot-btn" onClick={() => setShowFindings(true)}>
						<span>证据</span>
						<span className="fact-count">{findings.length}</span>
					</button>
					<button className="foot-btn" onClick={() => setShowReport(true)}>
						<span>报告</span>
						<span className="fact-count">M5</span>
					</button>
					<button className="foot-btn" onClick={() => setShowCost(true)}>
						<span>成本</span>
						<span className="fact-count">M7</span>
					</button>
					<button className="foot-btn" onClick={() => setShowRoles(true)}>
						<span>角色</span>
						<span className="fact-count">Skills</span>
					</button>
					<button className="foot-btn" onClick={() => setShowTools(true)}>
						<span>工具箱</span>
						<span className="fact-count">YAML</span>
					</button>
					<button className="foot-btn" onClick={() => setShowSettings(true)}>
						<span className={`dot ${streamEnabled ? streamStatus : "live"}`} />
						<span className="model-name">
							{config.active ? `${config.active.provider}/${config.active.model}` : "未配置模型"}
						</span>
						<span className="gear">⚙</span>
					</button>
				</div>
			</aside>

			<main className="main">
				{agents.length === 0 ? (
					<div className="center-note">
						<div className="note-title">还没有 agent</div>
						<div className="note-sub">新建一个项目开始</div>
						<button
							className="primary"
							onClick={() => backendOnline && setShowNewProject(true)}
							disabled={!backendOnline}
						>
							新建项目
						</button>
					</div>
				) : (
					<Conversation
						agent={selectedAgent}
						messages={messages}
						showThinking={showThinking}
						setShowThinking={setShowThinking}
						onSend={sendMessage}
						onAbort={(id) => api.post(`/api/agents/${id}/abort`, {})}
						onPopout={popout}
						onResume={resumeAgent}
						limits={limits}
					/>
				)}
			</main>

			{showSettings ? (
				<SettingsPage config={config} onClose={() => setShowSettings(false)} onSaved={setConfig} />
			) : null}
			{showFacts ? <FactsDialog facts={facts} onClose={() => setShowFacts(false)} /> : null}
			{showTools ? <ToolsPage onClose={() => setShowTools(false)} /> : null}
			{showFindings ? <FindingsDialog projectId={projectId} onClose={() => setShowFindings(false)} /> : null}
			{showReport ? <ReportDialog projectId={projectId} onClose={() => setShowReport(false)} /> : null}
			{showRoles ? <RolesPage onClose={() => setShowRoles(false)} /> : null}
			{showCost ? <CostDialog projectId={projectId} onClose={() => setShowCost(false)} /> : null}
			<ApprovalPanel approvals={approvals} onDecided={decideApproval} />
			{showNewProject ? (
				<NewProjectDialog
					configured={config.configured}
					onClose={() => setShowNewProject(false)}
					onCreated={async (created) => {
						const data = await api.get("/api/projects");
						setProjects(data.projects);
						setProjectId(created.id);
					}}
				/>
			) : null}
			</div>
		</>
	);
}

function StandaloneAgent({ agentId, projectId, streamEnabled = true }) {
	const [agent, setAgent] = useState(null);
	const [messages, setMessages] = useState([]);
	const [showThinking, setShowThinking] = useState(true);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		api.get(`/api/agents/${agentId}`).then((data) => setAgent(data.agent)).catch(() => {});
		api
			.get(`/api/agents/${agentId}/messages`)
			.then((data) => {
				setMessages(data.messages.map((item) => normalizeMessage(item.id, item.message)).filter(Boolean));
				setLoaded(true);
			})
			.catch(() => setLoaded(true));
	}, [agentId]);

	const onStreamEvent = useCallback(
		(event) => {
			if (event.agentId !== agentId) return;
			if (event.type === "agent.updated") setAgent(event.payload.agent);
			if (event.type === "message.start" && event.payload.role === "assistant") {
				setMessages((prev) => [...prev, { id: event.payload.id, role: "assistant", blocks: [] }]);
			}
			if (event.type === "message.delta") setMessages((prev) => applyDelta(prev, event.payload.id, event.payload));
			if (event.type === "message.end") {
				const normalized = normalizeMessage(event.payload.id, event.payload.message);
				if (normalized) setMessages((prev) => upsertMessage(prev, normalized));
			}
		},
		[agentId],
	);

	const status = useProjectStream(projectId, onStreamEvent, streamEnabled);

	return (
		<div className="standalone">
			<div className="standalone-head">
				<span className={`dot ${agent?.status ?? "idle"}`} />
				<span className="standalone-title">{agent ? `${agent.id}` : "加载中…"}</span>
				<span className={`dot ${streamEnabled ? status : "live"}`} title="实时连接" />
			</div>
			{loaded ? (
				<Conversation
					agent={agent}
					messages={messages}
					showThinking={showThinking}
					setShowThinking={setShowThinking}
					onSend={async (text) => api.post(`/api/agents/${agentId}/messages`, { text })}
					onAbort={async (id) => api.post(`/api/agents/${id}/abort`, {})}
					onPopout={null}
					onResume={async (id) => {
						const data = await api.post(`/api/agents/${id}/resume`, {});
						setAgent(data.agent);
					}}
				/>
			) : (
				<div className="center-note">加载中…</div>
			)}
		</div>
	);
}
