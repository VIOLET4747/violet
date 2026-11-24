/**
 * M4：证据链与反捏造
 *
 * - http_send：平台代发 HTTP，请求/响应原文落 artifact（sha256），返回摘录 + artifact id
 * - finding 闸门：schema 校验 + 证据反查（同项目、必须有 http-response artifact）+ scope + 去重
 * - verifier：用新证据重放，自动比对 poc.expect，PASS → verified，FAIL → disputed
 * - coverage：confirmed / ruled_out / open_proof_gap 三态账本，ruled_out 必须写控制点
 */
import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME } from "./config.mjs";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);
const EXPECT_MATCH = new Set(["status", "body_regex", "header_regex"]);
const COVERAGE_OUTCOMES = new Set(["confirmed", "ruled_out", "open_proof_gap"]);
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…[截断 ${text.length - max} 字符]` : text);

export class EvidenceService {
	constructor({ store, broadcast }) {
		this.store = store;
		this.broadcast = broadcast;
	}

	/* ------------------------------ HTTP 证据 ------------------------------ */

	isInScope(project, rawUrl) {
		let target;
		try {
			target = new URL(rawUrl);
		} catch {
			return false;
		}
		if (!["http:", "https:"].includes(target.protocol)) return false;
		const scopes = [...(project.scope ?? []), project.target].filter(Boolean);
		for (const scope of scopes) {
			let allowed;
			try {
				allowed = new URL(scope);
			} catch {
				continue;
			}
			if (allowed.hostname !== target.hostname) continue;
			const allowedPort = allowed.port || (allowed.protocol === "https:" ? "443" : "80");
			const targetPort = target.port || (target.protocol === "https:" ? "443" : "80");
			if (allowedPort === targetPort) return true;
		}
		return false;
	}

	writeArtifact({ projectId, agentId, kind, title, text, meta }) {
		const dir = join(RUNTIME, "projects", projectId, "artifacts");
		mkdirSync(dir, { recursive: true });
		const file = `${kind}-${Date.now().toString(36)}-${createHash("sha1").update(text).digest("hex").slice(0, 8)}.log`;
		const path = join(dir, file);
		writeFileSync(path, text, "utf8");
		return this.store.addArtifact({
			projectId,
			agentId,
			kind,
			title,
			path,
			bytes: Buffer.byteLength(text, "utf8"),
			sha256: createHash("sha256").update(text).digest("hex"),
			meta,
		});
	}

	async httpSend({ projectId, agentId, method = "GET", url, headers = {}, body, timeoutMs = 20_000, maxBytes = DEFAULT_MAX_BYTES }) {
		const project = this.store.getProject(projectId);
		if (!project) throw new Error(`项目不存在: ${projectId}`);
		const verb = String(method).toUpperCase();
		if (!METHODS.has(verb)) throw new Error(`不支持的 HTTP 方法: ${verb}`);
		if (!this.isInScope(project, url)) throw new Error(`目标不在授权范围内: ${url}（scope: ${project.scope.join(", ")}）`);

		const finalHeaders = {};
		for (const [key, value] of Object.entries(headers ?? {})) {
			if (["host", "content-length", "connection"].includes(key.toLowerCase())) continue;
			finalHeaders[key] = String(value);
		}
		const bodyText = body === undefined || body === null ? "" : String(body);
		if (bodyText) finalHeaders["content-length"] = String(Buffer.byteLength(bodyText, "utf8"));

		const started = Date.now();
		const result = await sendHttp({ url, method: verb, headers: finalHeaders, body: bodyText, timeoutMs, maxBytes });
		const durationMs = Date.now() - started;

		// 先落请求/响应 artifact，再补 exchange 关联
		const requestDump = buildRequestDump({ method: verb, url, headers: finalHeaders, body: bodyText });
		const requestArtifact = this.writeArtifact({
			projectId,
			agentId,
			kind: "http-request",
			title: `${verb} ${url}`,
			text: requestDump,
			meta: { role: "request", method: verb, url },
		});

		let responseArtifact = null;
		let responseDump = "";
		if (!result.error) {
			responseDump = buildResponseDump(result);
			responseArtifact = this.writeArtifact({
				projectId,
				agentId,
				kind: "http-response",
				title: `${result.status} ${url}`,
				text: responseDump,
				meta: { role: "response", status: result.status, url },
			});
		}

		const exchange = this.store.addExchange({
			projectId,
			agentId,
			method: verb,
			url,
			requestHeaders: finalHeaders,
			requestBody: clip(bodyText, 8000),
			status: result.status ?? null,
			responseHeaders: result.headers ?? {},
			responseBody: clip(result.bodyText ?? "", 8000),
			durationMs,
			error: result.error ?? null,
		});
		this.store.updateExchangeArtifacts(exchange.id, requestArtifact.id, responseArtifact?.id ?? null);

		const updated = this.store.getExchange(exchange.id);
		this.broadcast?.({ projectId, agentId, type: "exchange.created", payload: { exchange: updated } });

		return {
			exchangeId: exchange.id,
			status: result.status ?? null,
			headers: result.headers ?? {},
			bodyExcerpt: clip(result.bodyText ?? "", 3000),
			artifactIds: [requestArtifact.id, responseArtifact?.id].filter(Boolean),
			requestArtifact: requestArtifact.id,
			responseArtifact: responseArtifact?.id ?? null,
			durationMs,
			error: result.error ?? null,
		};
	}

	exchangeForArtifact(projectId, artifactId) {
		const artifact = this.store.getArtifact(artifactId);
		if (!artifact || artifact.projectId !== projectId) return null;
		const exchanges = this.store.listExchanges(projectId);
		return (
			exchanges.find((item) => item.requestArtifact === artifactId || item.responseArtifact === artifactId) ?? null
		);
	}

	/* ------------------------------ Finding 闸门 ------------------------------ */

	validateFindingInput(project, input) {
		const errors = [];
		const text = (value) => (typeof value === "string" ? value.trim() : "");
		const need = (name, value, min) => {
			if (text(value).length < min) errors.push(`${name} 至少 ${min} 字符`);
		};

		need("title", input.title, 8);
		need("category", input.category, 2);
		if (!SEVERITIES.has(input.severity)) errors.push("severity 必须是 critical/high/medium/low/info");
		need("target", input.target, 4);
		need("summary", input.summary, 20);
		need("technical_analysis", input.technical_analysis, 30);
		need("impact", input.impact, 20);
		need("counterevidence", input.counterevidence, 10);
		if (!CONFIDENCE.has(input.confidence)) errors.push("confidence 必须是 high/medium/low");
		need("confidence_rationale", input.confidence_rationale, 10);
		if (!Array.isArray(input.preconditions)) errors.push("preconditions 必须是数组");
		if (!Array.isArray(input.evidence_ids) || input.evidence_ids.length === 0) {
			errors.push("evidence_ids 至少 1 个");
		}

		const poc = input.poc ?? {};
		if (!["http", "script", "manual"].includes(poc.type)) errors.push("poc.type 必须是 http/script/manual");
		if (!Array.isArray(poc.steps) || poc.steps.length === 0) errors.push("poc.steps 至少 1 条");
		if (!poc.expect || !EXPECT_MATCH.has(poc.expect.match)) {
			errors.push("poc.expect.match 必须是 status/body_regex/header_regex");
		}
		if (poc.expect && text(poc.expect.value).length === 0) errors.push("poc.expect.value 不能为空");
		if (poc.request_artifact_ids && !Array.isArray(poc.request_artifact_ids)) {
			errors.push("poc.request_artifact_ids 必须是数组");
		}

		if (errors.length) {
			const error = new Error(`finding 被拒绝：\n- ${errors.join("\n- ")}`);
			error.code = "FINDING_INVALID";
			error.details = errors;
			throw error;
		}

		if (!this.isInScope(project, input.target)) {
			const error = new Error(`finding 被拒绝：target 不在授权范围内（${input.target}）`);
			error.code = "FINDING_SCOPE";
			throw error;
		}
		return true;
	}

	async submitFinding({ projectId, agentId, input }) {
		const project = this.store.getProject(projectId);
		if (!project) throw new Error(`项目不存在: ${projectId}`);
		this.validateFindingInput(project, input);

		// 证据反查：必须真实存在、同项目、且至少一条是 HTTP 响应原文
		const artifacts = [];
		for (const artifactId of input.evidence_ids) {
			const artifact = this.store.getArtifact(artifactId);
			if (!artifact) {
				const error = new Error(`finding 被拒绝：证据 ${artifactId} 不存在`);
				error.code = "FINDING_EVIDENCE_MISSING";
				throw error;
			}
			if (artifact.projectId !== projectId) {
				const error = new Error(`finding 被拒绝：证据 ${artifactId} 不属于本项目`);
				error.code = "FINDING_EVIDENCE_FOREIGN";
				throw error;
			}
			artifacts.push(artifact);
		}
		if (!artifacts.some((artifact) => artifact.kind === "http-response")) {
			const error = new Error("finding 被拒绝：至少需要一条 http-response 证据（请先用 http_send 发请求）");
			error.code = "FINDING_NO_HTTP_EVIDENCE";
			throw error;
		}
		for (const artifactId of input.poc?.request_artifact_ids ?? []) {
			if (!input.evidence_ids.includes(artifactId)) {
				const error = new Error(`finding 被拒绝：poc.request_artifact_ids 中的 ${artifactId} 不在 evidence_ids 里`);
				error.code = "FINDING_POC_MISMATCH";
				throw error;
			}
		}

		const dedupeKey = `${String(input.target).toLowerCase()}|${String(input.category).toLowerCase()}|${String(input.title)
			.trim()
			.toLowerCase()}`;
		const existing = this.store.findFindingByDedupe(projectId, dedupeKey);
		if (existing) {
			return { duplicate_of: existing.id, finding: existing };
		}

		const finding = this.store.addFinding({
			projectId,
			dedupeKey,
			title: input.title.trim(),
			category: input.category.trim(),
			severity: input.severity,
			target: input.target.trim(),
			summary: input.summary.trim(),
			technicalAnalysis: input.technical_analysis.trim(),
			impact: input.impact.trim(),
			preconditions: input.preconditions,
			counterevidence: input.counterevidence.trim(),
			severityChangeConditions: input.severity_change_conditions ?? "",
			confidence: input.confidence,
			confidenceRationale: input.confidence_rationale.trim(),
			poc: {
				type: input.poc.type,
				steps: input.poc.steps,
				expect: input.poc.expect,
				request_artifact_ids: input.poc.request_artifact_ids ?? [],
				script: input.poc.script ?? "",
			},
			foundBy: agentId ?? null,
		});
		for (const artifact of artifacts) {
			this.store.addFindingEvidence(finding.id, artifact.id, artifact.kind === "http-response" ? "response" : "request");
		}
		this.broadcast?.({ projectId, agentId, type: "finding.created", payload: { finding } });
		return { finding };
	}

	/* ------------------------------ Verifier ------------------------------ */

	evaluateExpect(finding, exchanges) {
		const expect = finding.poc?.expect ?? {};
		const detail = { match: expect.match, value: expect.value, checked: exchanges.length };
		if (!EXPECT_MATCH.has(expect.match)) return { matched: false, detail: { ...detail, error: "不支持的 expect" } };
		for (const exchange of exchanges) {
			const value = String(expect.value ?? "");
			if (expect.match === "status") {
				if (String(exchange.status) === value) return { matched: true, detail: { ...detail, exchange: exchange.id } };
			} else if (expect.match === "body_regex") {
				let regex;
				try {
					regex = new RegExp(value);
				} catch {
					return { matched: false, detail: { ...detail, error: "正则有误" } };
				}
				if (regex.test(exchange.responseBody ?? "")) return { matched: true, detail: { ...detail, exchange: exchange.id } };
			} else if (expect.match === "header_regex") {
				let regex;
				try {
					regex = new RegExp(value, "i");
				} catch {
					return { matched: false, detail: { ...detail, error: "正则有误" } };
				}
				if (regex.test(JSON.stringify(exchange.responseHeaders ?? {}))) {
					return { matched: true, detail: { ...detail, exchange: exchange.id } };
				}
			}
		}
		return { matched: false, detail };
	}

	async verifyFinding({ projectId, agentId, findingId, evidenceIds, verdict, rationale = "" }) {
		const finding = this.store.getFinding(findingId);
		if (!finding || finding.projectId !== projectId) throw new Error(`finding 不存在: ${findingId}`);
		if (!["candidate", "verifying"].includes(finding.status)) {
			throw new Error(`finding 当前状态 ${finding.status} 不能验证`);
		}
		if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) throw new Error("验证需要提供新证据 artifact id");
		if (!["verified", "disputed"].includes(verdict)) throw new Error("verdict 必须是 verified 或 disputed");

		const existing = new Set(this.store.listFindingEvidence(findingId).map((row) => row.artifact_id));
		const exchanges = [];
		for (const artifactId of evidenceIds) {
			if (existing.has(artifactId)) {
				throw new Error(`证据 ${artifactId} 已被原 finding 使用，验证必须使用独立的新证据`);
			}
			const exchange = this.exchangeForArtifact(projectId, artifactId);
			if (!exchange) {
				throw new Error(`证据 ${artifactId} 不是本项目的 HTTP 证据，不能用于验证`);
			}
			exchanges.push(exchange);
		}

		const evaluation = this.evaluateExpect(finding, exchanges);
		const status = verdict === "verified" && evaluation.matched ? "verified" : "disputed";
		const note = evaluation.matched
			? verdict === "verified"
				? "重放命中 expect"
				: "重放命中 expect，但 verifier 判定 disputed"
			: `重放未命中 expect（${JSON.stringify(evaluation.detail)}）`;
		const updated = this.store.setFindingStatus({
			id: findingId,
			status,
			verifiedBy: agentId ?? null,
			verifiedAt: Date.now(),
		});
		for (const artifactId of evidenceIds) this.store.addFindingEvidence(findingId, artifactId, "replay");
		this.broadcast?.({ projectId, agentId, type: "finding.updated", payload: { finding: updated } });
		return { finding: updated, evaluation, note, rationale };
	}

	/* ------------------------------ Coverage ------------------------------ */

	async updateCoverage({ projectId, agentId, input }) {
		const project = this.store.getProject(projectId);
		if (!project) throw new Error(`项目不存在: ${projectId}`);
		const testClass = String(input.test_class ?? "").trim();
		if (testClass.length < 2) throw new Error("test_class 至少 2 字符");
		if (!COVERAGE_OUTCOMES.has(input.outcome)) {
			throw new Error("outcome 必须是 confirmed / ruled_out / open_proof_gap");
		}
		const controlPoint = String(input.control_point ?? "").trim();
		if (input.outcome === "ruled_out" && controlPoint.length < 5) {
			throw new Error("ruled_out 必须写 control_point（具体控制点，如文件:行号 / WAF 规则 id），说不出来只能记 open_proof_gap");
		}
		const evidenceIds = Array.isArray(input.evidence_ids) ? input.evidence_ids : [];
		for (const artifactId of evidenceIds) {
			const artifact = this.store.getArtifact(artifactId);
			if (!artifact || artifact.projectId !== projectId) throw new Error(`证据 ${artifactId} 不存在或不属于本项目`);
		}
		const coverage = this.store.upsertCoverage({
			projectId,
			testClass,
			target: input.target ?? project.target,
			outcome: input.outcome,
			controlPoint,
			rationale: input.rationale ?? "",
			evidenceIds,
			updatedBy: agentId ?? null,
		});
		this.broadcast?.({ projectId, agentId, type: "coverage.updated", payload: { coverage } });
		return coverage;
	}

	/* ------------------------------ 查询 ------------------------------ */

	findingDetail(findingId) {
		const finding = this.store.getFinding(findingId);
		if (!finding) return null;
		const evidence = this.store.listFindingEvidence(findingId).map((row) => {
			const artifact = this.store.getArtifact(row.artifact_id);
			const exchange = artifact ? this.exchangeForArtifact(finding.projectId, artifact.id) : null;
			return {
				role: row.role,
				artifact,
				exchange,
				curl: exchange ? this.curlForExchange(exchange) : null,
			};
		});
		return { finding, evidence };
	}

	listFindings(projectId) {
		return this.store.listFindings(projectId).map((finding) => {
			const evidenceCount = this.store.listFindingEvidence(finding.id).length;
			return { ...finding, evidenceCount };
		});
	}

	curlForExchange(exchange) {
		const parts = [`curl -s -i -X ${exchange.method} '${exchange.url}'`];
		for (const [key, value] of Object.entries(exchange.requestHeaders ?? {})) {
			if (key.toLowerCase() === "content-length") continue;
			parts.push(`  -H '${key}: ${String(value).replace(/'/g, "'\\''")}'`);
		}
		if (exchange.requestBody) parts.push(`  --data '${String(exchange.requestBody).replace(/'/g, "'\\''")}'`);
		return parts.join(" \\\n");
	}
}

/* ------------------------------ 底层 HTTP ------------------------------ */

function sendHttp({ url, method, headers, body, timeoutMs, maxBytes }) {
	return new Promise((resolve) => {
		let parsed;
		try {
			parsed = new URL(url);
		} catch (error) {
			resolve({ error: `URL 无效: ${String(error?.message ?? error)}` });
			return;
		}
		const transport = parsed.protocol === "https:" ? https : http;
		const request = transport.request(
			parsed,
			{ method, headers },
			(response) => {
				const chunks = [];
				let size = 0;
				let truncated = false;
				response.on("data", (chunk) => {
					size += chunk.length;
					if (size <= maxBytes) chunks.push(chunk);
					else truncated = true;
				});
				response.on("end", () => {
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						bodyText: Buffer.concat(chunks).toString("utf8"),
						truncated,
					});
				});
				response.on("error", (error) => resolve({ error: String(error?.message ?? error) }));
			},
		);
		request.setTimeout(timeoutMs, () => {
			request.destroy(new Error(`请求超时（${timeoutMs}ms）`));
		});
		request.on("error", (error) => resolve({ error: String(error?.message ?? error) }));
		if (body) request.write(body);
		request.end();
	});
}

function buildRequestDump({ method, url, headers, body }) {
	const parsed = new URL(url);
	const lines = [`${method} ${parsed.pathname}${parsed.search} HTTP/1.1`, `Host: ${parsed.host}`];
	for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
	lines.push("", body ?? "");
	return lines.join("\r\n");
}

function buildResponseDump(result) {
	const lines = [`HTTP/1.1 ${result.status}`];
	for (const [key, value] of Object.entries(result.headers ?? {})) {
		lines.push(`${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
	}
	lines.push("", result.bodyText ?? "");
	return lines.join("\r\n");
}
