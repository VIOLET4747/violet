import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import { formatDuration } from "../normalize.js";

marked.setOptions({ breaks: true, gfm: true });

export function Markdown({ text }) {
	const html = useMemo(() => marked.parse(text ?? ""), [text]);
	return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function ThinkingBlock({ text, live }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="thinking">
			<button className="thinking-head" onClick={() => setOpen((value) => !value)}>
				<span className="thinking-icon">✳</span>
				<span>{live ? "推理中…" : "推理过程"}</span>
				<span className="thinking-meta">
					{(text ?? "").length} 字 {open ? "▾" : "▸"}
				</span>
			</button>
			{open ? <div className="thinking-body">{text || "…"}</div> : null}
		</div>
	);
}

export function ToolRow({ block, result, live }) {
	const [open, setOpen] = useState(false);
	const status = result ? (result.isError ? "err" : "ok") : live ? "live" : "";
	const args = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {}, null, 2);
	return (
		<div className="tool">
			<button className="tool-head" onClick={() => setOpen((value) => !value)}>
				<span className="tool-name">{block.name ?? "tool"}</span>
				<span className={`tool-state ${status}`}>
					{result ? (result.isError ? "失败" : "完成") : live ? "运行中" : "等待"}
				</span>
				{result?.durationMs ? <span className="tool-time">{formatDuration(result.durationMs)}</span> : null}
				<span className="tool-caret">{open ? "▾" : "▸"}</span>
			</button>
			{open ? (
				<div className="tool-body">
					<pre>{args}</pre>
					{result ? <pre className={result.isError ? "err" : ""}>{result.text || "（无输出）"}</pre> : null}
				</div>
			) : null}
		</div>
	);
}

export function MessageView({ message, toolResults, showThinking, streaming }) {
	if (message.role === "user") {
		if (message.systemNotice) {
			return <div className="notice">{message.text}</div>;
		}
		return (
			<div className="msg user">
				<div className="bubble">
					<Markdown text={message.text} />
				</div>
			</div>
		);
	}

	if (message.role === "assistant") {
		const blocks = message.blocks ?? [];
		return (
			<div className="msg assistant">
				{blocks.length === 0 && streaming ? <div className="muted">思考中…</div> : null}
				{blocks.map((block, index) => {
					if (block.type === "thinking") {
						if (!showThinking) return null;
						return <ThinkingBlock key={index} text={block.text} live={streaming && index === blocks.length - 1} />;
					}
					if (block.type === "toolCall") {
						return (
							<ToolRow
								key={block.id ?? index}
								block={block}
								result={toolResults.get(block.id)}
								live={streaming && !toolResults.has(block.id)}
							/>
						);
					}
					return <Markdown key={index} text={block.text} />;
				})}
				{message.errorMessage ? <div className="error-text">{message.errorMessage}</div> : null}
			</div>
		);
	}

	return null;
}
