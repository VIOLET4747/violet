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

CREATE TABLE IF NOT EXISTS artifact (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	agent_id TEXT,
	kind TEXT NOT NULL DEFAULT 'tool-output',
	title TEXT,
	path TEXT NOT NULL,
	bytes INTEGER NOT NULL DEFAULT 0,
	sha256 TEXT,
	meta TEXT NOT NULL DEFAULT '{}',
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifact_project ON artifact(project_id, created_at);

-- M4：HTTP 证据（一次请求/响应原文）
CREATE TABLE IF NOT EXISTS http_exchange (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	agent_id TEXT,
	method TEXT NOT NULL,
	url TEXT NOT NULL,
	request_headers TEXT NOT NULL DEFAULT '{}',
	request_body TEXT,
	status INTEGER,
	response_headers TEXT NOT NULL DEFAULT '{}',
	response_body TEXT,
	request_artifact TEXT,
	response_artifact TEXT,
	duration_ms INTEGER,
	error TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exchange_project ON http_exchange(project_id, created_at);

-- M4：漏洞（候选 → 已验证）
CREATE TABLE IF NOT EXISTS finding (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	dedupe_key TEXT NOT NULL,
	title TEXT NOT NULL,
	category TEXT NOT NULL,
	severity TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'candidate',
	target TEXT,
	summary TEXT,
	technical_analysis TEXT,
	impact TEXT,
	preconditions TEXT NOT NULL DEFAULT '[]',
	counterevidence TEXT,
	severity_change_conditions TEXT,
	confidence TEXT,
	confidence_rationale TEXT,
	poc TEXT NOT NULL DEFAULT '{}',
	found_by TEXT,
	verified_by TEXT,
	verified_at INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_finding_dedupe ON finding(project_id, dedupe_key);

-- M7：工具审批队列
CREATE TABLE IF NOT EXISTS approval (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	agent_id TEXT,
	tool TEXT NOT NULL,
	args TEXT NOT NULL DEFAULT '{}',
	risk TEXT NOT NULL DEFAULT 'high',
	reason TEXT,
	status TEXT NOT NULL DEFAULT 'pending',
	decided_by TEXT,
	decided_at INTEGER,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_project ON approval(project_id, created_at);

CREATE TABLE IF NOT EXISTS finding_evidence (
	finding_id TEXT NOT NULL,
	artifact_id TEXT NOT NULL,
	role TEXT NOT NULL DEFAULT 'request',
	PRIMARY KEY (finding_id, artifact_id)
);

-- M4：覆盖率账本（confirmed / ruled_out / open_proof_gap）
CREATE TABLE IF NOT EXISTS coverage (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	test_class TEXT NOT NULL,
	target TEXT NOT NULL DEFAULT '',
	outcome TEXT NOT NULL,
	control_point TEXT,
	rationale TEXT,
	evidence_ids TEXT NOT NULL DEFAULT '[]',
	updated_by TEXT,
	updated_at INTEGER NOT NULL,
	UNIQUE(project_id, test_class, target)
);
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
		maxFactSeq: db.prepare("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM fact"),

		deleteProject: db.prepare("DELETE FROM project WHERE id = ?"),
		deleteProjectFacts: db.prepare("DELETE FROM fact WHERE project_id = ?"),
		deleteProjectEvents: db.prepare("DELETE FROM agent_event WHERE project_id = ?"),
		deleteProjectAgents: db.prepare("DELETE FROM agent_run WHERE project_id = ?"),
		deleteProjectArtifacts: db.prepare("DELETE FROM artifact WHERE project_id = ?"),

		insertArtifact: db.prepare(
			`INSERT INTO artifact (id, project_id, agent_id, kind, title, path, bytes, sha256, meta, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		),
		getArtifact: db.prepare("SELECT * FROM artifact WHERE id = ?"),
		listArtifacts: db.prepare("SELECT * FROM artifact WHERE project_id = ? ORDER BY created_at ASC"),
		maxArtifactSeq: db.prepare("SELECT COUNT(*) AS count FROM artifact"),

		insertExchange: db.prepare(
			`INSERT INTO http_exchange
			 (id, project_id, agent_id, method, url, request_headers, request_body, status, response_headers, response_body, request_artifact, response_artifact, duration_ms, error, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		),
		getExchange: db.prepare("SELECT * FROM http_exchange WHERE id = ?"),
		listExchanges: db.prepare("SELECT * FROM http_exchange WHERE project_id = ? ORDER BY created_at ASC"),
		countExchanges: db.prepare("SELECT COUNT(*) AS count FROM http_exchange"),
		updateExchangeArtifacts: db.prepare(
			"UPDATE http_exchange SET request_artifact = ?, response_artifact = ? WHERE id = ?",
		),

		insertFinding: db.prepare(
			`INSERT INTO finding
			 (id, project_id, dedupe_key, title, category, severity, status, target, summary, technical_analysis, impact,
			  preconditions, counterevidence, severity_change_conditions, confidence, confidence_rationale, poc, found_by,
			  created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		),
		getFinding: db.prepare("SELECT * FROM finding WHERE id = ?"),
		listFindings: db.prepare("SELECT * FROM finding WHERE project_id = ? ORDER BY created_at ASC"),
		findFindingByDedupe: db.prepare("SELECT * FROM finding WHERE project_id = ? AND dedupe_key = ?"),
		setFindingStatus: db.prepare("UPDATE finding SET status = ?, verified_by = ?, verified_at = ?, updated_at = ? WHERE id = ?"),
		countFindings: db.prepare("SELECT COUNT(*) AS count FROM finding"),
		insertFindingEvidence: db.prepare(
			"INSERT OR IGNORE INTO finding_evidence (finding_id, artifact_id, role) VALUES (?, ?, ?)",
		),
		listFindingEvidence: db.prepare("SELECT * FROM finding_evidence WHERE finding_id = ?"),
		countFindingEvidence: db.prepare("SELECT COUNT(*) AS count FROM finding_evidence"),

		insertCoverage: db.prepare(
			`INSERT INTO coverage (id, project_id, test_class, target, outcome, control_point, rationale, evidence_ids, updated_by, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		),
		getCoverage: db.prepare("SELECT * FROM coverage WHERE project_id = ? AND test_class = ? AND target = ?"),
		listCoverage: db.prepare("SELECT * FROM coverage WHERE project_id = ? ORDER BY test_class ASC"),
		updateCoverage: db.prepare(
			`UPDATE coverage SET outcome = ?, control_point = ?, rationale = ?, evidence_ids = ?, updated_by = ?, updated_at = ?
			 WHERE id = ?`,
		),
		countCoverage: db.prepare("SELECT COUNT(*) AS count FROM coverage"),
		deleteProjectFindings: db.prepare("DELETE FROM finding WHERE project_id = ?"),
		deleteProjectFindingEvidence: db.prepare(
			"DELETE FROM finding_evidence WHERE finding_id IN (SELECT id FROM finding WHERE project_id = ?)",
		),
		deleteProjectCoverage: db.prepare("DELETE FROM coverage WHERE project_id = ?"),
		deleteProjectExchanges: db.prepare("DELETE FROM http_exchange WHERE project_id = ?"),
		deleteProjectApprovals: db.prepare("DELETE FROM approval WHERE project_id = ?"),

		insertApproval: db.prepare(
			`INSERT INTO approval (id, project_id, agent_id, tool, args, risk, reason, status, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
		),
		getApproval: db.prepare("SELECT * FROM approval WHERE id = ?"),
		listApprovals: db.prepare("SELECT * FROM approval WHERE project_id = ? ORDER BY created_at ASC"),
		listAllApprovals: db.prepare("SELECT * FROM approval ORDER BY created_at ASC"),
		decideApproval: db.prepare(
			"UPDATE approval SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
		),
		countApprovals: db.prepare("SELECT COUNT(*) AS count FROM approval"),
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
		deleteProject(id) {
			stmts.deleteProjectFindingEvidence.run(id);
			stmts.deleteProjectFindings.run(id);
			stmts.deleteProjectCoverage.run(id);
			stmts.deleteProjectExchanges.run(id);
			stmts.deleteProjectFacts.run(id);
			stmts.deleteProjectEvents.run(id);
			stmts.deleteProjectAgents.run(id);
			stmts.deleteProjectArtifacts.run(id);
			stmts.deleteProjectApprovals.run(id);
			stmts.deleteProject.run(id);
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
			// fact.id 是全局主键，所以 seq 必须全局递增（不能按项目各自从 1 开始，否则第二个项目必然撞主键）
			if (fact.id) {
				stmts.insertFact.run(
					fact.id,
					fact.projectId,
					fact.seq ?? 0,
					fact.kind,
					fact.title,
					JSON.stringify(fact.value ?? {}),
					fact.confidence ?? 0.5,
					fact.sourceAgent ?? null,
					now(),
				);
				return this.getFact(fact.id);
			}

			for (let attempt = 0; attempt < 5; attempt++) {
				const seq = (stmts.maxFactSeq.get()?.maxSeq ?? 0) + 1;
				const id = `fact-${String(seq).padStart(4, "0")}`;
				try {
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
				} catch (error) {
					// 理论上单进程不会撞；多进程/并发写时重算一次
					if (!String(error?.message ?? "").includes("UNIQUE") || attempt === 4) throw error;
				}
			}
			throw new Error("无法分配 fact id");
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

		addArtifact(artifact) {
			const count = stmts.maxArtifactSeq.get()?.count ?? 0;
			const id = artifact.id ?? `art-${String(count + 1).padStart(4, "0")}`;
			stmts.insertArtifact.run(
				id,
				artifact.projectId,
				artifact.agentId ?? null,
				artifact.kind ?? "tool-output",
				artifact.title ?? null,
				artifact.path,
				artifact.bytes ?? 0,
				artifact.sha256 ?? null,
				JSON.stringify(artifact.meta ?? {}),
				now(),
			);
			return this.getArtifact(id);
		},
		getArtifact(id) {
			const row = stmts.getArtifact.get(id);
			return row ? parseArtifact(row) : undefined;
		},
		listArtifacts(projectId) {
			return stmts.listArtifacts.all(projectId).map(parseArtifact);
		},

		/* ---------------------------- M4：HTTP 证据 ---------------------------- */
		addExchange(exchange) {
			const count = stmts.countExchanges.get()?.count ?? 0;
			const id = exchange.id ?? `http-${String(count + 1).padStart(4, "0")}`;
			stmts.insertExchange.run(
				id,
				exchange.projectId,
				exchange.agentId ?? null,
				exchange.method,
				exchange.url,
				JSON.stringify(exchange.requestHeaders ?? {}),
				exchange.requestBody ?? null,
				exchange.status ?? null,
				JSON.stringify(exchange.responseHeaders ?? {}),
				exchange.responseBody ?? null,
				exchange.requestArtifact ?? null,
				exchange.responseArtifact ?? null,
				exchange.durationMs ?? null,
				exchange.error ?? null,
				now(),
			);
			return this.getExchange(id);
		},
		getExchange(id) {
			const row = stmts.getExchange.get(id);
			return row ? parseExchange(row) : undefined;
		},
		listExchanges(projectId) {
			return stmts.listExchanges.all(projectId).map(parseExchange);
		},
		updateExchangeArtifacts(id, requestArtifact, responseArtifact) {
			stmts.updateExchangeArtifacts.run(requestArtifact ?? null, responseArtifact ?? null, id);
			return this.getExchange(id);
		},

		/* ---------------------------- M4：Finding ---------------------------- */
		addFinding(finding) {
			const count = stmts.countFindings.get()?.count ?? 0;
			const id = finding.id ?? `finding-${String(count + 1).padStart(4, "0")}`;
			stmts.insertFinding.run(
				id,
				finding.projectId,
				finding.dedupeKey,
				finding.title,
				finding.category,
				finding.severity,
				finding.target ?? null,
				finding.summary ?? null,
				finding.technicalAnalysis ?? null,
				finding.impact ?? null,
				JSON.stringify(finding.preconditions ?? []),
				finding.counterevidence ?? null,
				finding.severityChangeConditions ?? null,
				finding.confidence ?? null,
				finding.confidenceRationale ?? null,
				JSON.stringify(finding.poc ?? {}),
				finding.foundBy ?? null,
				now(),
				now(),
			);
			return this.getFinding(id);
		},
		getFinding(id) {
			const row = stmts.getFinding.get(id);
			return row ? parseFinding(row) : undefined;
		},
		listFindings(projectId) {
			return stmts.listFindings.all(projectId).map(parseFinding);
		},
		findFindingByDedupe(projectId, dedupeKey) {
			const row = stmts.findFindingByDedupe.get(projectId, dedupeKey);
			return row ? parseFinding(row) : undefined;
		},
		setFindingStatus({ id, status, verifiedBy, verifiedAt }) {
			stmts.setFindingStatus.run(status, verifiedBy ?? null, verifiedAt ?? now(), now(), id);
			return this.getFinding(id);
		},
		addFindingEvidence(findingId, artifactId, role = "request") {
			stmts.insertFindingEvidence.run(findingId, artifactId, role);
		},
		listFindingEvidence(findingId) {
			return stmts.listFindingEvidence.all(findingId);
		},

		/* ---------------------------- M4：覆盖率 ---------------------------- */
		upsertCoverage(entry) {
			const target = entry.target ?? "";
			const existing = stmts.getCoverage.get(entry.projectId, entry.testClass, target);
			if (existing) {
				stmts.updateCoverage.run(
					entry.outcome,
					entry.controlPoint ?? null,
					entry.rationale ?? null,
					JSON.stringify(entry.evidenceIds ?? []),
					entry.updatedBy ?? null,
					now(),
					existing.id,
				);
				return this.getCoverage(entry.projectId, entry.testClass, target);
			}
			const count = stmts.countCoverage.get()?.count ?? 0;
			const id = `cov-${String(count + 1).padStart(4, "0")}`;
			stmts.insertCoverage.run(
				id,
				entry.projectId,
				entry.testClass,
				target,
				entry.outcome,
				entry.controlPoint ?? null,
				entry.rationale ?? null,
				JSON.stringify(entry.evidenceIds ?? []),
				entry.updatedBy ?? null,
				now(),
			);
			return this.getCoverage(entry.projectId, entry.testClass, target);
		},
		getCoverage(projectId, testClass, target = "") {
			const row = stmts.getCoverage.get(projectId, testClass, target);
			return row ? parseCoverage(row) : undefined;
		},
		listCoverage(projectId) {
			return stmts.listCoverage.all(projectId).map(parseCoverage);
		},

		/* ---------------------------- M7：审批 ---------------------------- */
		addApproval(approval) {
			const count = stmts.countApprovals.get()?.count ?? 0;
			const id = `ap-${String(count + 1).padStart(4, "0")}`;
			stmts.insertApproval.run(
				id,
				approval.projectId,
				approval.agentId ?? null,
				approval.tool,
				JSON.stringify(approval.args ?? {}),
				approval.risk ?? "high",
				approval.reason ?? null,
				now(),
			);
			return this.getApproval(id);
		},
		getApproval(id) {
			const row = stmts.getApproval.get(id);
			return row ? parseApproval(row) : undefined;
		},
		listApprovals(projectId) {
			return projectId
				? stmts.listApprovals.all(projectId).map(parseApproval)
				: stmts.listAllApprovals.all().map(parseApproval);
		},
		decideApproval({ id, status, decidedBy }) {
			stmts.decideApproval.run(status, decidedBy ?? "ui", now(), id);
			return this.getApproval(id);
		},
	};
}

function parseArtifact(row) {
	return {
		...row,
		projectId: row.project_id,
		agentId: row.agent_id,
		createdAt: row.created_at,
		meta: safeJson(row.meta, {}),
	};
}

function parseExchange(row) {
	return {
		...row,
		projectId: row.project_id,
		agentId: row.agent_id,
		requestHeaders: safeJson(row.request_headers, {}),
		responseHeaders: safeJson(row.response_headers, {}),
		requestArtifact: row.request_artifact,
		responseArtifact: row.response_artifact,
		durationMs: row.duration_ms,
		createdAt: row.created_at,
	};
}

function parseFinding(row) {
	return {
		...row,
		projectId: row.project_id,
		dedupeKey: row.dedupe_key,
		technicalAnalysis: row.technical_analysis,
		severityChangeConditions: row.severity_change_conditions,
		confidenceRationale: row.confidence_rationale,
		preconditions: safeJson(row.preconditions, []),
		poc: safeJson(row.poc, {}),
		foundBy: row.found_by,
		verifiedBy: row.verified_by,
		verifiedAt: row.verified_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function parseCoverage(row) {
	return {
		...row,
		projectId: row.project_id,
		testClass: row.test_class,
		controlPoint: row.control_point,
		evidenceIds: safeJson(row.evidence_ids, []),
		updatedBy: row.updated_by,
		updatedAt: row.updated_at,
	};
}

function parseApproval(row) {
	return {
		...row,
		projectId: row.project_id,
		agentId: row.agent_id,
		args: safeJson(row.args, {}),
		decidedBy: row.decided_by,
		decidedAt: row.decided_at,
		createdAt: row.created_at,
	};
}

/** M7：按项目聚合 agent 用量（成本面板用） */
export function usageByProject(store, projectId) {
	const agents = store.listAgents(projectId);
	return aggregateUsage(agents, projectId);
}

/** 通用聚合：agent 列表 → 项目/角色/agent 三级总额 */
export function aggregateUsage(agents, projectId) {
	const total = { tokensIn: 0, tokensOut: 0, cost: 0, turns: 0, agents: agents.length };
	const byRole = {};
	const byAgent = [];
	for (const agent of agents) {
		const tokensIn = agent.tokensIn ?? 0;
		const tokensOut = agent.tokensOut ?? 0;
		const cost = agent.cost ?? 0;
		total.tokensIn += tokensIn;
		total.tokensOut += tokensOut;
		total.cost += cost;
		total.turns += agent.turns ?? 0;
		const role = (byRole[agent.role] = byRole[agent.role] ?? { role: agent.role, agents: 0, tokensIn: 0, tokensOut: 0, cost: 0 });
		role.agents += 1;
		role.tokensIn += tokensIn;
		role.tokensOut += tokensOut;
		role.cost += cost;
		byAgent.push({
			id: agent.id,
			role: agent.role,
			status: agent.status,
			tokensIn,
			tokensOut,
			cost,
			turns: agent.turns ?? 0,
			model: agent.model,
			startedAt: agent.startedAt,
			endedAt: agent.endedAt,
		});
	}
	return { projectId, total, byRole: Object.values(byRole), byAgent };
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
