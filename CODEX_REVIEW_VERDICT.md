# Codex 修改审核结论（Claude 复核）

> 对两轮交接单(`CODEX_REVIEW_HANDOFF.md` 防护体系 / `CODEX_REVIEW_HANDOFF_APP.md` 应用功能)所对应 Codex 修改的复核。
> **结论:两份交接单几乎全部正确落实,已加回归测试,验证全绿。可合并(先确认 3 项产品决策)。**

## 分支与合并状态

| 分支 | 基线 | HEAD | 说明 |
|---|---|---|---|
| `main` | — | `7859749` | 已含 postgresql-18 + thumbnail-limits;**未含**下面两支修复 |
| `codex/fix-guardrails` | `18367fa` | `ea2a7e9` | 防护体系修复(第一轮) |
| `codex/fix-app-review` | `c8947f7` | `70ca615` | 应用功能修复(第二轮)+ Claude 补的残留(见下) |

> ⚠️ 两支修复**都还没并入 main**。`fix-guardrails` 基于旧基线 `18367fa`(不含 pg18/thumbnail),`fix-app-review` 基于含这些合并的 `c8947f7`。合并时先合 `fix-app-review`(已在新基线上),`fix-guardrails` 需 rebase 到 main 再合,避免回退 pg18/thumbnail。

---

## 一、防护体系分支 · 逐条状态

| 发现 | 状态 |
|---|---|
| 10 deny 协议 → 纯 stderr+exit2 | ✅ |
| 5 matcher/工具覆盖(Grep/Glob/NotebookEdit)+ 路径筛查 | ✅ |
| 4 写入目标归属(`isPathInsideRoot`+`canonicalizePotentialPath`,防 symlink 逃逸/新建文件) | ✅ 优于建议 |
| 6 deny 冒号语法 `Bash(git push:*)` | ✅ |
| 7 compose.test.yaml `name` | ✅ |
| 8 isMain realpath(hook+脚本两处) | ✅ |
| 9 pid 泄露 → 稳定名自愈 + O_EXCL 锁文件 | ✅ 优于建议 |
| 1/2/3 架构性 | ✅ 选 (A) 并文档化"仅防误操作、非对抗沙箱";移除 sed/`git grep`,`isReadOnlyBash` 拒 `$*?{}[]` |

**已知限制(与 (A) 立场自洽,保留):** linked worktree 里 `p=push; git $p` 仍可变量绕过 push/merge/install 禁令——`$` 拒绝只在 `isReadOnlyBash`(主 worktree),未加到 `forbiddenBashReason`。**Claude 刻意未补此项**:`forbiddenBashReason` 对所有 Bash 生效,盲拒 `$` 会误伤 linked worktree 合法命令(`echo $HOME`、`FOO=bar npm …`),得不偿失。定性为"防误操作"边界,已在 AGENTS/CLAUDE.md 写明。

**可用性代价(有意):** 主 worktree Bash 现拒绝含 `$ * ? { } [ ]` 的命令,`ls *.ts`/`cat *.json`/`rg 'foo$'` 会被拦,sed/git grep 移出白名单;用原生 Read/Grep/Glob 工具替代。

---

## 二、应用功能分支 · 逐条状态(全部 ✅)

- **簇 A 记账(G1/G2/G3)**:`executeRun` 重构为 run 级——开跑即 running、跨节点累加 providerRequests/model、全成功才 complete、任一失败 `failRun`→failGenerationRecord。
- **G8 孤儿文件**:`failGenerationRecord` `FOR UPDATE`+`DELETE files WHERE run_id`+提交后 `deleteStoredImage`。
- **G4** 拒绝类别也 break;**G6** 请求前强制 `https:`;**G7** print-mutate 默认 4(抽 `requestedCountForStep`)。
- **A1** account_id 部分唯一索引;**A2** `requirePasswordChanged` 覆盖 `/api/auth` 管理端点(顺序正确);**A3** files/runs/usage 纳入软删+purge;**A4** 改密不误标 replaced;**A5** 会话定时清理;**A6** 未登录停轮询。
- **D1** 迁移改"不存在才插入";**D2** 引用文件校验归属;**D3** 删除单事务行锁破 TOCTOU;**D4** 回收站只见己;**D5** 历史删除统一 404;**D6** projectId 不存在返回 404。
- **F1** done 无终态则报错;**F2** 历史合并不覆盖;**F4** 存活预检;**F5** 序列化早退;**F6** 运行中拒关标签(带提示);**F7** before 游标分页;**F8** 读最新状态去重;**F9** seq 丢乱序;**F10** 对比上限提示;**F11** 节点卡排队禁用。

### 产品决策(Codex 已选,请确认)

1. **G5 批量上限**:DAG/runPlan 上限从 **4 提到 8**(统一到直连端点)→ sketch/ai-modify 到处可出 8 张,**单次付费图上限翻倍**。前端选项/类型/schema 已同步。**需确认成本方向。**
2. **F3 参考图>8**:选**后端硬失败**(run error)而非静默截断;前端可连成非法图,运行时才报错。
3. **findings 1/2/3**:选 (A) 非对抗沙箱(见上)。

---

## 三、Claude 补的残留修复（`fix-app-review` 提交 `70ca615`）

1. **F11 补全**:`InspectorPanel` 运行按钮在 `queued` 也禁用并显示"排队中…",与节点卡一致(原 diff 仅改了节点卡,Inspector 自身按钮遗漏)。
2. **A3 补全**:`usage.ts` `queryRows` 与 `history.ts` 查询加 `deleted_at IS NULL` → 删号后 15 天回收窗口内,该账号消耗/历史不再出现在 `GET /usage?all=true` / `?all=true` 历史(此前仅"purge 后"才消失,窗口期仍显示)。

impact(`queryRows`)= LOW;`detect_changes` 仅命中 `queryRows`/`PropertyEditor` 及预期流,无扩散。

**刻意未做**:`forbiddenBashReason` 的 `$` 拒绝(理由见上)。

### 仍开放(非阻塞)

- **D1 存量修复**:代码已止损,但**无脚本回滚**此前已被夺权/覆盖的历史行——若线上有 legacy 数据受影响需单独数据修复。

---

## 四、验证记录

| 项 | 结果 |
|---|---|
| `fix-app-review` `npm run check`(lint + 隔离 Postgres 全套件,含新测试 + Claude 残留) | ✅ 全绿,容器干净拆除 |
| 新增关键回归测试(D1/A1/D2/D3/D4/D5/D6/F2/F6/F7/F8/F9/F10/**F11**)| ✅ 逐项 pass |
| `fix-guardrails` `tests/claude-guardrail-hook.test.mjs` | ✅ passed |
| `fix-guardrails` `tests/test-runner-isolation.test.mjs` | ✅ passed |
| `npm run build` | 未单独跑(lint=tsc 已过,build 为 tsc+esbuild/vite 打包) |

环境:Docker 29.5.2 / Compose 5.2.0,本机执行。

---

## 五、合并建议

1. 确认三项产品决策(尤其 **G5 到处 8 张** 的成本)。
2. `fix-guardrails` 先 rebase 到 `main`(避免回退 pg18/thumbnail),再合两支。
3. 合并后在目标分支再跑一次 `npm run check`(两支合并后组合验证)。
4. 记一条 backlog:D1 存量数据修复脚本(若适用)。
