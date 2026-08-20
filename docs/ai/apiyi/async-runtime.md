# 业务异步运行时契约

最后核对：2026-08-20

## 边界

API易图片端点是同步接口：一次 HTTP 请求持续到生成完成，且没有上游任务 ID、查询接口或取消接口。本项目对前端提供异步任务体验，但 Worker 内部仍执行一次同步上游调用。

推荐链路：

1. API 校验工作流、节点参数、鉴权和素材归属。
2. 在同一数据库事务中创建 run、step 和待执行 job，立即返回 run_id。
3. Worker 使用 PostgreSQL 行锁领取 job，将状态置为 running 并记录 lease。
4. Worker 同步调用 API易，解析结果并立即转存图片。
5. 在事务中写入输出素材、step 结果、事件和终态。
6. 前端使用已有 SSE 事件流获取进度；断线后按事件序号续传。

## 状态机

- queued：已入库，等待 Worker。
- running：Worker 已领取，尚未得到确定结果。
- retry_wait：明确命中可重试状态，等待下一次领取。
- succeeded：结果已转存并落库。
- failed：确定失败且不可重试，或明确重试已用尽。
- outcome_unknown：请求可能已被上游执行和计费，但本项目没有收到可验证结果。
- cancel_requested：用户请求取消；只阻止尚未开始的新调用。
- cancelled：上游调用开始前已取消。

终态为 succeeded、failed、outcome_unknown、cancelled。

## 领取与恢复

- 使用 SELECT ... FOR UPDATE SKIP LOCKED 领取 queued 或到期的 retry_wait job。
- running job 必须记录 worker_id、lease_expires_at、attempt_started_at。
- Worker 定期续租。进程重启后，仅未开始上游调用的过期任务可重新排队。
- 一旦 attempt_started_at 已记录且进程在没有确定响应的情况下死亡，任务转为 outcome_unknown，不得自动重放。
- 每个 step 使用稳定 idempotency_key 防止本地重复入队；该键不能被当作上游幂等保证。

## 重试规则

- HTTP 429：指数退避，可自动重试，最多 2 次。
- HTTP 503：仅在确认属于临时容量或渠道不可用时重试，最多 2 次。
- 已知参数不支持导致的 503 不重试，例如 Grok 的 resolution=4k。
- HTTP 400、401、403、404、415：不重试。
- 超时、连接重置、连接中断、响应体截断：outcome_unknown，不自动重试。
- 内容审核拒绝：不原样重试。

建议退避为 5 秒、15 秒，并加入小幅随机抖动。retry_count 只统计实际重放次数，不包含首次调用。

## 取消语义

- queued 和 retry_wait 可以直接取消。
- running 只能设置 cancel_requested。由于 API易无上游取消接口，不能宣称已中止计费。
- running 调用成功返回后仍应转存结果并记录真实终态，同时在事件中说明取消请求未能中止上游。

## 结果持久化

- b64_json 或 Gemini inlineData 必须解码后写入项目存储。
- URL 输出必须由服务端下载；FLUX 约 10 分钟过期，其他 URL 同样视为临时地址。
- 下载成功、文件校验成功且素材记录落库后，step 才能标记 succeeded。
- 日志只记录 provider、model、状态码、请求 ID、耗时、重试次数和白名单计费元数据；不得记录密钥、完整提示词、图片数据或完整响应体。

## 验收

- 提交 API 在上游调用开始前返回 run_id。
- 服务重启后 queued 任务可继续；不确定的 running 任务不会被重复计费。
- 429/可重试 503 最多重放 2 次；网络超时不重放。
- 刷新页面或 SSE 重连不会丢失已提交任务和事件。
- 所有成功结果使用项目自有 URL，第三方临时 URL 不进入长期历史记录。
