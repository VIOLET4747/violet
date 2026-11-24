---
name: evidence
description: 证据与 finding 写法：如何用 http_send 采集可复现证据、写 counterevidence、避免假阳性。任何要提交 finding 或验证别人 finding 时使用。
---

# 证据规范

## 提交 finding 前

1. 必须先用 `http_send` 实际发请求，拿到 request/response artifact id。
2. `evidence_ids` 至少包含一条 `http-response`，否则服务端会拒。
3. 写清 `counterevidence`：为什么不是误报（是否多次复现、是否有鉴权拦截、是否有其他解释）。
4. `poc.steps` 要能照着做：每一步写清 method/URL/关键参数/期望结果。
5. `poc.expect` 选客观标志：
   - `status`：期望的返回码
   - `body_regex`：响应体里稳定出现的特征（不要写会随机变化的 id）
   - `header_regex`：响应头特征

## 验证（verifier）

- 不能复用原 finding 的 evidence；必须重新 `http_send` 采新证据。
- 服务端会按 `poc.expect` 自动比对，比对失败即使填 verified 也会变 disputed。
- 环境不一致（目标重启、配置变了）时如实写 disputed 并说明原因。

## 常见假阳性

- 把 404 页面当“接口存在”
- 把回显的输入当 XSS（实际被转义）
- 把 200 但无数据当越权
- 只测一次就下结论（网络抖动/缓存）
