import { useEffect, useMemo, useRef, useState } from "react";
import { MessageView } from "./MessageView.jsx";

const ROLE_LABELS = { commander: "指挥官", recon: "侦察员", jwt: "JWT 专家" };
const STATUS_LABELS = {
	running: "运行中",
	idle: "空闲",
	starting: "启动中",
	queued: "排队中",
	interrupted: "已中断",
	failed: "失败",
	error: "错误",
	aborted: "已中止",
};

function formatElapsed(ms) {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function formatTokens(n) {
	if (!n) return "0";
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function budgetInfo(agent, limits) {
	if (!agent || !limits) return null;
	const turns = agent.turns ?? 0;
	const tokens = (agent.tokensIn ?? 0) + (agent.tokensOut ?? 0);
	const turnPct = limits.maxTurns ? turns / limits.maxTurns : 0;
	const tokenPct = limits.maxTokens ? tokens / limits.maxTokens : 0;
	const pct = Math.max(turnPct, tokenPct);
	return {
		pct,
		text: `${turns}/${limits.maxTurns} 轮 · ${formatTokens(tokens)}/${formatTokens(limits.maxTokens)}`,
		level: pct >= 1 ? "over" : pct >= 0.8 ? "warn" : "",
	};
}

function useElapsed(agent) {
	const [, tick] = useState(0);
	const running = agent?.status === "running";
	useEffect(() => {
		if (!running) return undefined;
		const timer = setInterval(() => tick((value) => value + 1), 1000);
		return () => clearInterval(timer);
	}, [running, agent?.id]);
	if (!agent?.startedAt) return "";
	const end = running ? Date.now() : agent.endedAt;
	if (!end || end < agent.startedAt) return "";
	return formatElapsed(end - agent.startedAt);
}

export function Conversation({ agent, messages, showThinking, setShowThinking, onSend, onAbort, onPopout, onResume, limits }) {
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const [resuming, setResuming] = useState(false);
	const [error, setError] = useState("");
	const scrollRef = useRef(null);
	const stickRef = useRef(true);

	const toolResults = useMemo(() => {
		const map = new Map();
		for (const message of messages) {
			if (message.role === "toolResult" && message.toolCallId) map.set(message.toolCallId, message);
		}
		return map;
	}, [messages]);

	const streaming = agent?.status === "running";
	const elapsed = useElapsed(agent);
	const budget = budgetInfo(agent, limits);

	useEffect(() => {
		setText("");
		setError("");
	}, [agent?.id]);

	useEffect(() => {
		const element = scrollRef.current;
		if (!element) return;
		if (stickRef.current) element.scrollTop = element.scrollHeight;
	}, [messages, showThinking]);

	function onScroll() {
		const element = scrollRef.current;
		if (!element) return;
		stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
	}

	async function submit() {
		const value = text.trim();
		if (!value || sending) return;
		setSending(true);
		setError("");
		try {
			stickRef.current = true;
			await onSend(value);
			setText("");
		} catch (err) {
			setError(String(err?.message ?? err));
		} finally {
			setSending(false);
		}
	}

	async function resume() {
		if (!onResume) return;
		setResuming(true);
		setError("");
		try {
			await onResume(agent.id);
		} catch (err) {
			setError(String(err?.message ?? err));
		} finally {
			setResuming(false);
		}
	}

	if (!agent) return <div className="center-note">选择左侧的 agent</div>;

	return (
		<div className="chat">
			<div className="chat-head">
				<div className="chat-title">
					<span className={`dot ${agent.status}`} />
					<span>{ROLE_LABELS[agent.role] ?? agent.role}</span>
					<span className="chat-id">{agent.id}</span>
					{elapsed ? <span className="chat-elapsed">{elapsed}</span> : null}
					{budget && (agent.turns > 0 || streaming) ? (
						<span className={`chat-budget ${budget.level}`} title={`预算 ${budget.text}`}>
							{budget.text}
						</span>
					) : null}
					{agent.status !== "idle" ? (
						<span className={`chat-state ${agent.status}`}>{STATUS_LABELS[agent.status] ?? agent.status}</span>
					) : null}
				</div>
				<div className="chat-actions">
					<label className="check">
						<input
							type="checkbox"
							checked={showThinking}
							onChange={(event) => setShowThinking(event.target.checked)}
						/>
						推理
					</label>
					{onPopout ? (
						<button className="icon" title="独立窗口" onClick={() => onPopout(agent)}>
							⧉
						</button>
					) : null}
					{onResume && agent.connected === false && agent.sessionFile ? (
						<button className="resume-btn" onClick={() => resume()} disabled={resuming}>
							{resuming ? "恢复中…" : "恢复会话"}
						</button>
					) : null}
					{streaming ? (
						<button className="icon danger" title="中止" onClick={() => onAbort(agent.id)}>
							■
						</button>
					) : null}
				</div>
			</div>

			<div className="chat-body" ref={scrollRef} onScroll={onScroll}>
				<div className="chat-inner">
					{messages.length === 0 ? <div className="muted">暂无消息</div> : null}
					{messages.map((message) => (
						<MessageView
							key={message.id}
							message={message}
							toolResults={toolResults}
							showThinking={showThinking}
							streaming={streaming && message === messages[messages.length - 1]}
						/>
					))}
					{agent.error ? <div className="error-text">{agent.error}</div> : null}
				</div>
			</div>

			<div className="composer">
				<div className="composer-box">
					<textarea
						rows={1}
						value={text}
						placeholder={streaming ? "运行中，发送将插入旁注…" : `发消息…`}
						onChange={(event) => setText(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								submit();
							}
						}}
					/>
					<button className="send" onClick={submit} disabled={sending || !text.trim()} title="发送">
						↑
					</button>
				</div>
				{error ? <div className="error-text">{error}</div> : null}
			</div>
		</div>
	);
}
