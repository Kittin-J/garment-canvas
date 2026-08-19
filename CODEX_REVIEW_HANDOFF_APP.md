# 应用审核交接单 · 功能 / 业务流程 / 交互（Claude → Codex）

> 第二轮审核,范围是**应用本身**(生成流程、鉴权会话、前端交互、项目/资产数据完整性),与第一轮 `CODEX_REVIEW_HANDOFF.md`(防护体系)互不重叠。
> 方式:4 个域并行评审员读真实代码 + Claude 对要害项亲自核验源码。Codex **先复核再改**,在 linked worktree 内进行,不 push/PR/merge。

## 元信息

| 项 | 值 |
|---|---|
| 仓库 / 分支 | garment-canvas / `codex/postgresql-18` |
| BASE_COMMIT | `18367fa3fbf5381010a0a8fae337027a9a3b2d15` |
| 审核域 | 生成流程(G) / 鉴权会话(A) / 前端交互(F) / 数据完整性(D) |
| 产品基准 | README + docs/ai(会话 30 天单设备、素材 15 天回收、成功才计费、参考图≤8 按序合成、无拉伸出图、同 IP 5/min 限流) |

**证据标注**:`[✓Claude]` = Claude 亲自读到确切行号确认;`[评审员]` = 评审员引用、Claude 未逐行复核(**Codex 必须复核**)。

---

## 根因簇(先看这两个,能一次性解释多条发现)

- **簇 A · 单目标记账模型**(G1/G2/G3/G8):`runPlan.ts:56` 只取一个 `targetStep = find(onlyNodeId) ?? 最后一步`,`recordContext.nodeId` 绑定它;但 `runner.ts` 里 `markGenerationRunning/completeGenerationRecord/failGenerationRecord` 全部以 `recordContext?.nodeId === step.nodeId` 为门(213/224/256),而 `registerGeneratedFiles`(219)对**每个**节点执行、单步失败即 `return`(266)。→ 多 AI 节点/整图执行时记账全错。**一次重构记账模型可同时修掉 G1/G2/G3,并顺带处理 G8。**
- **簇 B · SSE 终态处理**(F1/F4/F9):run 卡片的成功/失败只在"收到本节点终态事件"时落地;`done`/干净关闭而无终态 → 卡片永远转圈;`runNode` 无存活预检(靠 2 小时超时);无 seq 单调性防回退。**一处"流结束必落终态 + 存活预检"可覆盖 F1/F4。**

---

## 第一梯队 · 高(功能/数据正确性,优先修)

### G1 —【高·data-integrity】多节点执行中前置节点失败 → 记录永久卡 `queued`
`server/engine/runner.ts:213/256` + `runPlan.ts:56` `[✓Claude]`
整图执行 target=末节点;前置节点失败走 256 行(target≠失败节点,不触发)→ `return`(266)→ 记录停在 `createGenerationRecord` 的初始 `queued`。`history.ts` 会把 `queued/running` 当进行中展示,用户看到永远转圈的记录,**无 reaper 回收**。

### G2 —【高·data-integrity】只跑前置+下游、后置失败 → 记录假 `success`
`server/engine/runner.ts:224` `[✓Claude]`
`onlyNodeId=A, includeDownstream` 时 target=A;A 成功即 `completeGenerationRecord`(status success + 写 usage_events),随后 B 失败仅发 `run-error`,记录已是 `success`。历史/消耗显示成功,但用户拿不到最终产物。

### G3 —【高·business-flow】多 AI 节点消耗记账**漏计**
`server/engine/runner.ts:219-235` + `executeStep` result 节点 `providerRequests:0`(311)`[✓Claude]`
`usage_events` 只在目标节点的 `completeGenerationRecord` 写入,用目标节点的 `providerRequests`。整图 target 常是 result 节点(`providerRequests:0`)→ **即使整次成功也记 0**;非目标付费节点(A/B 的真实付费调用)全部不计入消耗与 CSV 导出。系统性漏计。

### D1 —【高·data-integrity】legacy 素材迁移**破坏性非幂等**,每次重启剥夺归属
`server/lib/legacyMigration.ts:73-78`(每次启动经 `index.ts:120` 调用)`[✓Claude]`
按 `image`(非 `id`)匹配并 `UPDATE assets SET name,category,source_note, scope='global', owner_id=NULL WHERE image=$4`,命中**所有**同 image 行。docstring 自称"重复启动保持幂等"但实为破坏性。→ 用户私有素材(若 image 复用了 legacy 路径,见 D2)或管理员对迁移素材的任何编辑,**每次重启被还原/夺权**(变全局、owner 置空)。

### F1 —【高·business-flow】`done` 无本节点终态 → 卡片永久"生成中"
`src/store/flowStore.ts:1240-1267`(runNode)/ `1488-1502`(resume)`[评审员]`
`consumeRunEvents` 在 `done` 时 `finish()`;回调只处理 `nodeId===id` 的 `node-status`;若终态事件缺失/丢失(节点跳过、后端 bug、重连去重已见过该 id),干净 resolve 不进 catch,`terminalRecorded` 保持 false 且无兜底 → 卡片无限转圈,ProjectTabs 常驻运行点、阻塞关闭。

### F2 —【高·business-flow】首次历史加载**无条件覆盖**乐观记录 → 已付费生成消失
`src/App.tsx:115` `[✓Claude]`
`useFlowStore.setState({ recentResults: records })` 是覆盖而非合并;mount 与 fetch 返回之间用户点了 Run(`runNode` 乐观 prepend 一条),历史返回即抹掉该卡;随后 SSE 成功事件 `applyRunEventToRecentResults` 因 `find(id)` 找不到而 no-op → 生成在服务端完成却**从不出现在"最近生成"**。(对比 `loadMoreHistory:135-143` 是合并去重,正确。)

---

## 第二梯队 · 中

### G4 —【中·interaction】200 body 内的内容拒绝被重试 `target+3` 次,付费翻倍
`server/providers/exact.ts:41`(`error.status !== undefined && >=400 && <500` 才 break)`[评审员]`
网关以 HTTP 200 返回 `{error:{code:"content_policy_violation"}}` 时 status=undefined → 不 break → 对确定失败的输入发 4 次完整 provider 调用,付费与延迟 4x。

### G5 —【中·business-flow】直连 `/api/generate` 绕过按类型的 4 图上限
`server/routes/generate.ts:96`(`Math.min(8, batchSize)`,无按 kind 限制)vs `runner.ts:405` / `runPlan.ts` 的 4 `[✓Claude]`
同一 `sketch-to-render`/`ai-modify` 节点经 DAG 限 4 张,直连端点却可出 8 张 → 同节点因入口不同产出最多 2 倍付费图。

### G6 —【中·functional】provider 请求时不强制 HTTPS,Bearer key 可明文外发
`server/config.ts:62` 接受任意 scheme;HTTPS 仅在 `aiConfigReady()`(readiness)校验,不在真正发 `Authorization: Bearer` 时校验 `[评审员]`
运维误设 `CHANGE2PRO_BASE_URL=http://...` 时 readiness 告警但生成仍跑 → 每次生成明文发 API key。请求路径应加 scheme 守卫。

### A1 —【中·business-flow】账号删除后 `account_id` 永久占用,无法重建同名登录
`server/routes/auth.ts:129-136`(POST /users 普通 INSERT → 23505 → 409)+ 软删除保留行 `[✓Claude(POST 侧)]`
`account_id UNIQUE` 无 `deleted_at` 排除;软删后行仍在 → 重建同名账号命中唯一冲突返回 `409 账号已存在`,但该账号在任何列表(`deleted_at IS NULL` 过滤)都不可见 → 登录名永久不可用且报错误导。

### A2 —【中·business-flow】`requirePasswordChanged` 未覆盖 `/api/auth` 管理路由
`server/index.ts:86-87` + `server/routes/auth.ts:69` `[✓Claude]`
`authRouter` 挂载于全局密码墙(87 行 `app.use("/api", requireAuth, requirePasswordChanged)`)**之前**,router 内仅 `requireAuth`+`requireAdmin`,全文件无 `requirePasswordChanged`。→ 首登管理员(临时密码,`must_change_password=1`)可绕过改密页直接调 `POST /users`、`reset-password`、`DELETE /users/:id`,在未轮换共享临时凭据前就管理账号。**违反"requirePasswordChanged 覆盖不变量"。**

### A3 —【中·data-integrity】账号删除(保留数据分支)遗漏 files/generation_runs/usage_events,且重置回收计时
`server/routes/auth.ts:216-226` `[评审员]`
转移分支处理全部 5 张表;但"15 天回收"分支只对 `projects`/`assets` 置 `deleted_at/purge_after`,`files`/`generation_runs`/`usage_events` 仍挂死账号且永不清理;且 projects 的 UPDATE 缺 `deleted_at IS NULL` 守卫(assets 有)→ 已在回收站的项目被延长 `purge_after`。

### D2 —【中·authorization】素材创建不绑定被引用文件归属 → 私有文件被翻公开
`server/routes/assets.ts:90-105` + `server/routes/files.ts:22-31` `[✓Claude]`
`imageUrl = saved?.url ?? (isLocalImageReference(image) ? image : "")`,对已存在的 `/api/files/X` 引用**不校验归属/存在**;`canAccessFile` 中"存在 scope∈{global,shared} 且引用该 image 的素材"即判 `public`。→ B 用 `POST /api/assets {scope:"shared", image:"/api/files/<A的私有文件>"}` 即把 A 私有文件对所有人公开(靠 `nanoid(12)` 不可猜缓解,但无服务端归属绑定);亦可指向不存在文件。

### D3 —【中·data-integrity】素材删除守卫非事务,check-then-delete 存在 TOCTOU
`server/routes/assets.ts:177-205`(两条 autocommit 语句,无事务/无 `FOR UPDATE`)`[评审员]`
T1 读无引用 → 并发 T2(项目保存 `syncAssetRefs`)插入引用行 → T1 软删 → 活动项目引用了已软删素材,违反"被引用素材不可删"。

### F3 —【中·business-flow】8 张参考图上限按**边数**而非**图数**判定
`src/store/flowStore.ts:1096-1107` + `237-241` + `1545-1553` `[评审员]`
`isValidConnection` 只判 `incoming.length >= spec.inputs`(边数);`selectResultImages` 把每条边源节点的 `outputImages` 全量拼接。→ 8 条来自 batch 节点(每个 4 图)的边可静默送 32 张参考图,UI 仍写"最多 8 张",后端是否截断未知。

### F5 —【中·performance】会话持久化订阅在每次 mutation 全量 `JSON.stringify` 所有标签页
`src/store/flowStore.ts:1424-1464` `[评审员]`
stringify 发生在 diff 守卫**之前**,拖拽/每次 SSE tick 都序列化所有打开项目的完整 nodes/edges 两遍(第二个订阅再 setState 触发第一个)→ 大画布拖拽/密集出图时掉帧。

### F6 —【中·business-flow】关闭标签页不取消其 SSE,产物只进卡片不进画布且标签留脏
`src/store/flowStore.ts:1002-1022` + `316-329` + `957-972` `[评审员]`
`closeTab` 仅过滤 tabs 不取消 run;`patchTab` 对已关闭 tab 返回 `{}` 丢弃画布写入;而全局 `recentResults` 卡片仍翻成功。→ 关闭标签后成功的生成:卡片有图,画布节点 `outputImages` 丢失,重开项目该节点无结果;成功还把 tab 标脏却不自动保存。

---

## 第三梯队 · 低(记账元数据 / 存储卫生 / 次要 UX,批量处理)

| ID | 文件:行 | 类别 | 摘要 | 证据 |
|---|---|---|---|---|
| G7 | `runPlan.ts:61` vs `runner.ts:373` | data-integrity | print-mutate `requested_count` 默认 1 但实际生成 4,历史元数据不一致 | [评审员] |
| G8 | `runner.ts:218-222,266` | data-integrity | 失败 run 的前置节点产物已落盘+入 `files` 表却无回滚 → 孤儿文件累积 | [✓Claude(219/266)] |
| A4 | `auth.ts:98` | interaction | 改密复用 `createSession` 把自身旧 token 记 `replaced` → 同浏览器另一标签的在途 `/me` 可能误显"已在其他设备登录" | [✓Claude] |
| A5 | `index.ts:119` | data-integrity | `pruneExpiredSessions` 仅启动时跑一次,长运行下过期会话表无限增长(认证仍正确) | [评审员] |
| A6 | `src/auth/AuthContext.tsx:58,86` | interaction | `clear-user` 后未停 15s 轮询 → 未登录页持续打 `/me` | [评审员] |
| D4 | `assets.ts:56-64` | authorization | `?deleted=true` 向普通用户泄露他人已删的 shared/global 素材元数据+图 URL | [评审员] |
| D5 | `history.ts:71-73` | authorization | `DELETE /api/history/:id` 存在即 403、不存在即 404 → 存在性预言机(与代码库"非泄露 404"偏好不一致) | [评审员] |
| D6 | `runPlan.ts:67-76` | business-flow | `projectId` 归属守卫对不存在/已删项目放行 → run 及其 usage/history 被打上任意 project_id(仅元数据污染) | [评审员] |
| F4 | `flowStore.ts:925-953` | interaction | `runNode` 无存活预检,后端重启丢失 run 时靠 2 小时超时才报错(resume 路径有预检) | [评审员] |
| F7 | `App.tsx:145` | functional | `offset += records.length` 且仅按 id 去重,新生成推移服务端索引 → "加载更多"可跳过中段记录(gap) | [✓Claude] |
| F8 | `PrintExtractNode.tsx:14,34` | interaction | `saveAsAsset` 从渲染闭包取基数组,并发保存后写覆盖 → `savedAsAssets` 丢一条 | [评审员] |
| F9 | `flowStore.ts:938-949,816-828` | business-flow | run 事件无 seq 单调性守卫,终态后到的 `running` 会把卡片回退转圈(单连接顺序+去重缓解,概率低) | [评审员] |
| F10 | `flowStore.ts:1065-1072` | interaction | 选第 5 张对比图静默 no-op,无提示(上限 4) | [评审员] |
| F11 | `InspectorPanel.tsx:94` / `NodeFrame.tsx:111` | interaction | Run 按钮仅 `running` 时禁用,`queued` 窗口仍可点(被 store 吞),无反馈 | [评审员] |

---

## 未构成问题(已核验,供 Codex 参考,勿误报)

- 测试通过 `installFetchMock` mock 全局 fetch,**不会触达付费 provider**(provider-contract.test.ts)。
- provider `diagnostic` 仅经 `aiDiagnostics` 路由记录,不返回客户端(generate.ts 只回 public `message`)。
- 远程图 fetch 的 SSRF/HTTPS/重定向防护在 `fileStore.ts` 是稳的;`usage_events` 对 SSE 重连用 `ON CONFLICT (run_id)` 幂等。
- 参考图**顺序**端到端保留(边序 → 合成 `Image 1..N`)。
- 鉴权核心稳:`createSession` 单点 + `FOR UPDATE` + `sessions.user_id UNIQUE` 串行化并发登录,单账号单会话;各撤销路径(改密/重置/停用/删除)均清旧会话;`requireAuth`/`requirePasswordChanged` 覆盖各业务 router(A2 的 `/api/auth` 除外)。

---

## 修复优先级建议(cross-cutting)

1. **簇 A 记账重构(G1/G2/G3,顺带 G8)**:把"单 target 记账"改为覆盖 run 内所有产生 provider 调用的节点——run 结束时按整体成败落 `success/failed`,`usage_events` 汇总所有节点的 `providerRequests`;失败时回滚/标记本 run 已落盘文件。**这是本轮最大改动,改前必须 `impact` `runner.ts`/`generationRecords.ts`/`runPlan.ts` 相关符号。**
2. **D1 迁移幂等化**:改为按 `id` 且仅"不存在才插入"(或加"已被用户/管理员修改则不覆盖"哨兵);绝不每次重启夺权。**高优,影响线上现存数据。**
3. **簇 B SSE 终态(F1/F4)+ F2 历史合并**:流结束若无本节点终态则兜底落终态;`runNode` 加存活预检;首次历史加载改为合并(复用 `loadMoreHistory` 的去重逻辑)。
4. **A2 密码墙覆盖**:在 `authRouter` 的管理端点补 `requirePasswordChanged`(注意 `/me`、`/logout`、`/change-password` 需豁免)。
5. 其余按梯队推进;每条改动加回归测试(现有 `tests/*` 已覆盖 auth/authorization/workflow-schema/project-tabs,便于扩展)。

---

## 执行约束(同项目规则)

1. 在 linked worktree 执行(`claude --worktree fix-app-<域>`),主 worktree audit-only。
2. **改任一函数/类/方法前跑 GitNexus `impact({target, direction:"upstream"})`**,HIGH/CRITICAL 先告警;`rename` 用图感知重命名。
3. 每个行为变更加/改回归测试(先复现失败再修);auth/授权/迁移/provider/workflow/API 契约改动先跑对应 focused 测试。
4. 交接前:`npm run check`(lint+test)+ `npm run build` + `detect_changes({scope:"compare", base_ref:"main"})`;测试不得调用付费 provider。
5. 只本地提交,不 push/PR/merge/rebase;不装/升依赖。完成后回填 `AGENTS.md` 结构化 handoff。

---

## 待 Codex 决策/复核清单

- [ ] 复核所有 `[评审员]` 标注项的确切行号与逻辑(尤其 G4/G6、F1/F3/F5/F6、A3、D3/D4)。
- [ ] 簇 A 记账重构方案确认:run 级成败判定与 usage 汇总口径(失败 run 是否计已成功节点的消耗?——按产品"成功才计费",倾向只计成功节点的付费调用)。
- [ ] D1 迁移:线上是否已有被夺权/覆盖的数据需要数据修复脚本,而不仅是改代码?
- [ ] G5 批量上限:直连 `/api/generate` 是否也应按 kind 限 4?(统一口径 vs 直连本就允许更大批量)。
- [ ] F3 参考图上限:前端截断到 8 张 + 提示,还是后端强制截断?两端口径需一致。
