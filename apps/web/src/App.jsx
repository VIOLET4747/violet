import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { applyDelta, normalizeMessage, upsertMessage } from "./normalize.js";
import { AgentList } from "./components/AgentTree.jsx";
import { Conversation } from "./components/Conversation.jsx";
import { NewProjectDialog, SettingsDialog } from "./components/Dialogs.jsx";
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
	return <MainApp streamEnabled={params.get("static") !== "1"} />;
}

function MainApp({ streamEnabled = true }) {
	const [config, setConfig] = useState(null);
	const [projects, setProjects] = useState([]);
	const [projectId, setProjectId] = useState(null);
	const [agents, setAgents] = useState([]);
	const [selectedId, setSelectedId] = useState(null);
	const [messagesByAgent, setMessagesByAgent] = useState({});
	const [loadedAgents, setLoadedAgents] = useState(() => new Set());
	const [showThinking, setShowThinking] = useState(true);
	const [showSettings, setShowSettings] = useState(false);
	const [showNewProject, setShowNewProject] = useState(false);
	const [error, setError] = useState("");

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

	useEffect(() => {
		if (!projectId) return;
		setAgents([]);
		setSelectedId(null);
		setMessagesByAgent({});
		setLoadedAgents(new Set());
		api
			.get(`/api/projects/${projectId}/agents`)
			.then((data) => {
				setAgents(data.agents);
				const root = data.agents.find((item) => !item.parentId) ?? data.agents[0];
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
			setAgents((prev) => prev.map((item) => (item.id === payload.agent.id ? payload.agent : item)));
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

	// 断线重连后补状态
	useEffect(() => {
		if (!streamEnabled || streamStatus !== "live" || !projectId) return;
		api.get(`/api/projects/${projectId}/agents`).then((data) => setAgents(data.agents)).catch(() => {});
	}, [streamStatus, projectId, streamEnabled]);

	async function sendMessage(text) {
		if (!selectedId) return;
		await api.post(`/api/agents/${selectedId}/messages`, { text });
	}

	function popout(item) {
		window.open(
			`${window.location.origin}/?agent=${item.id}&project=${projectId}`,
			`pentest-agent-${item.id}`,
			"width=760,height=860",
		);
	}

	if (error) return <div className="center-note error-text">{error}</div>;
	if (!config) return <div className="center-note">加载中…</div>;
	if (!config.configured) return <ModelSetup config={config} onSaved={setConfig} />;

	return (
		<div className="layout">
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
					<button className="icon" title="新建项目" onClick={() => setShowNewProject(true)}>
						＋
					</button>
				</div>

				<div className="side-list">
					<AgentList agents={agents} selectedId={selectedId} onSelect={setSelectedId} />
				</div>

				<div className="side-foot">
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
						<button className="primary" onClick={() => setShowNewProject(true)}>
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
					/>
				)}
			</main>

			{showSettings ? (
				<SettingsDialog config={config} onClose={() => setShowSettings(false)} onSaved={setConfig} />
			) : null}
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
				/>
			) : (
				<div className="center-note">加载中…</div>
			)}
		</div>
	);
}
