---
name: jwt
description: JWT 专项测试：alg=none、弱密钥暴力、kid/jku 注入、claim 篡改。用于接口返回 JWT 或使用 Bearer token 时。
---

# JWT 测试清单

## 先解码

- 把 token 拆成 header.payload.signature，记录 alg、kid、typ、关键 claims（sub/role/exp/iat）。
- `fact_write(kind=tech)` 记录：算法、角色字段、过期时间。

## 常见问题与判定

1. **alg=none**：改 header alg 为 none、去掉签名，重放。若仍 200 → 高危。
2. **弱密钥**：用常见字典/离线爆破 HMAC 密钥（jwt_tool / hashcat）。命中后用密钥重签 `role=admin` 并验证。
3. **kid 注入**：kid 指向文件/路径（../../），观察报错或行为差异。
4. **claim 篡改**：改 `role`/`sub`/`user_id` 后重放，看后端是否重新校验收权。
5. **过期/撤销**：exp 已过期 token 是否仍被接受。

## 证据要求

- 每次判定都要有 `http_send` 的请求/响应，不能只贴 token。
- 提交 finding 时 evidence 用 http_send 返回的 artifact id；`poc.expect` 用 status 或 body_regex 命中客观行为。
