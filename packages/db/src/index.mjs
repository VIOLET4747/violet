/**
 * M1 领域库：node:sqlite（Node 内置，零依赖）。
 *
 * 表：project / agent_run / agent_event / fact
 * 事件表同时承担"实时广播的回放源"和"审计日志"，SSE 断线用 after=<id> 补发。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS project (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	target TEXT NOT NULL,
	scope TEXT NOT NULL DEFAULT '[]',
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_run (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	parent_id TEXT,
	role TEXT NOT NULL,
	objective TEXT NOT NULL,
	targets TEXT NOT NULL DEFAULT '[]',
	fact_ids TEXT NOT NULL DEFAULT '[]',
	status TEXT NOT NULL DEFAULT 'starting',
	model TEXT,
	session_file TEXT,
	tokens_in INTEGER NOT NULL DEFAULT 0,
	tokens_out INTEGER NOT NULL DEFAULT 0,
	cost REAL NOT NULL DEFAULT 0,
	turns INTEGER NOT NULL DEFAULT 0,
	error TEXT,
	created_at INTEGER NOT NULL,
	started_at INTEGER,
	ended_at INTEGER,
	reported_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_project ON agent_run(project_id, created_at);

CREATE TABLE IF NOT EXISTS agent_event (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	project_id TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	type TEXT NOT NULL,
	payload TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_project ON agent_event(project_id, id);
CREATE INDEX IF NOT EXISTS idx_event_agent ON agent_event(agent_id, id);

CREATE TABLE IF NOT EXISTS fact (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	kind TEXT NOT NULL,
	title TEXT NOT NULL,
	value TEXT NOT NULL DEFAULT '{}',
	confidence REAL NOT NULL DEFAULT 0.5,
	status TEXT NOT NULL DEFAULT 'candidate',
	source_agent TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fact_project ON fact(project_id, seq);
`;

const now = () => Date.now();

export function openStore(path) {
	mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec(SCHEMA);

	const stmts = {
		insertProject: db.prepare(
			"INSERT INTO project (id, name, target, scope, created_at) VALUES (?, ?, ?, ?, ?)",
		),
		getProject: db.prepare("SELECT * FROM project WHERE id = ?"),
		listProjects: db.prepare("SELECT * FROM project ORDER BY created_at DESC"),

		insertAgent: db.prepare(
			`INSERT INTO agent_run
			 (id, project_id, parent_id, role, objective, targets, fact_ids, status, model, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		),
		getAgent: db.prepare("SELECT * FROM agent_run WHERE id = ?"),
		listAgents: db.prepare("SELECT * FROM agent_run WHERE project_id = ? ORDER BY created_at ASC"),
		updateAgent: db.prepare(
			`UPDATE agent_run SET status = ?, session_file = ?, tokens_in = ?, tokens_out = ?,
			 cost = ?, turns = ?, error = ?, started_at = COALESCE(started_at, ?),
			 ended_at = ?, reported_at = ? WHERE id = ?`,
		),

		insertEvent: db.prepare(
			"INSERT INTO agent_event (project_id, agent_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)",
		),
		eventsAfter: db.prepare(
			"SELECT * FROM agent_event WHERE project_id = ? AND id > ? ORDER BY id ASC LIMIT 500",
		),
		eventsForAgent: db.prepare(
			"SELECT * FROM agent_event WHERE agent_id = ? AND id > ? ORDER BY id ASC LIMIT 2000",
		),

		insertFact: db.prepare(
			`INSERT INTO fact (id, project_id, seq, kind, title, value, confidence, status, source_agent, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)`,
		),
		listFacts: db.prepare("SELECT * FROM fact WHERE project_id = ? ORDER BY seq ASC"),
		getFact: db.prepare("SELECT * FROM fact WHERE id = ?"),
		factsByAgent: db.prepare("SELECT * FROM fact WHERE project_id = ? AND source_agent = ? ORDER BY seq ASC"),
		maxFactSeq: db.prepare("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM fact WHERE project_id = ?"),
	};

	return {
		raw: db,
		close: () => db.close(),

		createProject({ id, name, target, scope = [] }) {
			stmts.insertProject.run(id, name, target, JSON.stringify(scope), now());
			return this.getProject(id);
		},
		getProject(id) {
			const row = stmts.getProject.get(id);
			return row ? parseProject(row) : undefined;
		},
		listProjects() {
			return stmts.listProjects.all().map(parseProject);
		},

		createAgent(agent) {
			stmts.insertAgent.run(
				agent.id,
				agent.projectId,
				agent.parentId ?? null,
				agent.role,
				agent.objective,
				JSON.stringify(agent.targets ?? []),
				JSON.stringify(agent.factIds ?? []),
				agent.status ?? "starting",
				agent.model ?? null,
				now(),
			);
			return this.getAgent(agent.id);
		},
		getAgent(id) {
			const row = stmts.getAgent.get(id);
			return row ? parseAgent(row) : undefined;
		},
		listAgents(projectId) {
			return stmts.listAgents.all(projectId).map(parseAgent);
		},
		saveAgent(agent) {
			stmts.updateAgent.run(
				agent.status,
				agent.sessionFile ?? null,
				agent.tokensIn ?? 0,
				agent.tokensOut ?? 0,
				agent.cost ?? 0,
				agent.turns ?? 0,
				agent.error ?? null,
				agent.startedAt ?? null,
				agent.endedAt ?? null,
				agent.reportedAt ?? null,
				agent.id,
			);
			return this.getAgent(agent.id);
		},

		appendEvent({ projectId, agentId, type, payload }) {
			const createdAt = now();
			const result = stmts.insertEvent.run(projectId, agentId, type, JSON.stringify(payload ?? {}), createdAt);
			return {
				id: Number(result.lastInsertRowid),
				projectId,
				agentId,
				type,
				payload: payload ?? {},
				createdAt,
			};
		},
		eventsAfter(projectId, afterId = 0) {
			return stmts.eventsAfter.all(projectId, afterId).map(parseEvent);
		},
		eventsForAgent(agentId, afterId = 0) {
			return stmts.eventsForAgent.all(agentId, afterId).map(parseEvent);
		},

		addFact(fact) {
			const seq = (stmts.maxFactSeq.get(fact.projectId)?.maxSeq ?? 0) + 1;
			const id = fact.id ?? `fact-${String(seq).padStart(4, "0")}`;
			stmts.insertFact.run(
				id,
				fact.projectId,
				seq,
				fact.kind,
				fact.title,
				JSON.stringify(fact.value ?? {}),
				fact.confidence ?? 0.5,
				fact.sourceAgent ?? null,
				now(),
			);
			return this.getFact(id);
		},
		getFact(id) {
			const row = stmts.getFact.get(id);
			return row ? parseFact(row) : undefined;
		},
		listFacts(projectId) {
			return stmts.listFacts.all(projectId).map(parseFact);
		},
		factsByAgent(projectId, agentId) {
			return stmts.factsByAgent.all(projectId, agentId).map(parseFact);
		},
	};
}

function parseProject(row) {
	return { ...row, scope: safeJson(row.scope, []) };
}

function parseAgent(row) {
	return {
		...row,
		projectId: row.project_id,
		parentId: row.parent_id,
		factIds: safeJson(row.fact_ids, []),
		targets: safeJson(row.targets, []),
		tokensIn: row.tokens_in,
		tokensOut: row.tokens_out,
		sessionFile: row.session_file,
		createdAt: row.created_at,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		reportedAt: row.reported_at,
	};
}

function parseEvent(row) {
	return {
		id: row.id,
		projectId: row.project_id,
		agentId: row.agent_id,
		type: row.type,
		payload: safeJson(row.payload, {}),
		createdAt: row.created_at,
	};
}

function parseFact(row) {
	return {
		...row,
		projectId: row.project_id,
		sourceAgent: row.source_agent,
		createdAt: row.created_at,
		value: safeJson(row.value, {}),
	};
}

function safeJson(text, fallback) {
	if (text === null || text === undefined || text === "") return fallback;
	try {
		return JSON.parse(text);
	} catch {
		return fallback;
	}
}
