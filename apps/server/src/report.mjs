/**
 * M5：报告生成（DB 驱动，确定性渲染）
 *
 * 报告数据全部来自 DB（finding / coverage / artifact / exchange / fact / agent_run），
 * 模型只负责产生 finding，不参与报告渲染。
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RUNTIME } from "./config.mjs";

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const SEVERITY_LABELS = { critical: "严重", high: "高危", medium: "中危", low: "低危", info: "信息" };
const STATUS_LABELS = {
	candidate: "候选（未验证）",
	verifying: "验证中",
	verified: "已验证",
	disputed: "有争议",
	false_positive: "误报",
	fixed: "已修复",
};
const OUTCOME_LABELS = {
	confirmed: "已确认问题",
	ruled_out: "已排除（有控制点）",
	open_proof_gap: "证明缺口（未测/未排除）",
};

const REMEDIATION = [
	{ match: /jwt|token|auth|oauth|session/i, text: "使用强随机密钥并固定算法白名单；禁止 alg=none；服务端校验 iss/aud/exp 与签名；密钥轮换。" },
	{ match: /idor|越权|access.?control|authorization/i, text: "在服务端对每个对象做对象级鉴权（owner/tenant 校验），不要只依赖前端隐藏或路由权限。" },
	{ match: /info|disclosure|泄露|metadata|debug/i, text: "对敏感接口增加鉴权与最小化返回字段；移除堆栈、内部路径、密钥等调试信息。" },
	{ match: /sqli|sql/i, text: "使用参数化查询/ORM 绑定变量；禁止拼接 SQL；最小权限数据库账号。" },
	{ match: /xss/i, text: "按上下文做输出编码；启用 CSP；避免 innerHTML 直接渲染用户输入。" },
	{ match: /ssrf/i, text: "出站目标白名单；禁止访问 metadata/内网地址；解析后校验 IP 并防 DNS rebinding。" },
	{ match: /upload/i, text: "校验文件类型/大小/内容；重命名并隔离存储；禁止可执行目录。" },
	{ match: /ssti|template/i, text: "不要把用户输入拼进模板；使用沙箱模板引擎并限制可访问对象。" },
];

const AUTHORIZATION_NOTICE =
	"本报告仅用于授权范围内的安全测试。测试前应取得目标所有者的书面授权，并明确测试窗口、目标范围与禁止操作。";

const nowLabel = (value) => {
	if (!value) return "-";
	const date = new Date(value);
	const pad = (n) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const clip = (text, max) => {
	const value = String(text ?? "");
	return value.length > max ? `${value.slice(0, max)}\n…[已截断 ${value.length - max} 字符，完整内容见证据 artifact]` : value;
};

function escapeHtml(text) {
	return String(text ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function remediationFor(finding) {
	const text = `${finding.category ?? ""} ${finding.title ?? ""}`;
	return REMEDIATION.find((item) => item.match.test(text))?.text ?? "修复根因并补充回归测试；对同类接口做横向排查。";
}

function renderCurl(exchange) {
	const parts = [`curl -s -i -X ${exchange.method} '${exchange.url}'`];
	for (const [key, value] of Object.entries(exchange.requestHeaders ?? {})) {
		if (key.toLowerCase() === "content-length") continue;
		parts.push(`  -H '${key}: ${String(value).replace(/'/g, "'\\''")}'`);
	}
	if (exchange.requestBody) parts.push(`  --data '${String(exchange.requestBody).replace(/'/g, "'\\''")}'`);
	return parts.join(" \\\n");
}

export function buildReportData({ store, evidenceService, projectId, includeCandidates = false }) {
	const project = store.getProject(projectId);
	if (!project) throw new Error(`项目不存在: ${projectId}`);
	const agents = store.listAgents(projectId);
	const findings = store
		.listFindings(projectId)
		.filter((finding) => (includeCandidates ? ["verified", "candidate", "disputed"].includes(finding.status) : finding.status === "verified"))
		.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
	const coverage = store.listCoverage(projectId);
	const facts = store.listFacts(projectId);
	const artifacts = store.listArtifacts(projectId);
	const exchanges = store.listExchanges(projectId);
	const totalEnded = agents.map((agent) => agent.endedAt ?? agent.startedAt ?? 0);
	const windowStart = project.created_at ?? project.createdAt ?? Date.now();
	const windowEnd = Math.max(Date.now(), ...totalEnded);

	const findingDetails = findings.map((finding) => {
		const detail = evidenceService.findingDetail(finding.id);
		const evidence = (detail?.evidence ?? []).map((item) => ({
			artifactId: item.artifact?.id,
			role: item.role,
			kind: item.artifact?.kind,
			bytes: item.artifact?.bytes,
			sha256: item.artifact?.sha256,
			exchange: item.exchange,
			curl: item.curl,
		}));
		return { finding, evidence, remediation: remediationFor(finding) };
	});

	const severityCounts = {};
	for (const { finding } of findingDetails) severityCounts[finding.severity] = (severityCounts[finding.severity] ?? 0) + 1;
	const coverageCounts = {};
	for (const item of coverage) coverageCounts[item.outcome] = (coverageCounts[item.outcome] ?? 0) + 1;

	return {
		project,
		generatedAt: Date.now(),
		window: { start: windowStart, end: windowEnd },
		findings: findingDetails,
		coverage,
		coverageCounts,
		severityCounts,
		facts,
		agents,
		artifacts,
		exchanges,
		includeCandidates,
		authorizationNotice: AUTHORIZATION_NOTICE,
	};
}

/* ------------------------------ Markdown ------------------------------ */

export function renderMarkdown(data) {
	const { project, findings, coverage, severityCounts, coverageCounts } = data;
	const lines = [];
	lines.push(`# 渗透测试报告：${project.name}`);
	lines.push("");
	lines.push(`- 目标：${project.target}`);
	lines.push(`- 授权范围：${(project.scope ?? []).join(", ") || project.target}`);
	lines.push(`- 测试窗口：${nowLabel(data.window.start)} ~ ${nowLabel(data.window.end)}`);
	lines.push(`- 报告生成：${nowLabel(data.generatedAt)}（由平台根据数据库确定性生成）`);
	lines.push(`- 漏洞统计：${findings.length} 条已验证${data.includeCandidates ? "（含候选/争议）" : ""} · severity ${JSON.stringify(severityCounts)}`);
	lines.push("");
	lines.push("> " + AUTHORIZATION_NOTICE);
	lines.push("");

	lines.push("## 1. 执行摘要");
	lines.push("");
	lines.push(
		`本次测试在授权范围内对 ${project.target} 进行。共确认 ${findings.length} 个问题：` +
			Object.entries(severityCounts)
				.map(([severity, count]) => `${SEVERITY_LABELS[severity] ?? severity} ${count}`)
				.join("、") +
			"。",
	);
	lines.push("");
	lines.push("| 严重级别 | 数量 |");
	lines.push("|---|---|");
	for (const severity of ["critical", "high", "medium", "low", "info"]) {
		if (!severityCounts[severity]) continue;
		lines.push(`| ${SEVERITY_LABELS[severity]} | ${severityCounts[severity]} |`);
	}
	lines.push("");
	lines.push("覆盖率账本：");
	for (const [outcome, count] of Object.entries(coverageCounts)) {
		lines.push(`- ${OUTCOME_LABELS[outcome] ?? outcome}：${count}`);
	}
	if (coverage.length === 0) lines.push("- 尚无覆盖率记录");
	lines.push("");

	lines.push("## 2. 漏洞详情");
	lines.push("");
	if (findings.length === 0) {
		lines.push("本次测试未确认漏洞。已排除项与证明缺口见第 3 节。");
		lines.push("");
	}
	for (const item of findings) {
		const { finding } = item;
		lines.push(`### ${finding.id} ${finding.title}`);
		lines.push("");
		lines.push(
			`- 严重级别：${SEVERITY_LABELS[finding.severity] ?? finding.severity}（${finding.severity}）`,
		);
		lines.push(`- 类别：${finding.category}`);
		lines.push(`- 目标：${finding.target}`);
		lines.push(`- 状态：${STATUS_LABELS[finding.status] ?? finding.status}${finding.verifiedBy ? `（验证者：${finding.verifiedBy}）` : ""}`);
		lines.push(`- 置信度：${finding.confidence}（${finding.confidenceRationale ?? "-"}）`);
		lines.push("");
		lines.push("**摘要**");
		lines.push("");
		lines.push(finding.summary ?? "");
		lines.push("");
		lines.push("**技术分析**");
		lines.push("");
		lines.push(finding.technicalAnalysis ?? "");
		lines.push("");
		lines.push("**影响**");
		lines.push("");
		lines.push(finding.impact ?? "");
		lines.push("");
		if (finding.preconditions?.length) {
			lines.push("**前置条件**");
			for (const precondition of finding.preconditions) lines.push(`- ${precondition}`);
			lines.push("");
		}
		lines.push("**为什么不是误报**");
		lines.push("");
		lines.push(finding.counterevidence ?? "");
		lines.push("");
		lines.push("**复现步骤**");
		lines.push("");
		(finding.poc?.steps ?? []).forEach((step, index) => lines.push(`${index + 1}. ${step}`));
		lines.push("");
		lines.push(`判定标志：\`${finding.poc?.expect?.match}\` = \`${finding.poc?.expect?.value}\``);
		lines.push("");

		for (const evidence of item.evidence) {
			if (!evidence.exchange) continue;
			lines.push(`**请求（${evidence.exchange.method} ${evidence.exchange.url}）**`);
			lines.push("");
			lines.push("```http");
			lines.push(`${evidence.exchange.method} ${evidence.exchange.url}`);
			lines.push(JSON.stringify(evidence.exchange.requestHeaders ?? {}));
			if (evidence.exchange.requestBody) lines.push("", evidence.exchange.requestBody);
			lines.push("```");
			lines.push("");
			lines.push(`**响应（status=${evidence.exchange.status ?? "ERROR"}）**`);
			lines.push("");
			lines.push("```http");
			lines.push(JSON.stringify(evidence.exchange.responseHeaders ?? {}));
			lines.push("", clip(evidence.exchange.responseBody ?? "", 4000));
			lines.push("```");
			lines.push("");
			lines.push("```bash");
			lines.push(evidence.curl ?? "");
			lines.push("```");
			lines.push("");
			break; // 主证据展示一次即可，其余在附录
		}
		lines.push("**修复建议**");
		lines.push("");
		lines.push(item.remediation);
		lines.push("");
	}

	lines.push("## 3. 覆盖率与未发现说明");
	lines.push("");
	if (coverage.length === 0) {
		lines.push("本次没有记录覆盖率账本，无法区分“没测”与“测了没问题”。");
	} else {
		lines.push("| 测试类 | 结果 | 控制点 / 说明 |");
		lines.push("|---|---|---|");
		for (const item of coverage) {
			lines.push(
				`| ${item.testClass} | ${OUTCOME_LABELS[item.outcome] ?? item.outcome} | ${(item.controlPoint ?? "-") + (item.rationale ? ` · ${item.rationale}` : "")} |`,
			);
		}
		lines.push("");
		const ruledOut = coverage.filter((item) => item.outcome === "ruled_out");
		const gaps = coverage.filter((item) => item.outcome === "open_proof_gap");
		if (ruledOut.length) {
			lines.push("已排除项（附具体控制点，可复核）：");
			for (const item of ruledOut) lines.push(`- ${item.testClass}：${item.controlPoint}`);
			lines.push("");
		}
		if (gaps.length) {
			lines.push("证明缺口（未能排除，报告中明确保留）：");
			for (const item of gaps) lines.push(`- ${item.testClass}：${item.rationale || "未说明"}`);
			lines.push("");
		}
	}

	lines.push("## 4. 附录");
	lines.push("");
	lines.push(`- 事实库：${data.facts.length} 条`);
	lines.push(`- 证据 artifact：${data.artifacts.length} 个（sha256 见导出包）`);
	lines.push(`- HTTP 事务：${data.exchanges.length} 次`);
	lines.push(`- Agent 运行：${data.agents.length} 个`);
	const agentLines = data.agents.map(
		(agent) =>
			`  - ${agent.id}（${agent.role}）：${agent.status}，turns=${agent.turns}，tokens=${agent.tokensIn + agent.tokensOut}`,
	);
	lines.push(...agentLines);
	lines.push("");
	lines.push("---");
	lines.push("");
	lines.push(AUTHORIZATION_NOTICE);
	lines.push("");
	return lines.join("\n");
}

/* ------------------------------ HTML ------------------------------ */

export function renderHtml(data) {
	const { project } = data;
	const findingsHtml = data.findings
		.map((item) => {
			const { finding } = item;
			const evidenceBlocks = item.evidence
				.filter((evidence) => evidence.exchange)
				.map(
					(evidence) => `
				<div class="evidence">
					<div class="evidence-title">${escapeHtml(evidence.artifactId)} · ${escapeHtml(evidence.role)} · ${evidence.bytes} bytes</div>
					<div class="panes">
						<div><div class="pane-label">Request</div><pre>${escapeHtml(
							`${evidence.exchange.method} ${evidence.exchange.url}\n${JSON.stringify(evidence.exchange.requestHeaders ?? {}, null, 1)}\n\n${evidence.exchange.requestBody ?? ""}`,
						)}</pre></div>
						<div><div class="pane-label">Response · ${escapeHtml(evidence.exchange.status ?? "ERROR")}</div><pre>${escapeHtml(
							`${JSON.stringify(evidence.exchange.responseHeaders ?? {}, null, 1)}\n\n${clip(evidence.exchange.responseBody ?? "", 4000)}`,
						)}</pre></div>
					</div>
					<pre class="curl">${escapeHtml(evidence.curl ?? "")}</pre>
				</div>`,
				)
				.join("");
			return `
			<section class="finding">
				<h2>${escapeHtml(finding.id)} ${escapeHtml(finding.title)}</h2>
				<div class="badges">
					<span class="sev ${finding.severity}">${SEVERITY_LABELS[finding.severity] ?? finding.severity}</span>
					<span class="status ${finding.status}">${STATUS_LABELS[finding.status] ?? finding.status}</span>
					<span>${escapeHtml(finding.category)}</span>
					<span>${escapeHtml(finding.target)}</span>
					<span>confidence: ${escapeHtml(finding.confidence)}</span>
				</div>
				<h3>摘要</h3><p>${escapeHtml(finding.summary)}</p>
				<h3>技术分析</h3><p>${escapeHtml(finding.technicalAnalysis)}</p>
				<h3>影响</h3><p>${escapeHtml(finding.impact)}</p>
				${finding.preconditions?.length ? `<h3>前置条件</h3><ul>${finding.preconditions.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>` : ""}
				<h3>为什么不是误报</h3><p>${escapeHtml(finding.counterevidence)}</p>
				<h3>复现步骤</h3><ol>${(finding.poc?.steps ?? []).map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
				<p class="expect">判定标志：<code>${escapeHtml(finding.poc?.expect?.match)}</code> = <code>${escapeHtml(finding.poc?.expect?.value)}</code></p>
				${evidenceBlocks}
				<h3>修复建议</h3><p>${escapeHtml(item.remediation)}</p>
			</section>`;
		})
		.join("");

	const coverageRows = data.coverage
		.map(
			(item) =>
				`<tr><td>${escapeHtml(item.testClass)}</td><td>${escapeHtml(OUTCOME_LABELS[item.outcome] ?? item.outcome)}</td><td>${escapeHtml(
					(item.controlPoint ?? "-") + (item.rationale ? ` · ${item.rationale}` : ""),
				)}</td></tr>`,
		)
		.join("");

	const severitySummary = Object.entries(data.severityCounts)
		.map(([severity, count]) => `<span class="sev ${severity}">${SEVERITY_LABELS[severity] ?? severity} ${count}</span>`)
		.join(" ");

	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>渗透测试报告 · ${escapeHtml(project.name)}</title>
<style>
:root{color-scheme:light}
body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:980px;margin:32px auto;padding:0 20px;color:#1f2430;line-height:1.65;background:#fff}
h1{font-size:24px;margin-bottom:4px} h2{font-size:18px;border-bottom:1px solid #e4e7ee;padding-bottom:6px;margin-top:28px} h3{font-size:14px;margin:14px 0 4px;color:#4a5163}
.meta{color:#5b6274;font-size:13px} .notice{background:#fff8e6;border:1px solid #f0d99b;padding:8px 12px;border-radius:6px;font-size:12px;color:#7a5b13}
table{border-collapse:collapse;width:100%;font-size:13px} th,td{border:1px solid #e4e7ee;padding:7px 9px;text-align:left;vertical-align:top} th{background:#f6f7fa}
.finding{border:1px solid #e4e7ee;border-radius:8px;padding:14px 18px;margin:16px 0}
.badges{display:flex;gap:8px;flex-wrap:wrap;font-size:12px;color:#5b6274;align-items:center}
.sev{padding:1px 7px;border-radius:4px;font-size:11px;background:#eef0f5;color:#4a5163;text-transform:uppercase}
.sev.critical{background:#fde2e2;color:#b42318}.sev.high{background:#fde8da;color:#b54708}.sev.medium{background:#fff3cd;color:#7a5b13}.sev.low{background:#e7f4ec;color:#18794e}
.status{font-size:11px;padding:1px 6px;border-radius:4px;background:#eef0f5;color:#4a5163}
.status.verified{background:#e7f4ec;color:#18794e}.status.candidate{background:#fff3cd;color:#7a5b13}.status.disputed{background:#fde2e2;color:#b42318}
pre{background:#0f131a;color:#d7dce5;padding:10px 12px;border-radius:6px;overflow:auto;font-size:12px;line-height:1.5}
.curl{background:#1c2432;margin-top:8px}
.evidence{border-top:1px dashed #e4e7ee;margin-top:12px;padding-top:8px}
.evidence-title{font-size:12px;color:#5b6274;margin-bottom:6px}
.panes{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.pane-label{font-size:11px;color:#5b6274;margin-bottom:3px}
.expect{font-size:13px} code{background:#f1f3f7;padding:1px 5px;border-radius:4px;font-size:12px}
ul,ol{padding-left:22px} p{margin:4px 0}
footer{margin-top:36px;font-size:12px;color:#7a8194;border-top:1px solid #e4e7ee;padding-top:12px}
</style></head><body>
<h1>渗透测试报告：${escapeHtml(project.name)}</h1>
<div class="meta">
目标：${escapeHtml(project.target)} · 授权范围：${escapeHtml((project.scope ?? []).join(", ") || project.target)}<br>
测试窗口：${escapeHtml(nowLabel(data.window.start))} ~ ${escapeHtml(nowLabel(data.window.end))} · 生成时间：${escapeHtml(nowLabel(data.generatedAt))}<br>
漏洞：${data.findings.length} 条${data.includeCandidates ? "（含候选/争议）" : "（已验证）"} ${severitySummary}
</div>
<div class="notice" style="margin:14px 0">${escapeHtml(AUTHORIZATION_NOTICE)}</div>
<h2>1. 执行摘要</h2>
<p>本次测试在授权范围内对 ${escapeHtml(project.target)} 进行，共确认 ${data.findings.length} 个问题。</p>
<h2>2. 漏洞详情</h2>
${findingsHtml || "<p>本次测试未确认漏洞。已排除项与证明缺口见第 3 节。</p>"}
<h2>3. 覆盖率与未发现说明</h2>
${data.coverage.length ? `<table><thead><tr><th>测试类</th><th>结果</th><th>控制点 / 说明</th></tr></thead><tbody>${coverageRows}</tbody></table>` : "<p>本次没有记录覆盖率账本，无法区分“没测”与“测了没问题”。</p>"}
<h2>4. 附录</h2>
<ul>
<li>事实库：${data.facts.length} 条</li>
<li>证据 artifact：${data.artifacts.length} 个</li>
<li>HTTP 事务：${data.exchanges.length} 次</li>
<li>Agent 运行：${data.agents.length} 个</li>
</ul>
<footer>${escapeHtml(AUTHORIZATION_NOTICE)}<br>由 Pi-Pentest 根据数据库确定性生成，不含模型自由发挥内容。</footer>
</body></html>`;
}

/* ------------------------------ PDF ------------------------------ */

const CHROME_CANDIDATES = [
	process.env.CHROME_PATH,
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

function findChrome() {
	for (const candidate of CHROME_CANDIDATES) {
		try {
			if (existsSync(candidate) && statSync(candidate).size > 0) return candidate;
		} catch {
			/* continue */
		}
	}
	return null;
}

export async function renderPdf({ projectId, html }) {
	const chrome = findChrome();
	if (!chrome) throw new Error("未找到 Chromium/Chrome，无法生成 PDF（可设 CHROME_PATH 或改用 HTML 报告）");
	const dir = join(RUNTIME, "projects", projectId, "report");
	mkdirSync(dir, { recursive: true });
	const htmlPath = join(dir, `report-${Date.now()}.html`);
	const pdfPath = htmlPath.replace(/\.html$/, ".pdf");
	writeFileSync(htmlPath, html, "utf8");
	await new Promise((resolve, reject) => {
		const child = spawn(
			chrome,
			["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${pdfPath}`, `file:///${htmlPath.replace(/\\/g, "/")}`],
			{ stdio: "ignore", windowsHide: true },
		);
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("PDF 生成超时"));
		}, 60_000);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(`Chrome 退出码 ${code}`));
		});
	});
	const buffer = readFileSync(pdfPath);
	rmSync(htmlPath, { force: true });
	rmSync(pdfPath, { force: true });
	return buffer;
}

export function copyArtifactFile(artifact, destination) {
	mkdirSync(dirname(destination), { recursive: true });
	copyFileSync(artifact.path, destination);
}

/* ------------------------------ SARIF ------------------------------ */

const SARIF_LEVEL = { critical: "error", high: "error", medium: "warning", low: "note", info: "note" };

/** M7：SARIF 2.1.0（可进 GitHub Code Scanning / CI） */
export function renderSarif(data) {
	const rules = [];
	const seen = new Set();
	const results = data.findings.map((item) => {
		const { finding } = item;
		const ruleId = finding.category;
		if (!seen.has(ruleId)) {
			seen.add(ruleId);
			rules.push({
				id: ruleId,
				name: ruleId,
				shortDescription: { text: `渗透测试：${ruleId}` },
				fullDescription: { text: `由 Pi-Pentest 在授权测试中确认的 ${ruleId} 类问题` },
				defaultConfiguration: { level: SARIF_LEVEL[finding.severity] ?? "warning" },
			});
		}
		return {
			ruleId,
			ruleIndex: rules.findIndex((rule) => rule.id === ruleId),
			level: SARIF_LEVEL[finding.severity] ?? "warning",
			message: { text: `${finding.title}\n\n${finding.summary}` },
			locations: [
				{
					physicalLocation: {
						artifactLocation: { uri: finding.target, description: { text: "受影响的 URL/接口" } },
					},
				},
			],
			properties: {
				findingId: finding.id,
				severity: finding.severity,
				confidence: finding.confidence,
				status: finding.status,
				verifiedBy: finding.verifiedBy ?? null,
				category: finding.category,
			},
		};
	});
	return {
		$schema: "https://json.schemastore.org/sarif-2.1.0.json",
		version: "2.1.0",
		runs: [
			{
				tool: {
					driver: {
						name: "pi-pentest",
						informationUri: "https://github.com/earendil-works/pi",
						version: "0.3.0",
						rules,
					},
				},
				originalUriBaseIds: { SRCROOT: { uri: "file:///" } },
				results,
				invocations: [{ executionSuccessful: true, startTimeUtc: new Date(data.window.start).toISOString() }],
			},
		],
	};
}
