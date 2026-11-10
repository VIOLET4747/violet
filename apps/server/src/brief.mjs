/**
 * 项目简报：注入每个 agent 的 system prompt。
 * 只放"结论 + 指针"，不放原始日志——这是控制上下文的核心手段之一。
 */
const KIND_LABELS = {
	asset: "资产",
	endpoint: "接口",
	tech: "技术栈",
	credential: "凭据",
	behavior: "行为",
	finding: "发现",
	negative: "已排除",
};

export function renderBrief({ project, agent, agents, facts, roleLabels }) {
	const siblings = agents.filter((item) => item.id !== agent.id);
	const recentFacts = facts.slice(-12);
	const lines = [
		"## 项目简报（平台自动生成，结论需自行验证）",
		`- 项目：${project.name}`,
		`- 目标：${project.target}`,
		`- 授权范围：${(project.scope ?? []).join(", ") || project.target}`,
		`- 你的角色：${roleLabels[agent.role] ?? agent.role}（${agent.id}）`,
		`- 你的任务：${agent.objective}`,
	];

	if (agent.factIds?.length) {
		const selected = facts.filter((fact) => agent.factIds.includes(fact.id));
		if (selected.length) {
			lines.push("", "### 任务书指定的事实");
			for (const fact of selected) {
				lines.push(formatFact(fact));
			}
		}
	}

	lines.push("", recentFacts.length ? "### 项目事实库（最近 12 条）" : "### 项目事实库（空）");
	for (const fact of recentFacts) lines.push(formatFact(fact));

	const activeSiblings = siblings.filter((item) => item.role !== "commander");
	if (activeSiblings.length) {
		lines.push("", "### 同级 agent");
		for (const sibling of activeSiblings) {
			lines.push(`- ${sibling.id}（${roleLabels[sibling.role] ?? sibling.role}）状态=${sibling.status} 任务=${truncate(sibling.objective, 60)}`);
		}
	}

	lines.push(
		"",
		"### 纪律",
		"- 只写有实际执行证据的事实；没有验证的内容标注「未验证」。",
		"- 事实要可复用：URL、参数、命令、响应特征写清楚。",
		"- 不要重复已经确认过的内容。",
	);
	return lines.join("\n");
}

function formatFact(fact) {
	return `- ${fact.id} [${KIND_LABELS[fact.kind] ?? fact.kind}] ${fact.title}（置信度 ${fact.confidence}）\n  ${truncate(JSON.stringify(fact.value), 220)}`;
}

function truncate(text, max) {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}
