import { useEffect, useMemo, useRef, useState } from "react";
import { MessageView } from "./MessageView.jsx";

const ROLE_LABELS = { commander: "指挥官", recon: "侦察员", jwt: "JWT 专家" };
const STATUS_LABELS = { running: "运行中", idle: "空闲", starting: "启动中", error: "错误", aborted: "已中止" };

export function Conversation({ agent, messages, showThinking, setShowThinking, onSend, onAbort, onPopout }) {
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
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

	if (!agent) return <div className="center-note">选择左侧的 agent</div>;

	return (
		<div className="chat">
			<div className="chat-head">
				<div className="chat-title">
					<span className={`dot ${agent.status}`} />
					<span>{ROLE_LABELS[agent.role] ?? agent.role}</span>
					<span className="chat-id">{agent.id}</span>
					{streaming ? <span className="chat-state">运行中</span> : null}
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
