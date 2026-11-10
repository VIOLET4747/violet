# Pi-Pentest：基于 pi 框架的渗透测试 Agent 平台 —— 技术方案

> 版本：v0.1（设计初稿，包含后续里程碑的规划，部分能力尚未实现）
> 依据：对 `@earendil-works/pi` 源码的只读精读（各包 v1.3.0）
> 以及对 Strix / dsh-pentest / dsh-pentester / PentestGPT / CAI / XBOW / AutoPenBench 的公开资料调研
> 文中 `packages/...` 路径均相对于 pi 源码根目录。

---

## 0. 结论速览（TL;DR）

**一句话方案**：pi 只当 **agent 运行时**（一个 agent = 一个 `pi --mode rpc` 子进程），自研 **编排层 + 领域存储 + WebUI**，所有渗透业务逻辑收敛到一个 **pi 扩展（`pi-kit`）** 里，不改 pi 源码。

| 层 | 选型 | 说明 |
|---|---|---|
| Agent 运行时 | `@earendil-works/pi-coding-agent`，RPC 子进程模式 | 自带会话树、compaction、skills、MCP、工具审批 hook、结构化事件流 |
| 进程模型 | 1 个 orchestrator 服务 + N 个 `pi --mode rpc` 子进程 | 崩溃隔离、独立 cwd/session/工具集、可 abort/steer/fork |
| 编排层 | 自研（Node/TS + SQLite + 事件总线） | 任务状态机、预算、并发、审批队列、唤醒；**不要**一上来用 pi-durable（Experimental） |
| 领域存储 | SQLite（WAL）+ 文件工件仓 | facts / assets / endpoints / findings / evidence / coverage / approvals |
| 工具层 | 容器内 argv 执行 + 少量 typed 工具 + MCP | 不为 150 个工具写 150 个 schema；高频工具走 `deferred`/`codemode` |
| 沙箱 | 每项目一个 Docker 容器（Kali toolbox）+ mitmproxy 出网代理 | pi 本体无沙箱，必须自己做 |
| 前端 | React + Vite + TS + Tailwind + shadcn/ui + TanStack Query + WS | 平台型 WebUI，不是 TUI |
| 报告 | 确定性模板 + LLM 只写叙述并引用 fact/evidence id | 报告数据源是 DB，不是模型自由发挥 |
| 交付 | Markdown/HTML/PDF + SARIF + `poc.zip`（curl/python 可一键复现） | 每条 finding 必须能重放验证 |

**pi 开箱给你的**：多 provider 统一调用、会话 JSONL 树 + 自动压缩、skills 渐进加载、MCP 客户端、工具审批拦截点、完整事件流（文本/thinking/工具入参/结果/用量/成本）、会话 fork/HTML 导出。
**pi 不给你、必须自己写的**：① 多 agent 编排（pi 明确不做 sub-agent）② 领域持久化（项目/事实/漏洞/证据）③ 沙箱 ④ 审批队列与 scope 管控 ⑤ WebUI ⑥ 报告与 PoC 导出。

---

## 1. 需求拆解与关键判断

| 你的需求 | 对应架构决策 | 关键理由 |
|---|---|---|
| 以项目为单位（一站点/系统/域名） | 项目 = 一个工作区目录 + 一个 SQLite + 一个 Docker 容器 + 一组 agent 会话 | 隔离、可归档、可并行多项目 |
| 项目内信息共享（key、内网地址、API 接口） | 独立 **Fact Store**，所有 agent 通过工具读写；子 agent 直写、父 agent 只读摘要 | 上下文与工作量解耦；这是解决长上下文的根本手段 |
| 主 agent 调度子 agent（判 JWT → 派 JWT agent） | `dispatch_agent` 工具 → orchestrator 异步起子进程；父 agent 只收结构化摘要 | 官方 subagent 示例同款；再加编排层管制 |
| 上下文过长 | 四层：子 agent 隔离 → 工具输出截断落盘 → 外部记忆 → 压缩（含安全特化摘要） | 行业一致做法，单靠压缩会丢 finding（Strix 实测反证） |
| 报告 + 一键复现脚本，不得捏造 | Finding schema 硬闸门 + 证据反查 + 独立 verifier 重放 + 确定性报告生成 | 靠 schema，不靠 prompt 恳求；业界最强实践（Strix） |
| 工具箱：本地工具 + MCP，AI 直接调 | Tool Registry（YAML）+ argv 执行器 + `tool_search`/`deferred` + `registerMcpServer` | 减少 schema 膨胀，避免 agent 自己写脚本 |
| Skills | `SKILL.md` 目录，按角色用 `--skill` 白名单注入 | pi 原生渐进加载，零改造 |

### 1.1 三个必须先说清的判断

**判断一：不要把 pi 的 TUI 当前端，也不要在 pi 里塞一个 Web 服务器。**
pi 的价值是 agent 内核与事件流。WebUI 应作为独立进程消费 RPC 事件。TUI 保留给开发调试（`pi` 直接跑，非常好用）。

**判断二：主 agent 必须是"纯编排"，机制上拿不到 bash/网络工具。**
Strix 用 prompt 约束 root，dsh-pentester 用机制（root 只被 `tools.restrict({allow})` 放行 5 个编排工具）。后者更可靠：deny-list 挡不住以后新增的工具。我们的 commander 角色只给 `dispatch_agent / list_agents / fact_query / fact_write / coverage_query / report_* / ask_user`。

**判断三：先自研编排，不要一开始上 pi-durable。**
`pi-durable` 确实提供 conversation/task/document 持久化、任务状态机、崩溃恢复、级联 abort，很契合；但它标记 **Experimental**，且要理解 chord/host/reload 那一整套（`scheduler.ts` 体量巨大）。MVP 用自研 SQLite 编排（约 1500 行）即可；等任务图复杂到"跑 6 小时、进程随时可能被杀"再迁移。文档第 9 章给出迁移路径。

---

## 2. 总体架构

```
┌───────────────────────────────────────────────────────────────────────────┐
│  WebUI  (React + Vite)   http://localhost:5173                            │
│  项目台 · Agent 树/时间线 · 资产事实看板 · 漏洞+证据 · 工具箱 · 报告        │
└───────────────┬──────────────────────────────▲───────────────────────────┘
                │ REST (CRUD/导出)              │ WebSocket (事件流/审批)
┌───────────────▼──────────────────────────────┴───────────────────────────┐
│  Orchestrator  (Node/TS · Fastify)                                        │
│  ├─ Project/Target/Scope 管理      ├─ 审批队列（人审）                     │
│  ├─ Agent 生命周期与调度器          ├─ Fact/Asset/Endpoint/Findings/Evidence│
│  ├─ 预算与配额（tokens/时长/迭代）   ├─ Coverage 账本                       │
│  ├─ 事件归一化 → WS 广播            ├─ 报告生成 + PoC 导出                  │
│  └─ 内部 API（供 pi 扩展回调）      └─ 审计日志（append-only）              │
└───────────────┬──────────────────────────────────────────────┬───────────┘
                │ spawn + JSONL(RPC)                            │ docker exec / HTTP
    ┌───────────▼──────────┐  ┌───────────▼──────────┐  ┌───────▼───────────┐
    │ pi agent #1          │  │ pi agent #2          │  │ Docker: toolbox   │
    │ commander (无武器)    │  │ jwt-hunter           │  │ kali + nmap/nuclei│
    │ --mode rpc           │  │ --mode rpc           │  │ ffuf/sqlmap/jwt   │
    │ + pi-kit 扩展        │  │ + pi-kit 扩展        │  │ mitmproxy 出网代理 │
    └──────────────────────┘  └──────────────────────┘  └───────────────────┘
                │                        │
                └────── 共享事实层：SQLite(facts/findings/evidence) ─────────┘
```

数据流三条：
1. **控制流**：WebUI → orchestrator REST → `dispatch/abort/steer` → pi 子进程。
2. **事件流**：pi 子进程 stdout(JSONL) → orchestrator 归一化 → WS → WebUI；同时落 `agent_events` 表供回放。
3. **信息流**：pi 扩展工具 → orchestrator 内部 API → SQLite；其他 agent 通过 `fact_query` 读取。

---

## 3. 技术选型

### 3.1 pi 各包怎么用

| 包 | 用不用 | 用在哪 |
|---|---|---|
| `pi-coding-agent` | **核心** | Agent 运行时（RPC 模式）、会话、skills、MCP 扩展、审批 hook、事件 |
| `pi-ai` | 间接（被 coding-agent 依赖） | provider 抽象；需要自建 `Models` 时才直接用 |
| `pi-agent-core` | 不用（除非自研 loop） | 太低层，要自己实现压缩/会话/工具审批 |
| `pi-durable` | **v2 再考虑** | 需要崩溃可恢复的任务图时替换自研调度器 |
| `pi-chord` | 不用 | durable 的底层 RPC/状态层，本项目 WS 协议更简单 |
| `pi-mcp` | 可选 | 只有想绕过 pi 自带 MCP 扩展、自管 `McpClient` 时才用 |
| `pi-codemode` | 建议启用（pi 内置） | 让模型写 JS 批量跑工具、裁剪大输出，省上下文 |
| `pi-env` | 可选 | 需要 SSH 跳板机执行时用 |

### 3.2 为什么是 RPC 子进程，而不是 SDK 进程内

| 维度 | SDK（`createAgentSession` 进程内） | RPC（`pi --mode rpc` 子进程） |
|---|---|---|
| 内置扩展（codemode/tool_search/MCP） | **不自动加载**，要手动 `createCodemodeExtension()` 等，且必须 `bindExtensions()` | CLI 模式自带，行为与 `pi` 命令行一致 |
| 故障隔离 | 一个 agent 死循环/OOM 拖垮整个服务 | 子进程崩溃只影响自己 |
| 独立配置 | 靠 `createAgentSession` 参数 | `--tools/--model/--thinking/--session-dir/--skill/-e/--append-system-prompt` 全在命令行 |
| WebUI 事件 | `session.subscribe` | JSONL 事件流，天然可转发；`RpcClient` 已做关联 |
| 审批弹窗 | `ctx.ui.confirm` 需要宿主实现 UI | 走 `extension_ui_request/response`，直接桥到 Web 弹窗 |
| 调试 | 断了难复现 | `pi --mode rpc` 可手动喂 JSONL 复现 |

**结论：生产用 RPC，`AgentHandle` 接口下保留一个 SDK 实现用于单测/P0 spike。**
参考实现：`packages/coding-agent/examples/extensions/subagent/index.ts:298`（官方 subagent 就是 `spawn(pi, ["--mode","json","-p", ...])`）。

### 3.3 WebUI 技术栈

- **框架**：React 19 + TypeScript + Vite
- **UI**：Tailwind CSS + shadcn/ui（Radix 原语）；图标 lucide-react
- **路由/数据**：TanStack Router + TanStack Query（服务端状态）+ Zustand（实时流/本地 UI 状态）
- **实时**：原生 WebSocket + 自研事件协议（无需 socket.io；要做断线重连带 `lastEventId` 重放）
- **专业组件**：`@xterm/xterm`（实时终端）、`monaco-editor`（PoC/skill 编辑）、`@xyflow/react`（agent/资产关系图）、`react-markdown` + `shiki`（报告）
- **图表**：Recharts（成本/覆盖度）
- **不要用**：pi 的 TUI 组件（`pi-tui`）、Electron。浏览器端没有 pi 依赖。

---

## 4. 后端实现方案

### 4.1 进程与并发模型

```
orchestrator (1 进程)
  ├─ AgentSupervisor: Map<agentId, {child, client, role, state, usage}>
  ├─ Scheduler: 就绪队列 + 并发上限（默认 4）+ 每项目并发上限（默认 3）
  ├─ BudgetGuard: 每 agent tokens/turns/时长 上限，超限 → abort + handoff
  └─ ApprovalBroker: pending approvals → WS → WebUI → 回填
```

一个 agent 的启动参数（已核对 pi CLI 能力）：

```ts
const child = spawn("node", [PI_CLI,                      // @earendil-works/pi-coding-agent/dist/cli.js
  "--mode", "rpc",
  "--session-dir", `${project.workspace}/sessions`,        // 会话 JSONL 落项目目录，天然可审计
  "--name", `${role}-${seq}`,
  "--model", model,                                        // 角色级模型（见 4.10）
  "--thinking", thinking,                                  // off|low|medium|high
  // ⚠ --tools 是"替换式 allowlist"，会作用于内置 + 扩展 + 自定义工具。
  //    漏写 pi-kit 的工具名，fact_write 之类会被静默禁用 —— 必须 builtin ∪ kit 一起列。
  "--tools", [...BUILTIN_TOOLS[role], ...KIT_TOOLS[role]].join(","),
  "--skill", skillPath,                                    // 角色技能目录（可多次）
  "--append-system-prompt", rolePromptFile,                // 角色系统提示（含 brief 占位）
  "--no-skills",                                           // 关掉自动发现，只认显式 --skill（避免串角色）
  "-e", PI_KIT_ENTRY,                                      // 我们唯一的扩展
], {
  cwd: project.workspace,
  env: {
    ...process.env,
    PENTEST_ORCH_URL: "http://127.0.0.1:8787/internal",
    PENTEST_TOKEN: project.scopedToken,                    // 每项目短期 token
    PENTEST_PROJECT_ID: project.id,
    PENTEST_AGENT_ID: agentId,
    PENTEST_ROLE: role,
  },
  stdio: ["pipe", "pipe", "pipe"],
});
```

- 子进程 stdout 只读协议记录（**严格按 LF 切分，绝不能用 Node `readline`**，它会在 `U+2028/U+2029` 误断，见 `docs/rpc.md:50-56`）。
- 优先用官方 `RpcClient`（`src/modes/rpc/rpc-client.ts`）：`start / prompt / promptAndWait / steer / followUp / abort / waitForIdle / getState / compact / getSessionStats / onEvent / stop`。
- 判完成：**等 `agent_settled`**，不要用 `agent_end`（重试/压缩/排队后还会继续，`docs/rpc.md:67-71`）。
- 子进程超时可 kill；容器内进程组要 `setsid` + TERM→KILL（防 sqlmap 之类留下孤儿）。

### 4.2 项目工作区布局

```
projects/<projectId>/
├─ project.json                 # 名称/目标/scope/授权信息/预算/容器配置
├─ session.sqlite               # 领域库（facts/findings/…），orchestrator 单写
├─ sessions/                    # pi 会话 JSONL（每 agent 一份，可回放）
├─ artifacts/                   # 证据工件（HTTP 原文、nmap/nuclei 输出、截图、PoC）
│  └─ <yyyymmdd>/<artifactId>.<ext>
├─ reports/<reportId>/          # report.md/html/PDF/sarif + poc.zip
├─ env/                         # 容器挂载：wordlists、tool 配置、工作目录
└─ audit.log                    # append-only 操作审计
```

宿主机只存"编排与证据"，**渗透动作全部在容器内**。

### 4.3 共享信息层（黑板 / Fact Store）

这是整个平台最关键的领域设计。目标：让"主 agent 判出 JWT"这种事不依赖模型记忆力。

#### 4.3.1 数据模型（SQLite）

```sql
-- 事实：一切可被复用的客观信息
CREATE TABLE fact (
  id            TEXT PRIMARY KEY,          -- fact-000123（项目内单调递增，可读）
  project_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,             -- asset|endpoint|credential|secret|tech|behavior|negative|hypothesis
  dedupe_key    TEXT NOT NULL,             -- 如 "endpoint:https://t/api/login:POST"
  title         TEXT NOT NULL,
  value         TEXT NOT NULL,             -- JSON
  confidence    REAL NOT NULL DEFAULT 0.5, -- 0..1
  status        TEXT NOT NULL,             -- candidate|confirmed|stale|refuted
  source_agent  TEXT, source_tool_call TEXT,
  evidence_ids  TEXT,                      -- JSON 数组，指向 artifact
  tags          TEXT,                      -- "jwt,spring,auth"
  created_at    INTEGER, updated_at INTEGER
);
CREATE UNIQUE INDEX ux_fact ON fact(project_id, dedupe_key);
CREATE VIRTUAL TABLE fact_fts USING fts5(title, value, tags, content='fact');

-- 资产 & 端点（对 fact 的结构化投影，UI 与覆盖率用）
CREATE TABLE asset      (id, project_id, kind /*host|ip|domain|repo|bucket*/, identifier, meta, first_seen, last_seen);
CREATE TABLE endpoint   (id, project_id, asset_id, method, path, params, auth_required, meta);

-- 漏洞（候选→已验证）
CREATE TABLE finding (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  dedupe_key    TEXT NOT NULL,             -- 规范化 title+endpoint+param
  title, category, severity,               -- severity: critical|high|medium|low|info
  status        TEXT NOT NULL,             -- candidate|verifying|verified|disputed|false_positive|fixed
  target        TEXT,                      -- URL/接口
  summary, technical_analysis, impact, preconditions, remediation,
  counterevidence        TEXT NOT NULL,    -- 为什么不是误报/已有控制为何无效（必填）
  severity_change_conditions TEXT,
  confidence    TEXT NOT NULL,             -- high|medium|low
  confidence_rationale TEXT,
  poc           TEXT,                      -- JSON：type/request_ids/script/steps/expect
  found_by      TEXT, verified_by TEXT, verified_at INTEGER,
  created_at, updated_at
);
CREATE TABLE finding_evidence (finding_id, artifact_id, role /*request|response|screenshot|log*/);

-- 覆盖率账本：解决"没找到"和"没测"不可区分（假阴性）
CREATE TABLE coverage (
  id, project_id, asset_id, test_class,    -- sqli|xss|ssrf|ssti|jwt|idor|upload|...
  outcome       TEXT NOT NULL,             -- confirmed|ruled_out|open_proof_gap
  control_point TEXT,                      -- ruled_out 必填：具体控制点（file:line / WAF 规则 id）
  rationale, evidence_ids, updated_by, updated_at
);

-- 其他
artifact  (id, project_id, agent_id, kind, path, sha256, bytes, mime, created_at)
approval  (id, project_id, agent_id, tool_call_id, tool, argv, risk, reason, status /*pending|approved|denied|expired*/, decided_by, decided_at)
agent_run (id, project_id, role, parent_id, status, model, started_at, ended_at, tokens_in, tokens_out, cost, turns, abort_reason)
agent_event(id, agent_id, seq, type, payload, created_at)   -- 事件回放
tool_def  (id, project_id, source /*builtin|local|mcp*/, name, config_yaml, enabled, risk)
mcp_server(id, project_id, name, transport, config, exposure, enabled, health, tools_cache)
wordlist  (id, project_id, name, path, lines, tags)
skill     (id, scope /*global|project*/, name, path, roles, enabled)
usage_record (project_id, agent_id, model, in_tokens, out_tokens, cache_read, cost, at)
```

#### 4.3.2 写入规则（防篡改 + 防噪音）

- **子 agent 直写、父 agent 只读**：子 agent 每发现一条事实立即 `fact_write`，不攒到最后；父 agent 只拿 `fact_query` 的摘要，不拿原始日志。
- **服务端推导归属**：`source_agent` 由 token 反解，不接受模型传参（防伪造，学 dsh-pentest）。
- **去重**：`dedupe_key` 唯一索引 + `INSERT ... ON CONFLICT DO UPDATE`（更新 confidence/evidence，不新增）。
- **状态升级需要证据**：`confirmed` 必须至少 1 个 `artifact_id`；否则只能 `candidate`。
- **负事实也要记**：`kind=negative`（"该 endpoint 无 IDOR，因为返回 403 且在 controller 层校验"）——这是覆盖率账本的输入。

#### 4.3.3 上下文注入策略

每次 agent 开始一轮时注入 **Project Brief**（≤ 2000 tokens，由 orchestrator 生成）：

```markdown
## 项目摘要（自动生成，勿轻信，需自行验证）
- 目标: https://target.example.com (主域), 10.0.3.0/24 (内网, 3 个资产)
- 阶段: exploitation / 已测试 42%, 覆盖缺口 7 项
- 关键事实 Top 12: [fact-001] 登录接口 POST /api/login，返回 JWT(HS256)…
- 活跃假设: [H-3] /api/fetch 参数 url 可能 SSRF（依据 fact-004）
- 兄弟 agent: recon-1(完成) auth-2(运行中 12min) 
- 你的职责: …（角色提示）
```

实现方式三选一（推荐 a）：
- **(a) 启动时写进 `--append-system-prompt` 文件 + `before_agent_start` 钩子定期刷新**（推荐：零额外延迟，每 N 轮刷新一次）
- (b) 纯钩子每轮拉取（实时但多一次 HTTP RTT）
- (c) 模型主动调 `get_brief` 工具（省 token 但可能不调）

### 4.4 主 Agent 调度器

#### 4.4.1 `dispatch_agent` 工具契约（pi-kit 注册）

```ts
dispatch_agent({
  role: "recon" | "web-vuln" | "auth" | "ssrf" | "ssti" | "jwt" | "xxe"
       | "idor" | "upload" | "code-audit" | "exploit" | "verifier",
  objective: string,        // 必填：目标 + 测试假设 + 成功判据（一句话，服务端校验质量）
  targets: string[],        // 必须是项目 scope 的子集
  inputs: { fact_ids?: string[], artifact_ids?: string[] },  // 给子 agent 的上下文引用
  budget?: { maxTurns?: number, maxMinutes?: number, maxTokens?: number },
  report_to: "parent" | "orchestrator"
})
→ { agent_id: "agent-0007", status: "queued", note: "完成后将自动通知你" }
```

**反垃圾校验**（服务端）：`objective` 必须同时包含（1）具体 target（2）要验证的假设（3）判据，否则直接返回 `invalid_objective` 并给示例。防止主 agent 无脑 `dispatch("recon")` 刷任务。

#### 4.4.2 异步 + 事件唤醒（不要阻塞主 agent）

```
commander 调 dispatch_agent → 立即返回 agent_id（工具 200ms 内返回）
        │
orchestrator 排队 → 起子进程 → 子 agent 运行中持续写 facts
        │
子 agent 完成 → 结果结构化落库 → orchestrator 对父 agent 调 RPC `prompt`：
   "[系统通知] agent-0007 (jwt) 已完成：新增 fact-012(HS256密钥硬编码)…
    详情见 fact_query(tags=["jwt"])。待办：可派 exploit 验证。"
        │
commander 被唤醒，继续决策（可同时再派新任务）
```

- 唤醒消息要**批量合并**（< 60s 内多个完成合并成一条），避免轰炸父上下文。
- 父 agent 也提供 `list_agents` / `abort_agent` / `send_message_to_agent` / `wait_agents(ids, timeoutSec)` 作为兜底。
- 父 agent 被用户中止时，级联 abort 所有子 agent（默认开启，可配）。

#### 4.4.3 任务状态机与失败处理

```
queued → starting → running ─┬→ completed
                              ├→ failed(exit!=0 / LLM error / tool 崩溃)
                              ├→ exhausted(预算耗尽)
                              ├→ aborted(用户/父 agent/超时)
                              └→ waiting_approval → running
```

- **失败不空转**：`failed/exhausted` 时 orchestrator 生成 **Handoff Note**（结构化：已确认事实、已排除项、下一步建议、失败原因），派新 agent 时作为 `inputs` 传入。这是 XBOW 的经验：错误假设会累积，**重开比续跑干净**。
- **迭代上限**：每 agent 默认 60 turns / 20 tool calls per turn 上限 / 30min；到限 → `exhausted` + handoff。
- **深度限制**：commander → 子 agent，**子 agent 默认不再允许 dispatch**（`--tools` 里没有该工具）。需要三级时由 orchestrator 显式开启，最多 2 层。
- **并发**：全局 4 / 每项目 3 / 同 role 2；排队公平（按创建时间 + 依赖）。

#### 4.4.4 覆盖驱动的"不漏测"

把"攻击面 → 测试类"做成**确定性映射表**，由 orchestrator 在资产入库时自动展开待测项写入 `coverage`：

| 攻击面信号（fact） | 展开的 test_class |
|---|---|
| 响应头 `Authorization: Bearer` / 登录接口返回 JWT | `jwt`（alg=none/弱密钥/kid 注入/jku） |
| 参数名含 url/path/redirect/src/callback | `ssrf`、`open-redirect` |
| 参数回显 / 模板语法 | `xss`、`ssti` |
| 表单/JSON 参数进入 SQL | `sqli` |
| 上传接口 / Content-Type 可绕 | `upload` |
| 对象 id 型接口（`/user/1001`） | `idor` |
| 子域/端口/目录清单 | `dir/port recon` |
| 代码仓库 | `code-audit` |

commander 的 `coverage_query({outcome:"open"})` 返回缺口列表 → 逐项派 agent 或标记 `ruled_out`（必须填控制点）。这样"没发现漏洞"的报告也有说服力，且避免漏测。

### 4.5 上下文治理（四层，缺一不可）

**第 1 层：子 agent 上下文隔离（主力）**
- 每个子 agent 独立进程、独立 session 文件、独立 `appended system prompt`。
- 父 agent 只见 `AgentResult`（硬上限 4KB）：

```ts
interface AgentResult {
  status: "completed" | "failed" | "exhausted" | "aborted";
  summary: string;                 // ≤ 1500 字：做了什么、结论、关键 payload
  facts: string[];                 // fact id 列表（不带正文）
  findings: string[];              // finding id 列表
  open_items: string[];            // 未完成的下一步
  artifacts: string[];             // 关键证据 id
  usage: { turns: number; tokensIn: number; tokensOut: number; cost: number };
}
```
完整日志留在会话 JSONL 与 `agent_events` 表，UI 可看，模型默认不看。

**第 2 层：工具输出有界 + 落盘**
- pi 扩展里统一处理：`tool_result` 超过 8KB（或 400 行）→ 全文写 artifact，模型只看到尾部 + `[已截断，全文 artifact://art-0042，可用 read_artifact 分段读取]`。
- 覆盖对象：`bash`、`run_tool`、`http_send`、`nuclei/nmap` 输出。
- 长任务约定写进工具 description（学 Strix）："长命令请重定向到 `/work/out.log` 后读文件，不要直接读 stdout"。

**第 3 层：外部记忆（Fact Store）**
- 详见 4.3。核心原则：**上下文里只放"结论 + 指针"，原始数据进库**。

**第 4 层：压缩（保底）**
- 配置（`settings.json`，可按模型覆盖）：
```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 20000,
    "keepRecentTokens": 12000,
    "modelOverrides": { "deepseek/deepseek-chat": { "reserveTokens": 24000 } }
  }
}
```
- 默认阈值公式：`contextTokens > contextWindow - reserveTokens`（`docs/compaction.md:29-36`）。
- **自定义摘要**：`session_before_compact` 钩子接管，用安全特化 prompt（学 Strix）：

```
必须分节：目标 / 已验证漏洞(含 URL、payload 逐字) / 凭据与密钥(逐字) / 侦察结论(资产、端口、技术栈)
/ 已排除项(含控制点) / 当前工作状态 / 失败尝试 / 下一步 / 相关 artifact id
要求：EXHAUSTIVE，不要合并、不要去重、不要概括；URL/payload/token 原样复制。
```
- 摘要同时写一份进 Fact Store（`kind=checkpoint`），**即使上下文丢了，事实也不会丢**。

### 4.6 工具层（Toolbox）

#### 4.6.1 分层设计（关键取舍）

| 层 | 内容 | 暴露方式 | 理由 |
|---|---|---|---|
| L1 通用执行 | `bash`（容器内）、`run_tool(tool,args)` | `direct` | 覆盖 90% 场景，模型自己拼参数最灵活 |
| L2 高频 typed | nmap/nuclei/ffuf/httpx/sqlmap/subfinder/katana/dalfox/jwt_tool | `deferred`（`tool_search` 激活） | 常用工具参数正确率高、可预置解析器 |
| L3 MCP | Burp、Shodan、内部资产库、issue tracker | `deferred`/`codemode` | 外部系统能力，不占上下文 |
| L4 平台内建 | `http_send`、`fact_*`、`coverage_*`、`finding_submit`、`dispatch_agent`、`read_artifact` | `direct`（按角色） | 平台语义工具 |

**不要为 150 个工具写 150 个 function schema**：schema 本身就吃 context，而且工具升级要改 schema。L2 只做 Top 10，其余走 L1 + skill 文档。

#### 4.6.2 本地工具定义（YAML，UI 可增删改）

```yaml
id: nuclei
name: Nuclei
category: scanner            # recon|scanner|fuzzer|exploit|proxy|util
risk: active                 # passive|active|intrusive（决定是否需要审批）
runner: docker               # docker|local
image: pentest-toolbox:latest
argv: ["nuclei", "-u", "{target}", "-jsonl", "-o", "/work/nuclei-{runid}.jsonl",
       "-severity", "{severity}", "-t", "{templates}"]
params:
  - { name: target, type: string, required: true }
  - { name: severity, type: enum, values: [critical,high,medium,low,info], default: "critical,high,medium" }
  - { name: templates, type: string, default: "/opt/nuclei-templates" }
limits: { timeoutSec: 1800, maxOutputBytes: 33554432, concurrency: 2 }
output: { format: jsonl, parser: nuclei_v1, artifact: true }
```

执行器要点：
- **argv 数组执行，绝不 shell 拼接**；参数用 zod 校验 → `spawn(argv, {shell:false})` → 容器 `docker exec`。
- 强制 `timeout` + 进程组 kill；输出有界 + 落盘。
- 解析器（`nuclei_v1` / `nmap_xml` / `httpx_jsonl`）把结果转成 fact/finding 候选。
- 工具名启动时断言唯一（避免 MCP 与本地撞名）。

#### 4.6.3 MCP 管理（对应"新增 mcp 链接"）

pi 扩展 API 支持运行期注册（`docs/extensions.md:290-301`）：

```ts
pi.registerMcpServer("burp", { url: "http://127.0.0.1:9876/sse", exposure: "deferred" });
pi.unregisterMcpServer("burp");
```

约束与做法：
- **注册不持久化**：每次 `session_start` 从 orchestrator 拉取项目 MCP 配置并重注册（不要依赖 `.pi/mcp.json` + project trust）。
- `close` 后 `McpClient` 不可重连，必须重建实例（`packages/mcp/src/client.ts:204-250`）。
- 默认 `exposure: "deferred"`（`tool_search` 发现），坏工具不污染上下文；Burp 这类高频目标可设 `direct`。
- 工具箱 UI 功能：增删改、连通性检查（initialize + `listTools`）、工具数/名称预览、OAuth 登录、按角色授权、健康状态、最后错误。
- **依赖缺失 fail loud**：派 agent 前 preflight，所需 MCP/工具不可用 → 直接失败并提示，不要"少个工具照常跑"（学 dsh-pentester）。

#### 4.6.4 Skills 与 Tools 的关系

- Skills = 方法论 + payload 库 + 命令示例（Markdown，可带 scripts）。
- Tools = 执行能力。
- 例：`skills/jwt/SKILL.md` 讲 alg=none/弱密钥/kid 注入的判定与 payload；工具只提供 `jwt_tool` 与 `http_send`。
- 角色白名单：`--skill ./skills/jwt --skill ./skills/http`，未授权的 skill 不会进该 agent 的 system prompt。

### 4.7 审批与 Scope Guard（安全边界）

**四道闸，逐层收紧：**

1. **工具层策略**（pi `tool_call` 钩子，进程内）：
```ts
pi.on("tool_call", async (event, ctx) => {
  const risk = await registry.riskOf(event.toolName, event.input);
  if (risk === "intrusive") {
    const ok = await ctx.ui.select(`批准执行？\n${summarize(event)}`, ["批准", "拒绝"]);
    if (ok !== "批准") return { block: true, reason: "操作者拒绝" };
  }
  const outOfScope = await scope.check(extractTargets(event));   // 解析 URL/IP/域名
  if (outOfScope.length) return { block: true, reason: `超出授权范围: ${outOfScope}` };
});
```
   - 关键：**非 UI 模式 fail-closed**（无审批通道就拒绝），学 `examples/extensions/permission-gate.ts:20-23`。
   - `ctx.ui.*` 在 RPC 模式会变成 `extension_ui_request`，桥到 WebUI。

2. **容器出网**：Docker 自定义网络 + 强制 HTTP/HTTPS 走 mitmproxy，代理按 scope 做域名/IP 白名单；即使 agent 直接写 socket，也在网络层被拦（DNS 层同样限制）。这是真正的技术边界，前一条只是协作约束。

3. **速率与时段**：每目标 QPS 上限、爆破类工具需显式批准并带 `--delay`。

4. **审计**：所有工具调用（argv、目标、审批人、结果摘要）写 append-only `audit.log`；报告附授权信息与测试窗口。

> 诚实声明（写进 README 与报告模板）：以上是工程护栏，**不构成法律授权**。平台只能证明"操作在授权范围内被记录"，不能替代书面授权。

### 4.8 证据链与反捏造

#### 4.8.1 一切 HTTP 动作走平台工具

`http_send` 工具（pi-kit 注册）在容器内发请求，**同时**：
- 记录完整 request/response（raw bytes + headers + timing + TLS 信息）到 artifact，计算 sha256；
- 经 mitmproxy 抓一份旁路证据（防工具日志被模型改写）；
- 返回 `{status, headers, bodyExcerpt, artifact_ids, replay_id}`。

这样"证据"不是模型说的，是工具落盘的。

#### 4.8.2 Finding 闸门（服务端硬校验）

```ts
const FindingInput = z.object({
  title: z.string().min(8),
  category: z.string(),
  severity: z.enum(["critical","high","medium","low","info"]),
  target: z.string(),
  summary: z.string().min(20),
  technical_analysis: z.string().min(30),
  impact: z.string().min(20),
  preconditions: z.array(z.string()),
  evidence_ids: z.array(z.string()).min(1),        // 必须存在且属于本项目
  poc: z.object({
    type: z.enum(["http", "script", "manual"]),
    request_artifact_ids: z.array(z.string()),
    script: z.string().optional(),
    steps: z.array(z.string()).min(1),             // 可复现步骤，至少 1 条
    expect: z.object({                              // 判定成功的客观标志
      match: z.enum(["status", "body_regex", "header_regex", "timing"]),
      value: z.string(),
    }),
  }),
  counterevidence: z.string().min(10),             // 为什么不是误报（必填）
  severity_change_conditions: z.string(),
  confidence: z.enum(["high","medium","low"]),
  confidence_rationale: z.string().min(10),        // 非 high 必须点名缺口
});
```

服务端额外校验（任一失败即拒绝，返回结构化错误让模型自己修）：
1. 所有 `evidence_ids` 真实存在、同项目、可读；
2. `poc.steps` 可执行性（引用的 artifact 存在）；
3. 去重：`dedupe_key` 命中 → 返回 `duplicate_of: finding-xxx`；
4. scope 校验：target 在授权范围内；
5. 非 `high` 置信度必须有 rationale 且不能是空话（长度/关键词检查）。

#### 4.8.3 独立验证者（Verifier）

```
finding 状态 candidate → orchestrator 派 verifier agent（全新进程、全新 session）
      ├─ verifier 只拿到：finding 的 poc + target + scope，看不到 finder 的推理过程
      ├─ verifier 重放 PoC，采集新证据，比对 expect
      ├─ PASS → status=verified，verified_by=verifier，产出新 artifact
      └─ FAIL → status=disputed，附失败证据；人可裁决
```

这一层直接消灭"模型自信地说存在漏洞"的大部分假阳性。报告只导出 `verified`（可配置包含 `candidate` 并明确标注）。

#### 4.8.4 覆盖率账本（解决假阴性）

- 每个资产 × 每个 test_class 一条 `coverage` 记录。
- `ruled_out` 必须写 `control_point`（具体拦截位置：`AuthFilter.java:88` / WAF 规则 ID / 参数化查询实现），并能解释攻击者可达路径为何都会经过它。
- 说不出来 → 只能记 `open_proof_gap`，**不允许为了收工改成 ruled_out**（学 Strix：禁止改账本收工）。
- 报告"未发现漏洞"章节基于 `ruled_out` 列表生成，附控制点证据。

### 4.9 报告与一键复现

#### 4.9.1 报告生成：DB 驱动，不由模型自由写

```
DB findings(verified) + assets + coverage + artifacts
        │
        ├─ 确定性渲染（TS/Jinja 模板）：标题、目标、测试窗口、授权、资产清单、
        │   漏洞列表（每条：描述/影响/复现步骤/请求响应原文/修复建议/证据链接）
        │   覆盖率与已排除项、"未发现"说明
        └─ LLM 只做两件事：① 执行摘要（输入是事实摘要，要求引用 fact id）
                             ② 每条漏洞的"修复建议"润色（必须保留原文事实）
```

产物：
- `report.md`（源，可编辑）
- `report.html`（自包含，证据内嵌截图/请求响应）
- `report.pdf`（Playwright/Chromium 打印）
- `report.sarif`（能直接进 CI/GitHub Code Scanning）
- `poc/<finding-id>/`（见下）
- `evidence.zip`（原始流量与工具输出）

#### 4.9.2 一键复现脚本

每条 verified finding 自动生成：

```
poc/F-003/
├─ README.md          # 复现前提、注意事项、期望结果
├─ repro.sh           # curl 版本（单行可复制）
├─ repro.py           # requests 版本，带断言
├─ verify.py          # 运行 repro 并判定 PASS/FAIL（CI 用）
└─ artifacts/req.txt, resp.bin
```

`repro.py` 由采集到的 HTTP 事务确定性生成：

```python
import requests, sys, re
TARGET = "https://target.example.com/api/fetch"
def main() -> int:
    s = requests.Session()
    s.verify = False
    s.headers.update({"Authorization": "Bearer <占位符，从 artifacts/req.txt 读取>"})
    r = s.post(TARGET, json={"url": "http://169.254.169.254/latest/meta-data/"}, timeout=15)
    ok = r.status_code == 200 and re.search(r"ami-id|instance-id", r.text)
    print("PASS" if ok else "FAIL", r.status_code, len(r.content))
    return 0 if ok else 1
if __name__ == "__main__":
    sys.exit(main())
```

- 凭据/token 默认脱敏成占位符，用户填自己的；导出时可选内联。
- `verify.py` 就是 verifier agent 跑的东西，保证"导出的脚本"和"验证过的 PoC"是同一份代码（不能两套）。

### 4.10 Skills 体系与角色矩阵

```
skills/
├─ recon/        SKILL.md + scripts/      # 子域、端口、指纹、目录、JS 接口提取
├─ sqli/         # 报错/布尔/时间盲注、WAF 绕过 payload
├─ xss/
├─ ssrf/         # 云 metadata、协议、DNS rebinding、gopher
├─ ssti/         # 各模板引擎探测与利用
├─ jwt/          # alg=none、弱密钥、kid/jku、签名混淆
├─ xxe/
├─ upload/
├─ idor/
├─ oauth/
├─ waf-bypass/
├─ code-audit/   # 按语言/框架的 sink 清单
├─ evidence/     # 如何记录证据、写 finding、写 counterevidence
└─ reporting/    # 报告规范（严重性定级、复现写法）
```

角色定义（`roles/*.md`，YAML frontmatter + 系统提示）：

| 角色 | 模型档位 | 工具白名单 | Skills | 能否 dispatch |
|---|---|---|---|---|
| commander | 强 | dispatch/list/fact_*/coverage_*/report_*/ask_user | coordination | ✅ |
| recon | 便宜快 | bash, nmap, subfinder, httpx, naabu, katana, fact_* | recon | ❌ |
| web-vuln | 强 | http_send, ffuf, nuclei, dalfox, fact_*, coverage_* | sqli/xss/ssrf/ssti/upload | ❌ |
| auth | 强 | http_send, jwt_tool, hashcat?, fact_* | jwt/oauth/idor | ❌ |
| code-audit | 强 | read/grep/find/glob（仓库） | code-audit | ❌ |
| exploit | 最强 | bash, http_send, run_tool, fact_* | 对应类 skill | ❌ |
| verifier | 强 | http_send, poc_runner, read_artifact | evidence | ❌ |
| reporter | 中 | fact_query, artifact_read, report_write | reporting | ❌ |

模型档位的意义：recon 用便宜模型跑大量轮次，exploit 用强模型少量轮次——成本能差 5-10 倍。

### 4.11 数据模型与内部 API

**对外 REST（WebUI 用）**：

```
GET/POST   /api/projects
GET/PUT    /api/projects/:id
POST       /api/projects/:id/scope/check
GET        /api/projects/:id/dashboard
CRUD       /api/projects/:id/targets | assets | facts | endpoints
GET        /api/projects/:id/findings           (筛选 status/severity)
POST       /api/projects/:id/findings/:fid/verify
GET        /api/projects/:id/coverage
CRUD       /api/projects/:id/tools | mcp-servers | wordlists | skills
POST       /api/projects/:id/tools/:tid/test-run
POST       /api/agents   { projectId, role, objective, ... }     // 手动派任务
POST       /api/agents/:id/abort | steer
GET        /api/agents/:id/transcript                            // 分页读 events
POST       /api/approvals/:id/decide
POST       /api/projects/:id/reports  { template, format }
GET        /api/artifacts/:id/raw
```

**内部 API（pi-kit 扩展调用，需项目级 token）**：

```
POST /internal/facts            {kind, title, value, dedupeKey, ...} → {id}
GET  /internal/facts?q=&kind=&tags=&limit=
POST /internal/findings         → 校验失败返回 {error:"evidence_missing", detail}
POST /internal/coverage
POST /internal/artifacts        (multipart 或路径注册)
POST /internal/agents           {role, objective, ...} → {agentId}
GET  /internal/brief?agentId=   → Project Brief 文本
POST /internal/approvals        {tool, argv, risk, reason}  (long-poll 等审批)
POST /internal/usage            {tokensIn, tokensOut, cost, turns}
```

**WebSocket 事件（归一化后）**：

```
project.updated
agent.spawned        {agentId, role, parentId, model, tools}
agent.status         {agentId, status, turns, tokens, cost, elapsed}
agent.message.delta  {agentId, messageId, role, index, delta}     // 含 thinking
agent.tool.start     {agentId, toolCallId, tool, argsPreview}
agent.tool.update    {agentId, toolCallId, partial}
agent.tool.end       {agentId, toolCallId, isError, durationMs, outputPreview}
agent.completed      {agentId, result}
fact.created/updated {fact}
finding.created/updated/verified
coverage.updated
approval.requested   {approvalId, agentId, tool, argv, risk, expiresAt}
approval.resolved
report.progress
```

pi 事件 → 领域事件的映射（直接照 `docs/json.md:50-126`）：

| pi 事件 | 领域事件 |
|---|---|
| `agent_start` / `agent_settled` | `agent.status(running/settled)` |
| `message_update.assistantMessageEvent = text_delta/thinking_delta` | `agent.message.delta` |
| `tool_execution_start/update/end` | `agent.tool.*` |
| `message_update.usage` + `get_session_stats` | `agent.status.tokens/cost` |
| `compaction_start/end` | `agent.status(compacting)` + 提示 UI |
| `extension_ui_request` | `approval.requested` / `question.requested` |

### 4.12 pi-kit：唯一的 pi 扩展（业务逻辑收敛点）

```ts
// packages/pi-kit/src/index.ts
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

export default function piKit(pi: ExtensionAPI) {
  const cfg = loadEnvConfig();            // PENTEST_ORCH_URL / PROJECT_ID / AGENT_ID / ROLE / TOKEN
  const api = createOrchClient(cfg);

  // 1) 会话启动：注入项目 brief、按项目配置注册 MCP、注册本地工具
  pi.on("session_start", async (_e, ctx) => {
    const brief = await api.getBrief();
    pi.appendEntry("pentest.brief", { brief, at: Date.now() });   // 持久化但不进上下文
    for (const srv of await api.listMcpServers()) {
      pi.registerMcpServer(srv.name, { ...srv.config, exposure: srv.exposure });
    }
    for (const t of await api.listLocalTools()) registerLocalTool(pi, api, t);
  });

  // 2) 每轮开始前：把 brief 作为结构化提示段注入（不整段替换）
  pi.on("before_agent_start", async (event) => {
    const brief = await api.getBriefCached(60_000);
    return { systemPrompt: `${event.systemPrompt}\n\n${renderBrief(brief)}` };
  });

  // 3) 工具审计 + 风险审批 + scope 拦截
  pi.on("tool_call", async (event, ctx) => {
    const risk = await api.riskOf(event.toolName, event.input);
    if (risk.needsApproval && !(await ctx.ui.select(...))) return { block: true, reason: "denied" };
    const bad = await api.checkScope(extractTargets(event));
    if (bad.length) return { block: true, reason: `out of scope: ${bad}` };
    await api.audit(event);
  });

  // 4) 工具输出截断 + 落盘
  pi.on("tool_result", async (event) => {
    const { content, artifactIds } = await api.boundOutput(event);
    return { content };
  });

  // 5) 业务工具
  pi.registerTool(defineTool({ name: "fact_write", ... }));
  pi.registerTool(defineTool({ name: "fact_query", ... }));
  pi.registerTool(defineTool({ name: "http_send", ... }));
  pi.registerTool(defineTool({ name: "finding_submit", ... }));
  pi.registerTool(defineTool({ name: "coverage_update", ... }));
  pi.registerTool(defineTool({ name: "dispatch_agent", ... }));     // 仅 commander 激活
  pi.registerTool(defineTool({ name: "read_artifact", ... }));
}
```

要点：
- **只维护一个扩展**，加载方式 `-e <dist/index.js>`；不要动 pi 源码，升级 pi 只需重新验证。
- 工具按角色激活：**第一道用 CLI `--tools`（进程级，模型根本看不到）**，扩展内再按 `PENTEST_ROLE` 调 `pi.setActiveTools([...])` 做第二道校验（机制上主 agent 拿不到 bash）。
  注意 `--tools` 语义是"替换默认选择"的 allowlist，内置工具、扩展工具、自定义工具一视同仁（`docs/cli.md`），所以每个角色的清单必须是"内置 ∪ pi-kit"两部分合并，否则会静默丢工具。
- 长连接资源放 `session_start`，`session_shutdown` 里幂等清理（`docs/extensions.md:56-60`）。

---

## 5. WebUI 实现方案

### 5.1 工程结构

```
apps/web/src/
├─ routes/                      # TanStack Router
│  ├─ projects/                # 列表、新建向导（目标/scope/授权确认）
│  └─ project.$id/
│     ├─ overview.tsx          # 仪表盘：阶段、覆盖度、成本、活跃 agent
│     ├─ agents.tsx            # Agent 树 + 时间线 + 实时流
│     ├─ assets.tsx            # 资产/端点/事实看板
│     ├─ findings.tsx          # 漏洞列表 + 详情（证据查看器）
│     ├─ coverage.tsx          # 覆盖率账本
│     ├─ toolbox.tsx           # 本地工具 + MCP + 字典
│     ├─ skills.tsx            # 角色与技能编辑
│     └─ report.tsx            # 报告预览/编辑/导出
├─ components/
│  ├─ agent/AgentTree.tsx, AgentTimeline.tsx, LiveTranscript.tsx, TerminalPane.tsx
│  ├─ evidence/HttpExchangeViewer.tsx   # 类 Burp 的请求/响应双栏
│  ├─ finding/FindingForm.tsx, PocViewer.tsx
│  └─ toolbox/ToolEditor.tsx, McpServerForm.tsx
├─ lib/ws.ts                   # WS 客户端：重连 + lastEventId 续传
└─ lib/api.ts                  # OpenAPI 生成（建议后端出 /openapi.json）
```

### 5.2 核心页面设计

**① 项目台（Overview）**
- 顶部：目标、阶段、授权状态、运行时长、总花费
- 卡片：资产数 / 已确认漏洞（按严重度）/ 覆盖缺口 / 活跃 agent
- 中部：攻击面覆盖率热力（资产 × test_class）
- 底部：最近事件流（跨 agent 合并时间线）

**② Agent 视图（最核心）**
- 左：**Agent 树**（commander 为根，子任务为节点；节点显示 role、状态、耗时、tokens、成本）
- 右上：选中 agent 的 **实时 transcript**（assistant 文本 + thinking 折叠 + 工具卡片）
- 右下：**实时终端**（xterm.js 显示容器内 bash 输出流）
- 操作：abort、steer（给运行中 agent 补充指令）、fork（从某条消息分支重试）、查看原始 JSONL
- 工具卡片可展开原始 argv、stdout、退出码、artifact 链接

**③ 资产与事实看板**
- 表/图切换；事实卡片显示 kind、confidence、来源 agent、证据链接
- 支持手动添加（人工情报）与手动标记 `stale/refuted`
- 关系图（xyflow）：资产 → 端点 → 事实 → 漏洞

**④ 漏洞与证据**
- 列表：严重度、状态、置信度、验证人
- 详情：描述 / 技术分析 / 影响 / 复现步骤 / **请求-响应原文**（Burp 式高亮、可折叠、可复制 curl）/ 证据截图 / counterevidence / 修复建议
- 按钮：运行验证（触发 verifier）、导出 PoC、标记误报

**⑤ 工具箱**
- Tab1 本地工具：列表（名称、类别、风险、状态）+ YAML 编辑器 + 参数表单 + "试运行" + 解析结果预览 + 导入/导出
- Tab2 MCP：服务器列表（transport、状态、工具数、最后错误）+ 新增向导（stdio 命令 / HTTP URL + headers + OAuth）+ 健康检查 + 工具预览 + 按角色授权
- Tab3 字典：上传/管理，显示行数与标签，供工具参数引用
- Tab4 平台内建工具：`http_send` 等开关（一般不用改）

**⑥ 报告**
- 模板选择、章节勾选、严重度阈值
- 左侧编辑（Monaco Markdown）、右侧预览（实时渲染）
- 导出：MD / HTML / PDF / SARIF / poc.zip / evidence.zip

### 5.3 实时性实现

- WS 消息带单调 `seq`；前端按 agentId 维护消息缓冲，`message.delta` 增量拼接，收到 `message_end` 时用权威消息替换（pi 的规则：`message_end` 才是权威，`docs/json.md`）。
- 断线重连：客户端带 `lastSeq` 请求重放（服务端从 `agent_event` 表分页补发）。
- 高频 delta 在前端做 16-33ms 合批（requestAnimationFrame），避免 React 重渲染打爆。
- 大输出（终端）走独立 WS 通道 + 二进制分帧，避免与业务事件互相拖慢。

### 5.4 审批桥（RPC extension UI）

pi 在 RPC 模式下把 `ctx.ui.confirm/select/input` 变成 `extension_ui_request` 记录（`docs/rpc-extension-ui.md`）。链路：

```
pi 子进程 --extension_ui_request--> orchestrator --> WS --> WebUI 弹窗
WebUI 确认 --> POST /api/approvals/:id/decide --> orchestrator --extension_ui_response--> pi
超时（默认 120s）--> 自动 deny（fail-closed）
```

注意：`ctx.ui.custom()`、theme、footer 在 RPC 模式不可用或降级，所以**审批只用 select/confirm/input/editor 四种**，不要设计依赖自定义 TUI 组件的交互。

---

## 6. 关键代码骨架

### 6.1 启动一个角色 agent（orchestrator 侧）

```ts
// packages/agent-runtime/src/spawn.ts
import { spawn } from "node:child_process";

export function spawnAgent(project: Project, spec: AgentSpec) {
  const rolePrompt = `${project.workspace}/roles/${spec.role}.md`;
  const args = [
    "--mode", "rpc",
    "--session-dir", `${project.workspace}/sessions`,
    "--name", `${spec.role}-${spec.seq}`,
    "--model", ROLE_MODEL[spec.role],
    "--thinking", ROLE_THINKING[spec.role],
    "--tools", ROLE_TOOLS[spec.role].join(","),
    "--append-system-prompt", rolePrompt,
    "-e", PI_KIT_ENTRY,
  ];
  for (const s of ROLE_SKILLS[spec.role]) args.push("--skill", `${project.workspace}/skills/${s}`);

  const child = spawn(process.execPath, [PI_CLI, ...args], {
    cwd: project.workspace,
    env: { ...process.env, ...internalEnv(project, spec) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return attachRpc(child, spec);   // 逐行解析 JSONL，按 id 关联 response，事件转领域事件
}
```

### 6.2 `dispatch_agent` 工具（pi-kit 侧）

```ts
pi.registerTool(defineTool({
  name: "dispatch_agent",
  label: "派发子 Agent",
  description:
    "把一个自包含的子任务派发给专职 agent。必须写清：目标、要验证的假设、成功判据。" +
    "本工具立即返回，子 agent 完成后会以系统通知唤醒你。禁止用它做宽泛侦察而不给判据。",
  parameters: Type.Object({
    role: Type.Union([...ROLES].map((r) => Type.Literal(r))),
    objective: Type.String({ description: "目标 + 假设 + 判据，一句话" }),
    targets: Type.Array(Type.String()),
    inputs: Type.Optional(Type.Object({
      fact_ids: Type.Optional(Type.Array(Type.String())),
      artifact_ids: Type.Optional(Type.Array(Type.String())),
    })),
    budget: Type.Optional(Type.Object({
      maxTurns: Type.Optional(Type.Number()),
      maxMinutes: Type.Optional(Type.Number()),
    })),
  }),
  async execute(_id, params) {
    const r = await api.dispatchAgent(params);
    return {
      content: [{ type: "text", text: `已派发 ${r.agentId}（${params.role}），完成后自动通知。` }],
      details: r,
    };
  },
}));
```

### 6.3 `http_send` 工具（证据采集核心）

```ts
pi.registerTool(defineTool({
  name: "http_send",
  label: "发送 HTTP 请求（留证）",
  description: "所有针对目标的 HTTP 交互必须用它。完整请求/响应会落证据库。",
  parameters: Type.Object({
    method: Type.String(), url: Type.String(),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    body: Type.Optional(Type.String()),
    followRedirects: Type.Optional(Type.Boolean()),
  }),
  async execute(_id, p) {
    const r = await api.httpSend(p);     // 容器内执行 + mitmproxy 旁路 + 落盘
    return {
      content: [{ type: "text", text: r.excerpt }],
      details: { status: r.status, artifactIds: r.artifactIds, replayId: r.replayId },
    };
  },
}));
```

### 6.4 审批 + scope 拦截

```ts
pi.on("tool_call", async (event, ctx) => {
  const decision = await api.preflight(event.toolName, event.input);
  if (decision.block) return { block: true, reason: decision.reason };
  if (decision.needsApproval) {
    const choice = await ctx.ui.select(
      `⚠ 高风险操作\n${decision.summary}`,
      ["批准本次", "本会话内全部批准", "拒绝"],
    );
    if (choice === "拒绝") return { block: true, reason: "操作者拒绝" };
    if (choice === "本会话内全部批准") api.approveForSession(decision.riskClass);
  }
});
```

### 6.5 Finding 提交（服务端校验伪代码）

```ts
app.post("/internal/findings", async (req, reply) => {
  const input = FindingInput.parse(req.body);                 // zod 直接抛 422
  const arts = db.artifacts.byIds(input.evidence_ids);
  const missing = input.evidence_ids.filter((id) => !arts.some((a) => a.id === id));
  if (missing.length) return reply.code(409).send({ error: "evidence_missing", missing });
  if (!scope.allows(input.target)) return reply.code(403).send({ error: "out_of_scope" });

  const key = dedupeKey(input);
  const dup = db.findings.byKey(req.projectId, key);
  if (dup) return reply.code(200).send({ duplicate_of: dup.id });

  const finding = db.findings.insert({ ...input, projectId: req.projectId,
    status: "candidate", foundBy: req.agentId, dedupeKey: key });

  queue.enqueue({ type: "verify", findingId: finding.id });   // 自动派 verifier
  return { id: finding.id, status: "candidate", next: "verification_queued" };
});
```

### 6.6 PoC 生成（确定性）

```ts
export function generateCurl(ex: HttpExchange): string {
  const h = ex.request.headers.map(([k, v]) =>
    `-H ${shQuote(`${k}: ${v}`)}`).join(" \\\n  ");
  const b = ex.request.body ? ` \\\n  --data-raw ${shQuote(ex.request.body)}` : "";
  return `curl -k -i -X ${ex.request.method} ${shQuote(ex.request.url)} \\\n  ${h}${b}`;
}

export function generatePython(f: Finding, ex: HttpExchange): string {
  return `import requests, re, sys
TARGET = ${JSON.stringify(ex.request.url)}
HEADERS = ${JSON.stringify(Object.fromEntries(ex.request.headers))}
BODY = ${JSON.stringify(ex.request.body)}
EXPECT = {match: ${JSON.stringify(f.poc.expect.match)}, value: ${JSON.stringify(f.poc.expect.value)}}

def main() -> int:
    r = requests.request(${JSON.stringify(ex.request.method)}, TARGET,
                         headers=HEADERS, data=BODY, verify=False, timeout=20)
    if EXPECT["match"] == "status":
        ok = str(r.status_code) == EXPECT["value"]
    elif EXPECT["match"] == "body_regex":
        ok = re.search(EXPECT["value"], r.text) is not None
    else:
        ok = False
    print("PASS" if ok else "FAIL", r.status_code, len(r.content))
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
`;
}
```

---

## 7. 目录结构与仓库规划

```
pi-pentest/
├─ apps/
│  ├─ web/                     # React + Vite
│  └─ server/                  # Fastify：REST + WS + 编排器
├─ packages/
│  ├─ agent-runtime/           # spawn/RPC 封装、事件归一化、角色配置
│  ├─ orchestration/           # 调度器、预算、审批 broker、唤醒
│  ├─ pi-kit/                  # ★ 唯一的 pi 扩展（业务工具 + hooks）
│  ├─ domain/                  # zod schema + 类型（fact/finding/evidence/report）
│  ├─ toolbox/                 # 工具注册表、执行器、解析器、MCP 管理
│  ├─ report/                  # 模板、PoC 生成、导出（md/html/pdf/sarif）
│  └─ db/                      # drizzle schema + migration
├─ roles/                      # commander.md / recon.md / ...
├─ skills/                     # 方法论 + payload 库
├─ docker/
│  ├─ toolbox/Dockerfile       # kali-rolling + 工具集 + pi 运行时依赖
│  └─ egress/                  # mitmproxy + scope 白名单配置
├─ projects/                   # 运行时数据（gitignore）
├─ docker-compose.yml          # server + web + ubuntu 容器模板
└─ package.json                # workspace
```

**依赖版本**：`@earendil-works/pi-coding-agent` 精确锁 `1.3.0`（`save-exact`），升级前跑回归清单（第 9 章）。

---

## 8. 分阶段实施路线

| 阶段 | 周期 | 交付 | 验收标准 |
|---|---|---|---|
| **P0 打通** | 1 周 | 单 agent 能跑：spawn `pi --mode rpc`、WS 实时看 transcript、容器内 bash、项目 CRUD | 在 Web 上看到一个 agent 扫描靶场并实时输出 |
| **P1 记忆** | 1.5 周 | Fact Store + `fact_write/query` + Project Brief 注入 + 工具输出截断落盘 | 两个 agent 会话之间能传递信息 |
| **P2 编排** | 2 周 | `dispatch_agent` + 异步唤醒 + 角色/白名单 + 预算/并发 + Agent 树 UI | 主 agent 判出 JWT 后能派子 agent 并收回结论 |
| **P3 证据** | 2 周 | `http_send` 留证 + Finding schema 闸门 + verifier 重放 + 证据查看器 | 假 finding 被 verifier 拦下，真 finding 有完整流量 |
| **P4 工具箱** | 1.5 周 | Tool Registry + YAML 编辑/试跑 + MCP 管理 + 字典 + `tool_search` | 用户加一个 nuclei 工具，agent 立刻能用 |
| **P5 交付** | 1 周 | 报告模板 + PDF/HTML/SARIF + poc.zip + 覆盖率章节 | 一条真实漏洞的报告可一键复现 |
| **P6 加固** | 持续 | 容器出网白名单、审批队列、审计、限流、成本面板 | 越界请求在网络层被拦并留痕 |

MVP = P0+P1+P2（约 4.5 周，单人），能演示"主 agent 调度 + 信息共享"；完整产品 = P0-P6（约 9-10 周）。

---

## 9. 风险、坑与对策

### 9.1 pi 框架层（源码已验证）

| 坑 | 证据 | 对策 |
|---|---|---|
| `agent_end` 不是终点 | `docs/rpc.md:67-71` | 一律等 `agent_settled` |
| RPC 用 `readline` 会错切 U+2028/29 | `docs/rpc.md:50-56` | 自己按 LF 切 Buffer；或用 `RpcClient` |
| SDK 不加载内置 MCP/codemode/tool_search | `docs/sdk.md:114-118` | 生产直接用 RPC 模式；SDK 仅测试 |
| 忘了 `bindExtensions()` → 扩展收不到 `session_start` | `examples/sdk/14-codemode-mcp.ts:48-51` | 走 RPC 自动触发；SDK 路径写死调用 |
| 工具不能注销 | `docs/extensions.md:256` | 动态工具用 `exposure:"hidden"` 或同名重注册 |
| `tool_call` 里改参数不再校验 | `src/core/extensions/types.ts:1250-1254` | 安全策略独立校验，不依赖 schema |
| 无 UI 模式必须 fail-closed | `examples/extensions/permission-gate.ts:20-23` | 审批超时/无通道 = 拒绝 |
| `--tools` 是替换式 allowlist，扩展工具名漏写会被静默禁用 | `docs/cli.md`（"allowlist of built-in, extension, or custom tools"） | 角色工具清单 = 内置 ∪ pi-kit 合并生成，启动时断言 |
| MCP 注册不持久化 | `docs/extensions.md:290-301` | 每次 `session_start` 从 orchestrator 重拉 |
| 扩展 = 任意代码执行 | `docs/security.md:88-91` | 只加载自己维护的 `pi-kit`，拒绝项目内第三方扩展 |
| 版本 API 变动 | 文档多处指向 `dist/*.d.ts` | 锁定 1.3.0；CI 跑 `pi-runtime` 回归 |

### 9.2 产品/工程层

| 风险 | 影响 | 对策 |
|---|---|---|
| **上下文丢 finding** | 报告缺项、重复测试 | 四层治理 + 摘要里"逐字保留 payload" + 事实直写库 |
| **假阳性** | 报告不可信 | schema 闸门 + 证据反查 + 独立 verifier 重放 |
| **假阴性（没测却说安全）** | 更危险 | Coverage 账本三态；`ruled_out` 必须写控制点 |
| **全自主成功率低** | 用户失望 | 公开 benchmark：全自主 ~21%，人机协同 ~64%。设计必须有人审点（审批/阶段推进/报告确认） |
| **成本失控** | 账单爆炸 | 角色级模型档位 + 每 agent/每项目预算 + 实时成本面板 + 到限 abort |
| **长命令打爆上下文** | 会话崩 | 工具输出有界 + 落盘 + 教模型后台跑重定向 |
| **MCP/工具缺失静默降级** | 误判"无漏洞" | preflight fail loud（学 dsh-pentester） |
| **并发写 SQLite** | 数据损坏 | orchestrator 单写；pi 扩展只走 HTTP |
| **agent 进程泄漏** | 宿主机卡死 | 容器 + 进程组 kill + 看门狗 + 每 agent 墙钟上限 |
| **法律风险** | 严重 | 授权问卷 + scope 强制 + 审计 + 文档写明"护栏≠授权" |
| **枚举/爆破误伤** | 目标宕机 | QPS 限制 + intrusive 审批 + `--delay` 强制 |

### 9.3 与参考实现的取舍

| 决策点 | Strix | dsh-pentest(er) | 本方案 |
|---|---|---|---|
| 主 agent 权限 | prompt 约束 | 机制 allow-list | **机制 allow-list + 工具白名单** |
| 子 agent 上下文 | `inherit_context` 可关 | 直写存储 | 隔离 + 直写 + 结构化摘要 |
| 事实存储 | notes + coverage 账本 | sqlite 六表 | SQLite 领域表 + FTS5 |
| 证据闸门 | 必填 + 反查 Caido | `reproducibleSteps` 必填 | zod 闸门 + artifact 反查 + verifier |
| 覆盖率 | 三态账本 | 无 | 三态账本（照抄 Strix） |
| 执行环境 | Kali 容器 | Docker/SSH 冻结 | 每项目容器 + 出网代理 |
| 报告 | 模板 + SARIF | Markdown | 确定性模板 + PDF/SARIF/poc.zip |
| 前端 | 本地 viewer | 会话内 Tab | **独立平台 WebUI**（本项目核心差异） |
| 上下文超限 | checkpoint 压缩 | 父只收摘要 | 四层治理 + 安全特化摘要 |

---

## 10. 需要你确认的决策点

1. **部署形态**：单机自用（本地 Docker）还是多人多项目（需要用户/租户隔离、任务队列、K8s）？这决定编排层复杂度差 2-3 倍。
2. **目标环境**：目标只有 Web/API，还是要覆盖内网/AD/云？后者需要跳板机（`pi-env` SSH）与内网横向工具。
3. **模型来源**：用哪家？是否需要本地模型（Ollama/vLLM）？影响 `pi-ai` 配置与成本模型。
4. **容器方案**：Docker Desktop 可用吗？还是要兼容 Windows 原生（pi 的官方 sandbox 示例只支持 macOS/Linux）？
5. **是否接受"人审点"**：审批 + 阶段推进 + 报告确认。完全无人值守在当前成功率下不现实。
6. **报告规范**：面向甲方交付（需要授权/免责/定级）还是 SRC 提交（要贴合平台模板）？
7. **是否要代码审计能力**：需要的话，仓库克隆与索引是一块独立工作量（可达 P7）。
8. **MVP 优先级**：先做"能演示调度"还是先做"报告可信"？建议前者（P2 后再补 P3 的证据闸门）。

---

## 附录 A：pi 关键 API 速查（已在本仓库确认）

```
createAgentSession(options)                      src/core/sdk.ts:191
  options.cwd / model / thinkingLevel / tools / excludeTools / customTools
  options.sessionManager / resourceLoader / settingsManager        src/core/sdk.ts:48-106
defineTool({name,label,description,parameters,execute})           examples/extensions/hello.ts:8
ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx) src/core/extensions/types.ts:650
pi.registerTool / registerCommand / registerMcpServer / unregisterMcpServer
pi.on(<event>)  // input, before_agent_start, tool_call, tool_result, session_start, …  types.ts:1405
pi.setActiveTools / getAllTools / getActiveToolNames / appendEntry / sendMessage
SessionManager.create / open / inMemory / forkFrom               src/core/session-manager.ts:1755+
RpcClient.start/prompt/steer/abort/waitForIdle/getState/compact  src/modes/rpc/rpc-client.ts
CLI: --mode rpc|json|print  --tools --exclude-tools --no-builtin-tools
     -e/--extension  --skill/--no-skills  --session-dir  --name
     --model  --thinking  --append-system-prompt  --approve/--no-approve
```

## 附录 B：调研来源（一手）

- pi 源码：`packages/coding-agent/docs/{sdk,rpc,rpc-commands,json,extensions,compaction,skills,mcp,session-format}.md`、`examples/extensions/{subagent,tool-override,dynamic-tools,permission-gate,sandbox,ssh}.ts`
- Strix：https://github.com/usestrix/strix （`strix/skills/coordination/root_agent.md`、`strix/tools/reporting/tool.py`、`strix/llm/compaction.py`）
- dsh-pentest：https://github.com/howmp/dsh-pentest （`src/dsh-pentest/src/instructions.ts`）
- dsh-pentester：https://github.com/fb0sh/dsh-pentester （`docs/architecture.md`）
- PentestGPT：https://github.com/GreyDGL/PentestGPT （arXiv:2308.06782）
- CAI：https://github.com/aliasrobotics/cai （`docs/cai_architecture.md`）
- XBOW：https://xbow.com/blog/alloy-agents 、https://xbow.com/blog/how-xbow-deduplicates-findings
- AutoPenBench：arXiv:2410.03225；VulnBot：arXiv:2501.13411
- PortSwigger Burp MCP：https://github.com/PortSwigger/mcp-server
- HexStrike AI：https://github.com/0x4m4/hexstrike-ai

---

## 附录 C：从零到能跑 —— 物料清单（BOM）

> 结论：**pi + WebUI 不够**。pi 是"agent 运行时"，不是一个 Web 后端；WebUI 只是仪表盘。
> 中间那层（编排 + 领域存储 + 工具执行 + 权限）不存在于 pi 里，也不该塞进 WebUI。

### C.0 为什么直连不行（先排除错误方案）

| 想省掉的层 | 直接后果 |
|---|---|
| 不做 orchestrator，WebUI 直接调 pi | 浏览器连不上 stdin/stdout 子进程；没有鉴权、没有多项目隔离、没有事件聚合；一个 agent 崩溃前端全黑 |
| 不做领域存储，用 pi 会话文件当数据库 | 会话 JSONL 是对话记录不是结构化 finding；报告没法生成、无法去重、无法跨 agent 查询 |
| 不做沙箱，用 pi 内置 bash | 工具以宿主权限跑（pi 明确无沙箱），一条 `rm -rf` 就是灾难 |
| 不做编排，靠一个 agent 全干完 | 上下文必然爆炸；单会话超过 30min 就丢早期发现；无法并行 |
| 不做审批，靠 prompt 自律 | 无 UI 模式 fail-open，自动化跑飞；无审计，出事无法回溯 |

### C.1 代码组件（8 个，按依赖顺序）

| # | 组件 | 职责 | 关键技术点 | 规模 |
|---|---|---|---|---|
| 1 | `packages/db` + `domain` | SQLite schema、zod 类型、迁移 | fact/finding/evidence/coverage 闸门校验 | 600 行 |
| 2 | `packages/agent-runtime` | spawn pi、解析 JSONL、归一化事件 | 按 LF 切分、`agent_settled` 判完成、abort/steer | 800 行 |
| 3 | `packages/pi-kit` | 唯一 pi 扩展：工具 + hooks | `--tools` 合并、审批 fail-closed、输出截断落盘 | 1200 行 |
| 4 | `apps/server` 编排 | 调度、预算、并发、唤醒、审批 broker | 状态机、事件广播、内部 API | 1500 行 |
| 5 | `packages/toolbox` | 工具注册表、argv 执行、解析器、MCP 管理 | 无 shell 拼接、超时/进程组 kill、fail loud | 800 行 |
| 6 | `packages/report` | 模板渲染、PoC 生成、导出 | md/html/pdf/sarif、request→curl/python | 700 行 |
| 7 | `apps/web` | 5 个页面 + WS 客户端 | 事件合批、断线重放、xterm | 3000 行 |
| 8 | `docker/` + 部署 | Kali 镜像、mitmproxy、compose | 出网白名单、卷挂载、资源限制 | 500 行 |

### C.2 运行时基础设施

- Node.js ≥ 22.19（pi 硬要求）；npm/pnpm workspace
- Docker（或 Podman）：每项目一个容器；Kali rolling 或自建 toolbox 镜像
- mitmproxy（容器旁路抓证 + 出网白名单）
- SQLite（WAL）起步；多用户再换 Postgres
- 文件存储：artifacts / 会话 / 报告（本地盘即可，别用数据库存大文件）
- 反向代理（Caddy/Nginx）：HTTPS、静态资源、WS 升级
- 日志与审计：append-only 文件 + 可选 Loki

### C.3 领域资产（非代码，但决定上限）

| 资产 | 说明 | 没有会怎样 |
|---|---|---|
| `roles/*.md` | 8 个角色的系统提示与工具白名单 | agent 行为不可控，主 agent 会自己下场 |
| `skills/*/SKILL.md` | recon/sqli/ssrf/ssti/jwt/xxe/idor/upload/oauth/waf/code-audit | 模型靠通用知识猜 payload，成功率低且不可复现 |
| Tool Registry YAML | 10-20 个高频工具的参数与解析器 | 每次让模型自己拼命令行，参数错误率高 |
| 字典库 | 目录/子域/密码/参数名 | 爆破类测试无法开展 |
| 报告模板 + 定级标准 | CVSS 或国标，含免责/授权章节 | 交付物不可用 |
| scope 规则 | 域名/CIDR/排除项/QPS/时段 | 无法做技术层面的越界拦截 |
| 靶场 | Juice Shop / DVWA / 自建 | 没法在合法目标上迭代，只能拿真实目标试错 |

### C.4 账号、凭据与合规

- 模型 provider API key（至少 2 个：强模型 + 便宜模型，用于角色分档）
- 目标系统的**书面授权**（scope、时间窗、联系人、紧急停止方式）
- secrets 管理：目标凭据/API key 加密存储，不要放项目目录明文
- 成本上限（token 预算 + 告警）

### C.5 需要的人（如果要做成产品）

- 审批人：处理 intrusive 操作（爆破、上传、写入类）
- 报告复核人：确认 severity 与 counterevidence
- 若坚持全自动：至少要有"阶段推进确认"和"报告发布确认"两个卡点（公开 benchmark 全自主成功率 ~21%）

### C.6 三档实现范围（按投入选）

| 档位 | 保留 | 砍掉 | 工期 |
|---|---|---|---|
| **A. 只读看板** | pi 交互模式 + Web 读会话 JSONL 渲染 | 编排、存储、审批、沙箱 | 3-5 天 |
| **B. 单人可用（推荐先做）** | C.1 全部 8 个组件 + 单容器 + 审批 + 报告 | 多租户、MCP 市场、SARIF、代码审计 | 4-6 周 |
| **C. 团队产品** | + 用户/租户隔离、任务队列、K8s、审计合规 | — | 3-6 个月 |

### C.7 "只做 pi + WebUI" 会在哪 6 个地方卡死

1. **主 agent 判出 JWT 要派子 agent**：pi 没有 subagent 工具，你得自己写扩展 + 进程管理（官方示例只回最终文本，没有任务树/状态/UI）。
2. **子 agent 结论怎么回给父 agent**：没有共享存储就只能塞上下文 → 立刻回到上下文爆炸。
3. **漏洞证据在哪**：pi 只有会话 JSONL，没有结构化 finding，报告无法从会话可靠生成、无法去重。
4. **审批**：pi 有 `tool_call` hook，但没有队列/UI/超时/审计；RPC 的 `extension_ui_request` 需要你自己实现客户端。
5. **工具在容器里跑**：pi 的 bash 是宿主进程权限。
6. **重启后继续**：会话能恢复，但"任务跑到哪、哪些资产测过"没人记。

### C.8 第一周 checklist（P0）

```
[ ] 装 Node 22.19 + Docker，拉 kali 镜像
[ ] npm i @earendil-works/pi-coding-agent@1.3.0（锁版本）
[ ] 跑通 `pi --mode rpc`，用 10 行脚本发 prompt 收事件
[ ] 写 pi-kit 最小版：1 个 echo 工具 + tool_call 打印
[ ] spawn 一个 agent，JSONL 转发到 WS，浏览器看到流式输出
[ ] 建项目表 + 一条 fact，页面能读写
[ ] 目标用 Juice Shop，确认 agent 能执行 nmap/httpx
```
走完这一周，你会亲眼看到"缺的那层"具体长什么样——这比看文档快。

---

## 附录 D：开发计划（以"主 agent 调度子 agent"为核心骨架）

### D.1 五条开发原则

1. **先立骨架，再长肉**：第 2 周结束前必须有一条"用户 → 主 agent → 子 agent → 事实落库 → 主 agent 被唤醒 → 回答"的完整链路，哪怕工具只有 `bash`、没有审批、没有容器。
2. **每一里程碑都要能演示**：拒绝"写了三周还跑不起来"。每个 M 的验收标准都是可执行脚本。
3. **先确定性的靶场，再真实目标**：自建 mock 目标（下一节），避免早期拿真实站点试错（法律 + 不可复现）。
4. **核心风险前置**：真正难的不是 UI，是"子 agent 完成后怎么可靠唤醒父 agent""父进程崩溃后状态怎么办""上下文怎么不炸"。这些必须在 M1/M2 解决，不能留到最后。
5. **故意不做清单**：每个阶段明确列出"这阶段不做什么"，防止范围蔓延（见 D.5）。

### D.2 里程碑总览（单人全职，单位：工作日）

| 里程碑 | 目标 | 交付 | 验收 | 工期 |
|---|---|---|---|---|
| **M0** | 跑通 pi RPC | 10 行脚本 + 一个 spawn 封装 | 命令行发 prompt，逐行收到 JSON 事件 | 2 天 |
| **M1** | **主→子调度闭环（核心骨架）** | server + runtime + pi-kit 最小版 + 最小 UI | 主 agent 判出 JWT 并派子 agent，子 agent 写事实，主 agent 收到通知并总结 | 5-7 天 |
| **M2** | 可靠性与可恢复 | 预算/超时/级联 abort/事件落库/重启恢复 | `kill -9` server 重启后任务可续；子 agent 卡死能被超时杀掉 | 4 天 |
| **M3** | 真实工具与上下文治理 | Tool Registry + 3 个真实工具 + 截断落盘 + 容器执行 | `nmap -p-` 全量输出不炸上下文；新加 YAML 工具重启后可用 | 5 天 |
| **M4** | 证据与防捏造 | `http_send` + artifact + finding 闸门 + verifier | 真漏洞有完整请求响应；编造的漏洞被服务端拒绝 | 5 天 |
| **M5** | 报告与复现 | 模板 + PoC 生成 + 导出 | 导出 `poc.zip`，在干净环境跑通 `repro.py` | 4 天 |
| **M6** | 工具箱与 skills | MCP 管理 UI + 工具 UI + skills 目录 + 角色配置 | 用户在 UI 加 MCP server，agent 下一轮就能用 | 8 天 |
| **M7** | 加固 | 出网白名单、审批队列、多项目、审计 | 越界请求在网络层被拦并留痕 | 持续 |

**关键路径：M0 → M1 → M2 → M3 → M4 → M5。** M6 可与 M4/M5 并行（前端人手独立时）。

### D.3 各里程碑任务拆解

#### M0（2 天）：先证明 pi 能按你想的方式被驱动

```
[ ] 锁定 @earendil-works/pi-coding-agent@1.3.0（save-exact）
[ ] 手写 spawn：pi --mode rpc --no-session，发 {"type":"prompt"}，按 LF 切 stdout
[ ] 打印事件：message_update(text_delta) / tool_execution_* / agent_settled
[ ] 验证三件事：① 中途 abort 生效 ② 工具审批 hook 能拦截 ③ 会话文件落在 --session-dir
[ ] 写成 agent-runtime/ 的 50 行原型（后面会被重写，别过度设计）
```
> 目的不是写代码，是**亲手确认协议细节**：`agent_settled` 才算完成、不能用 `readline`、stdout 只有协议数据。

#### M1（5-7 天）：主→子调度闭环 ★核心

**数据层（1 天）**
```
[ ] SQLite + drizzle：project / agent_run / agent_event / fact 四张表
[ ] 迁移脚本 + 一个 seed 项目
```

**运行时（1.5 天）**
```
[ ] AgentHandle：spawn(args) → 读 JSONL → 状态机(queued→running→settled|failed|aborted)
[ ] AgentSupervisor：Map<agentId, handle>；并发上限 4；级联 abort
[ ] 完成判定：等 agent_settled；异常/超时兜底
[ ] 事件写入 agent_event（seq 单调），同时进 EventBus
```

**pi-kit 最小版（1.5 天）**
```
[ ] dispatch_agent 工具：POST /internal/agents，立即返回 agent_id
[ ] fact_write / fact_query 工具：读写 /internal/facts
[ ] session_start：拉 brief → appendEntry（持久化不进上下文）
[ ] before_agent_start：把 brief 拼进 systemPrompt（缓存 60s）
[ ] 按 PENTEST_ROLE 用 --tools 收紧工具面（commander 无 bash）
```

**编排（1 天）**
```
[ ] POST /internal/agents → 入队 → spawn 子进程
[ ] 子 agent settled → 落库 → 给父 agent 发 RPC prompt（唤醒）
[ ] 唤醒消息模板：结构化摘要（≤1500 字 + fact id 列表），60s 内批量合并
```

**接口与 UI（1.5 天）**
```
[ ] WS 广播：agent.spawned / status / message.delta / tool.* / completed
[ ] 前端：左 agent 树（父子缩进 + 状态点 + 耗时），右 transcript（文本 + 工具卡片）
[ ] 点树节点切换 transcript；支持 abort 按钮
```

**M1 验收脚本（固定输入，必须可重复）**
```
用户：审计 http://mock-target:8080，确认登录接口是否用 JWT；若是，派子 agent 检查 HS256 密钥强度

期望链路：
  1. commander 派 recon-1
  2. recon-1 发现 POST /api/login + JWT(HS256)，写 fact-001 / fact-002
  3. commander 被唤醒，fact_query 看到 JWT 事实
  4. commander 派 auth-1，inputs.fact_ids=[fact-002]
  5. auth-1 读事实、暴力破解密钥、写 fact-003（密钥=secret）
  6. commander 收到两条通知，输出结论 + 引用 fact id
  7. UI 上可见 3 个 agent 节点，各自 transcript 完整，facts 面板显示 3 条
```
> **M1 故意不做**：审批、容器、报告、MCP、skills、多项目、登录鉴权。工具只有 `bash` + 4 个平台工具。

#### M2（4 天）：可靠性

```
[ ] 预算：每 agent maxTurns/maxMinutes/maxTokens，到限 abort + 生成 Handoff Note
[ ] 超时：墙钟 + 无输出心跳（心跳 3min 断 → 判定卡死 → kill 进程组）
[ ] 重启恢复：agent_run 状态机持久化；启动时把 running 标记为 interrupted，可 resume/重派
[ ] 事件回放：WS 带 lastSeq，前端刷新/重连后补齐
[ ] 失败语义：failed 不让父 agent 感知为 completed；错误摘要进唤醒消息
[ ] 验收：kill -9 server → 重启 → 前端恢复全部历史 + 任务可继续；子 agent 假死被超时终止
```

#### M3（5 天）：工具与上下文

```
[ ] Tool Registry（YAML）：argv 模板 + zod 参数 + timeout + 输出解析器
[ ] 执行器：spawn 无 shell、超时、进程组 kill、输出写 artifact
[ ] 三个真实工具：nmap / httpx / nuclei（先宿主执行，M3 末切容器）
[ ] 输出截断：>8KB 落盘，模型只看到尾部 + artifact 句柄；read_artifact 工具
[ ] 容器执行：覆盖 bash 的 BashOperations → docker exec（参考 examples/extensions/ssh.ts）
[ ] 验收：`nmap -p-` 输出 3MB 不炸上下文；UI 加一个自定义 YAML 工具，下一轮可用
```
> 到 M3 结束，这套东西已经能对**授权靶场**做真实侦察了。

#### M4（5 天）：证据链

```
[ ] http_send 工具（容器内执行 + mitmproxy 旁路 + artifact + sha256）
[ ] finding schema（zod）+ 服务端闸门（evidence 反查 / scope / 去重）
[ ] verifier 角色：拿到 poc 重放，比对 expect → verified / disputed
[ ] 覆盖率表 + coverage_update 工具（三态）
[ ] 证据查看器 UI（请求/响应双栏、可复制 curl）
[ ] 验收：故意让 agent 编一个不存在的漏洞 → 被拒；真漏洞 → verified 且有两次独立证据
```

#### M5（4 天）：交付

```
[ ] 报告模板（目标/授权/资产/漏洞/覆盖/未发现说明）
[ ] PoC 生成：request artifact → curl + repro.py + verify.py
[ ] 导出：md/html/pdf（Chromium 打印）/ poc.zip / evidence.zip
[ ] 验收：把 poc.zip 拷到新机器，`python repro.py` 返回 PASS
```

#### M6（8 天，可与 M4/M5 并行）

```
[ ] 工具箱 UI：工具 CRUD / YAML 编辑 / 试跑 / 启停
[ ] MCP：server CRUD / 健康检查 / 工具预览 / 按角色授权 / session_start 动态注册
[ ] skills：目录规范 + 角色-技能白名单（--skill）+ 编辑器
[ ] 角色配置 UI（模型档位、工具白名单、预算）
[ ] 字典管理
```

#### M7（持续）

```
[ ] 容器出网白名单（mitmproxy/iptables）
[ ] 审批队列 UI + 超时 fail-closed + 审计日志
[ ] 多项目并发与配额
[ ] 成本面板与告警
[ ] 多用户/租户（如果需要）
```

### D.4 六周日历（单人）

| 周 | 主线 | 周末可演示 |
|---|---|---|
| W1 | M0 + M1 前半 | 浏览器能看到单个 agent 实时输出 |
| W2 | M1 后半 | **主 agent 派子 agent 并收到结论（核心骨架）** |
| W3 | M2 + M3 前半 | 杀进程能恢复；子任务超时可控 |
| W4 | M3 后半 | 容器内跑 nmap/nuclei，输出不炸上下文 |
| W5 | M4 | 漏洞能验证、能看证据 |
| W6 | M5 | 一键导出报告 + 复现脚本 |

**W2 是这个项目真正的"生死线"**：如果主→子调度跑不通，后面的报告、工具箱都没有意义。所以前两周只做这一件事，UI 丑没关系。

### D.5 每阶段"故意不做"清单

| 阶段 | 不做 |
|---|---|
| M1 | 审批、容器、报告、MCP、skills、鉴权、多项目、事件回放 |
| M2 | 真实工具、证据、报告 |
| M3 | 审批、报告、MCP |
| M4 | 报告美化、SARIF、工具箱 UI |
| M5 | 多格式模板、自定义章节 |
| M6 | 多租户 |

### D.6 测试策略（不需要真实目标）

- **mock 靶场**：自建一个 200 行的 Node/Python 服务，故意包含：`/api/login` 返回 JWT(HS256, 弱密钥)、`/api/fetch?url=` 的 SSRF、`/user/:id` 的 IDOR、一个回显参数。所有 M1-M4 的验收都在它上面跑，确定性、可重放、无法律风险。
- **录制回放**：把一次成功的 agent 会话事件序列存成 fixture，CI 里回放，防回归。
- **契约测试**：pi 升级前跑 `agent-runtime` 的协议测试（事件类型/字段/完成判定）。
- **无 LLM 测试**：编排层用假模型（faux provider）测状态机，别让 CI 依赖付费 API。

### D.7 阶段闸口（不达标不进入下一阶段）

| 闸口 | 通过标准 |
|---|---|
| G0→M1 | 能手写 JSONL 驱动 pi 完成一次工具调用 |
| M1→M2 | 验收脚本连续 5 次成功，且子 agent 结论**没有**被塞进父上下文（检查父会话 token 增长 < 3k/次） |
| M2→M3 | 强杀恢复 + 超时终止都验证过 |
| M3→M4 | 单次工具输出 >2MB 时上下文 token 不超阈值 |
| M4→M5 | verifier 能拒绝至少 1 个编造漏洞 |
| M5→发布 | 导出 poc 在干净容器里可复现 |

### D.8 如果只有你一个人，建议的第一周日程

| 天 | 事项 | 产出 |
|---|---|---|
| D1 | 环境 + 锁版本 + 手动 RPC 脚本 | 终端里看到 pi 的 JSONL 事件 |
| D2 | `agent-runtime` 原型：spawn / 读事件 / abort | 一个能跑的 50 行驱动 |
| D3 | DB 四张表 + seed 项目 | `projects/` 下出现 sqlite |
| D4 | pi-kit 最小版：dispatch + fact 工具 + brief 注入 | 扩展能被 `-e` 加载 |
| D5 | orchestrator 起子进程 + 完成唤醒父 agent | 命令行下主→子链路通 |
| D6 | WS + 最小前端（agent 树 + transcript） | 浏览器里看到三个 agent 跑 |
