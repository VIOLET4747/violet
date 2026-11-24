---
name: recon
description: 侦察与资产发现工作流：端口/目录/指纹/接口提取。用于拿到目标后第一轮信息收集，或需要系统性摸清攻击面时。
---

# 侦察工作流

## 顺序

1. **先确认存活与基础指纹**：HTTP 头、title、技术栈、robots.txt、常见路径（`/login`、`/api`、`/admin`、`/openapi.json`）。
2. **接口清单**：从 HTML/JS 静态资源里提取 `fetch`/`axios`/`/api/...` 路径；每个接口记 method + 参数 + 鉴权要求。
3. **再决定测试面**：把「接口 × 测试类」写成 coverage 记录，不要只写“看过”。
4. 每一条可复用信息立即 `fact_write`（kind=asset/endpoint/tech/behavior），不要攒到最后。

## 记录要求

- endpoint 事实写清：URL、method、参数位置（query/body/header）、返回码、是否要鉴权。
- 负事实也记：`kind=negative`，例如“/api/profile?id=1 返回 401，未发现 IDOR”。
- 发现可疑点先写 hypothesis，不要直接当 finding；要提交 finding 必须用 `http_send` 拿到证据。

## 停止条件

- 攻击面已列全，且每个接口有明确结论（confirmed / ruled_out / open_proof_gap）。
- 预算接近上限时立刻收尾并写 Handoff。
