/**
 * pi 消息 -> 前端模型。pi 的消息内容块：
 *   assistant: {type:"text"|"thinking"|"toolCall", ...}
 *   toolResult: {content:[{type:"text",text}], toolCallId, toolName, isError}
 */

export function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block?.type === "text" ? block.text ?? "" : ""))
		.join("\n")
		.trim();
}

export function normalizeMessage(id, message) {
	if (!message) return null;
	if (message.role === "user") {
		return {
			id,
			role: "user",
			text: textOf(message.content),
			systemNotice: Boolean(message.systemNotice),
			timestamp: message.timestamp,
		};
	}
	if (message.role === "toolResult") {
		return {
			id,
			role: "toolResult",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			text: textOf(message.content),
			isError: Boolean(message.isError),
			durationMs: message.durationMs,
			timestamp: message.timestamp,
		};
	}
	if (message.role === "assistant") {
		const blocks = (message.content ?? []).map((block) => {
			if (block.type === "thinking") {
				return { type: "thinking", text: block.thinking ?? "" };
			}
			if (block.type === "toolCall") {
				return {
					type: "toolCall",
					id: block.id,
					name: block.name,
					arguments: block.arguments,
				};
			}
			return { type: "text", text: block.text ?? "" };
		});
		return {
			id,
			role: "assistant",
			blocks,
			usage: message.usage,
			stopReason: message.stopReason,
			errorMessage: message.errorMessage,
			timestamp: message.timestamp,
		};
	}
	return { id, role: message.role, text: JSON.stringify(message).slice(0, 200) };
}

/** 追加/替换一条消息（按 id 去重）。 */
export function upsertMessage(list, message) {
	const index = list.findIndex((item) => item.id === message.id);
	if (index === -1) return [...list, message];
	const next = list.slice();
	next[index] = message;
	return next;
}

/** 应用一次流式增量。 */
export function applyDelta(list, id, delta) {
	const index = list.findIndex((item) => item.id === id);
	if (index === -1) return list;
	const message = list[index];
	if (message.role !== "assistant") return list;

	const blocks = message.blocks.map((block) => ({ ...block }));
	const target = blocks[delta.contentIndex ?? 0];
	const kind = delta.kind;

	if (kind === "text") {
		if (!target || target.type !== "text") {
			blocks.push({ type: "text", text: delta.delta ?? "" });
		} else {
			target.text = (target.text ?? "") + (delta.delta ?? "");
		}
	} else if (kind === "thinking") {
		if (!target || target.type !== "thinking") {
			blocks.push({ type: "thinking", text: delta.delta ?? "" });
		} else {
			target.text = (target.text ?? "") + (delta.delta ?? "");
		}
	} else if (kind === "toolcall") {
		if (!target || target.type !== "toolCall") {
			blocks.push({ type: "toolCall", arguments: delta.delta ?? "" });
		} else {
			target.arguments =
				typeof target.arguments === "string"
					? target.arguments + (delta.delta ?? "")
					: JSON.stringify(target.arguments ?? {}) + (delta.delta ?? "");
		}
	} else if (kind === "toolcall-end") {
		// 参数流结束，等 message.end 给权威结构
	}

	const next = list.slice();
	next[index] = { ...message, blocks };
	return next;
}

export function formatDuration(ms) {
	if (!ms) return "";
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}
