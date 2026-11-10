const ROLE_LABELS = { commander: "指挥官", recon: "侦察员", jwt: "JWT 专家" };
const ROLE_ICONS = { commander: "◆", recon: "◎", jwt: "⬡" };

function Node({ agent, agents, depth, selectedId, onSelect }) {
	const children = agents.filter((item) => item.parentId === agent.id);
	return (
		<>
			<button
				className={`agent-row ${selectedId === agent.id ? "active" : ""}`}
				style={{ paddingLeft: 12 + depth * 16 }}
				onClick={() => onSelect(agent.id)}
				title={agent.objective}
			>
				<span className={`dot ${agent.status}`} />
				<span className="agent-role">
					<span className="agent-icon">{ROLE_ICONS[agent.role] ?? "•"}</span>
					{ROLE_LABELS[agent.role] ?? agent.role}
				</span>
				<span className="agent-id">{agent.id.replace("agent-", "#")}</span>
			</button>
			{children.map((child) => (
				<Node
					key={child.id}
					agent={child}
					agents={agents}
					depth={depth + 1}
					selectedId={selectedId}
					onSelect={onSelect}
				/>
			))}
		</>
	);
}

export function AgentList({ agents, selectedId, onSelect }) {
	if (!agents.length) return <div className="list-empty">暂无 agent</div>;
	const roots = agents.filter((agent) => !agent.parentId);
	return (
		<div className="agent-list">
			{roots.map((root) => (
				<Node key={root.id} agent={root} agents={agents} depth={0} selectedId={selectedId} onSelect={onSelect} />
			))}
		</div>
	);
}
