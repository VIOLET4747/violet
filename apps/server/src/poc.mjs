/**
 * M5：PoC 导出包
 *
 * 从 DB 里的 verified finding + http_exchange 确定性生成：
 *   poc/<finding-id>/{README.md,repro.sh,repro.py,verify.py,expected.json,artifacts/}
 *   evidence/<artifact-id>.log + manifest.json
 * 只用 Python 标准库（urllib），拷到新机器可直接跑。
 */
import JSZip from "jszip";
import { readFileSync } from "node:fs";
import { renderMarkdown, renderHtml } from "./report.mjs";

const AUTHORIZATION_NOTICE =
	"本复现包仅用于授权范围内的安全测试，请确认目标授权与测试窗口后再执行。";

function requestText(exchange) {
	const parsed = new URL(exchange.url);
	const lines = [`${exchange.method} ${parsed.pathname}${parsed.search} HTTP/1.1`, `Host: ${parsed.host}`];
	for (const [key, value] of Object.entries(exchange.requestHeaders ?? {})) lines.push(`${key}: ${value}`);
	lines.push("", exchange.requestBody ?? "");
	return lines.join("\r\n");
}

function responseText(exchange) {
	const lines = [`HTTP/1.1 ${exchange.status ?? "ERROR"}`, ...Object.entries(exchange.responseHeaders ?? {}).map(([k, v]) => `${k}: ${v}`)];
	lines.push("", exchange.responseBody ?? "");
	return lines.join("\r\n");
}

function curlCommand(exchange) {
	const parts = [`curl -s -i -X ${exchange.method} '${exchange.url}'`];
	for (const [key, value] of Object.entries(exchange.requestHeaders ?? {})) {
		if (key.toLowerCase() === "content-length") continue;
		parts.push(`  -H '${key}: ${String(value).replace(/'/g, "'\\''")}'`);
	}
	if (exchange.requestBody) parts.push(`  --data '${String(exchange.requestBody).replace(/'/g, "'\\''")}'`);
	return parts.join(" \\\n");
}

function reproPython(expected) {
	return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""复现脚本（Python 标准库，无第三方依赖）。

用法: python repro.py
输出: PASS / FAIL（退出码 0 / 1）
"""
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def load_expected():
    with open(os.path.join(HERE, "expected.json"), "r", encoding="utf-8") as fh:
        return json.load(fh)


def evaluate(expect, status, headers, body_text):
    match = expect.get("match")
    value = str(expect.get("value", ""))
    if match == "status":
        return str(status) == value
    if match == "body_regex":
        return re.search(value, body_text) is not None
    if match == "header_regex":
        return re.search(value, json.dumps(headers, ensure_ascii=False), re.IGNORECASE) is not None
    return False


def main():
    data = load_expected()
    headers = {str(k): str(v) for k, v in (data.get("headers") or {}).items()}
    body = data.get("body") or ""
    raw = body.encode("utf-8") if body else None
    request = urllib.request.Request(data["url"], data=raw, method=data.get("method", "GET"), headers=headers)
    context = ssl._create_unverified_context()
    try:
        response = urllib.request.urlopen(request, timeout=float(data.get("timeout", 15)), context=context)
        status = response.status
        resp_headers = dict(response.headers)
        payload = response.read()
    except urllib.error.HTTPError as error:
        status = error.code
        resp_headers = dict(error.headers)
        payload = error.read()
    except Exception as error:  # noqa: BLE001
        print("FAIL", "request error:", error)
        return 1
    text = payload.decode("utf-8", errors="replace")
    ok = evaluate(data.get("expect") or {}, status, resp_headers, text)
    print("PASS" if ok else "FAIL", status, len(payload))
    print("target:", data["url"])
    print("expect:", json.dumps(data.get("expect"), ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
`;
}

function verifyPython() {
	return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CI 用：运行同目录 repro.py，透传 PASS/FAIL 与退出码。"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
code = subprocess.call([sys.executable, os.path.join(HERE, "repro.py")])
sys.exit(code)
`;
}

function pocReadme(item, expected) {
	const { finding } = item;
	return `# ${finding.id} · ${finding.title}

- 严重级别：${finding.severity}
- 目标：${finding.target}
- 判定标志：\`${finding.poc?.expect?.match}\` = \`${finding.poc?.expect?.value}\`

## 复现

\`\`\`bash
python repro.py      # 打印 PASS / FAIL，退出码 0 / 1
\`\`\`

CI 里可以跑 \`python verify.py\`（同样返回 PASS/FAIL 退出码）。

## 文件

| 文件 | 说明 |
|---|---|
| \`expected.json\` | 请求方法/URL/headers/body 与 expect，由平台从 http_exchange 确定性生成 |
| \`repro.py\` | Python 标准库复现 + 断言 |
| \`verify.py\` | CI 包装（调用 repro.py） |
| \`repro.sh\` | curl 版本（人工确认用） |
| \`artifacts/request.txt\` / \`response.txt\` | 原始请求/响应 |
| \`artifacts/request.artifact.txt\` / \`response.artifact.txt\` | 平台落盘的 artifact 原文（含 sha256） |

> ${AUTHORIZATION_NOTICE}
`;
}

export function buildPocFiles({ data, store, evidenceService }) {
	const files = new Map();
	const markdown = renderMarkdown(data);
	const html = renderHtml(data);
	files.set("README.md", `# ${data.project.name} 复现包\n\n由 Pi-Pentest 根据数据库确定性生成。\n\n- 目标：${data.project.target}\n- 生成时间：${new Date().toISOString()}\n\n## 用法\n\n\`\`\`bash\ncd poc/<finding-id>\npython repro.py      # PASS / FAIL\n\`\`\`\n\n> ${AUTHORIZATION_NOTICE}\n`);
	files.set("report.md", markdown);
	files.set("report.html", html);

	for (const item of data.findings) {
		const { finding } = item;
		const exchange = item.evidence.find((evidence) => evidence.exchange)?.exchange;
		if (!exchange) continue;
		const dir = `poc/${finding.id}`;
		const expected = {
			title: finding.title,
			severity: finding.severity,
			url: exchange.url,
			method: exchange.method,
			headers: exchange.requestHeaders ?? {},
			body: exchange.requestBody ?? "",
			timeout: 15,
			expect: finding.poc?.expect ?? {},
			observedStatus: exchange.status,
			findingId: finding.id,
		};
		files.set(`${dir}/expected.json`, JSON.stringify(expected, null, 2));
		files.set(`${dir}/repro.py`, reproPython(expected));
		files.set(`${dir}/verify.py`, verifyPython());
		files.set(`${dir}/repro.sh`, `#!/usr/bin/env bash\nset -e\n${curlCommand(exchange)}\n`);
		files.set(`${dir}/README.md`, pocReadme(item, expected));
		files.set(`${dir}/artifacts/request.txt`, requestText(exchange));
		files.set(`${dir}/artifacts/response.txt`, responseText(exchange));
		for (const evidence of item.evidence) {
			if (!evidence.artifactId || !store.getArtifact) continue;
			const artifact = store.getArtifact(evidence.artifactId);
			if (!artifact?.path) continue;
			try {
				const raw = readFileSync(artifact.path);
				files.set(`${dir}/artifacts/${evidence.role === "response" ? "response" : "request"}.artifact.txt`, raw);
			} catch {
				/* artifact 文件可能被清理 */
			}
		}
	}
	return { files, markdown, html };
}

export async function buildPocZip(args) {
	const { files } = buildPocFiles(args);
	const zip = new JSZip();
	for (const [path, content] of files) zip.file(path, content);
	return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

export async function buildEvidenceZip({ data, store }) {
	const zip = new JSZip();
	const manifest = [];
	for (const artifact of data.artifacts) {
		let content;
		try {
			content = readFileSync(artifact.path);
		} catch {
			continue;
		}
		zip.file(`evidence/${artifact.id}.log`, content);
		manifest.push({
			id: artifact.id,
			kind: artifact.kind,
			title: artifact.title,
			projectId: artifact.projectId,
			agentId: artifact.agentId,
			bytes: artifact.bytes,
			sha256: artifact.sha256,
			file: `evidence/${artifact.id}.log`,
			createdAt: artifact.createdAt,
		});
	}
	zip.file("manifest.json", JSON.stringify({ project: data.project.id, generatedAt: Date.now(), artifacts: manifest }, null, 2));
	return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
