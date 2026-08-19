# 防护体系审核与修复交接单（Claude → Codex）

> 用途:Codex **先独立复核**每条发现,**再按建议修改**。所有改动在 linked worktree 内进行,不 push/PR/merge。
> 本单只是审核与建议,Claude 未改动任何源码。

## 元信息

| 项 | 值 |
|---|---|
| 仓库 | garment-canvas |
| BASE_COMMIT | `18367fa3fbf5381010a0a8fae337027a9a3b2d15` (`18367fa`) |
| 分支 | `codex/postgresql-18` |
| 工作区 | 主 worktree(非 linked),工作区干净 |
| 审核方式 | Claude 直接读源码 + `/code-review` 子代理实证复现 |
| `.env` 状态 | 已被 `.gitignore` 覆盖(`git check-ignore .env` = 命中) |

**审核对象文件**
- `.claude/hooks/require-linked-worktree.mjs`
- `.claude/settings.json`
- `compose.test.yaml` / `compose.yaml`
- `scripts/test-with-postgres.mjs`

**证据来源标注**:`[读码]` = Claude 直接读源码确认;`[实测]` = 子代理用真实函数/命令跑通复现。

---

## 摘要

共 10 条发现。核心结论:**主 worktree / 密钥防护边界可被多条独立路径绕过**;测试框架可能在未真正测试时报告成功。

- **第一部分(6 项,可机械修复,低风险,当场可验证)**:发现 8/9/10/5/6 + 发现 4 的文件写入向量。
- **第二部分(架构性,需决策)**:发现 1/2/3 + 发现 4 的 Bash 向量——字符串分类不可靠,改字符串规则无法真正闭合。

---

## 第一部分:建议修复(Codex 复核后执行)

### 文件 A · `scripts/test-with-postgres.mjs`

#### 发现 8 —【高·正确性】isMain 的 symlink 不匹配 → 静默跳过整个测试套件
- **证据** `[实测]`:第 78 行 `import.meta.url === pathToFileURL(resolve(process.argv[1])).href`。`import.meta.url` 被 Node 做了 realpath,`resolve(argv[1])` 只做词法解析。经 symlink 的绝对路径调用(macOS `/tmp`→`/private/tmp`、CI 工作区 symlink)→ 两者不等 → `main()` 不执行 → **退出 0、零测试、无告警**。
- **建议改动**:argv 侧也 realpath。
  ```js
  import { realpathSync } from "node:fs";
  const isMain = Boolean(process.argv[1])
    && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  ```
- **验证**:经 symlink 的绝对路径运行 `npm test`,确认真的拉起 Postgres 并执行了用例(而非空跑退 0)。

#### 发现 9 —【高·可靠性】项目名含 PID → 崩溃后泄露不可回收的 PG 集群
- **证据** `[读码]`:第 7–13 行 `createComposeProjectName` 返回 `garment-canvas-test-${worktreeId}-${pid}`。被 SIGKILL/OOM 打断时 `finally` 的 down(第 71 行)不执行;下次运行 pid 变化,开局的 down（第 58 行)指向不同项目名,**无法回收遗留集群**;全仓无按前缀回收的 reaper。
- **建议改动**:去掉 pid,按 worktree 稳定命名;第 58 行现有的 `down --volumes --remove-orphans` 即可自愈回收。
  ```js
  export function createComposeProjectName({ cwd = process.cwd() } = {}) {
    const worktreeId = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 10);
    return `garment-canvas-test-${worktreeId}`;
  }
  ```
- **⚠️ 需 Codex 决策(取舍)**:去掉 pid 后,**同一 worktree 内并发跑测试**会互相冲突(不同 worktree 仍靠 cwd 哈希隔离)。`npm test` 通常串行,判断该并发需求是否存在。若需保留并发,替代:保留 pid + 加"按 `garment-canvas-test-<hash>-*` 前缀回收"的 reaper,但 reaper 会误杀并发运行 —— 与 pid 隔离目的冲突,不推荐。
- **验证**:手动留一个同名 stale 集群 → 跑 `npm test` → 确认开局被回收;正常跑完 `docker ps -a | grep garment-canvas-test` 无残留。
- **注意**:导出函数,`test:suite` 或单测中可能断言了带 pid 的旧名,一并更新。

---

### 文件 B · `compose.test.yaml`

#### 发现 7 —【高·正确性】缺 `name:` → 裸 compose 命令误伤开发/生产栈
- **证据** `[读码]`:本文件无 `name:`;`compose.yaml` 第 1 行 `name: garment-canvas`,仓库目录名也是 `garment-canvas`。人工执行 `docker compose -f compose.test.yaml down --volumes --remove-orphans`(不带 `--project-name`)→ 解析到默认项目名 = 目录名 = `garment-canvas` = 开发栈 → `--remove-orphans` 停删运行中的开发 `app`+`postgres`。
- **建议改动**:加安全默认名(runner 第 44–45 行的 `--project-name` 优先级更高,不受影响):
  ```yaml
  name: garment-canvas-test
  services:
    postgres-test:
      ...
  ```
- **验证**:`docker compose -f compose.test.yaml config` 显示 `name: garment-canvas-test`;确认 runner 传的 `--project-name garment-canvas-test-<hash>` 仍覆盖此默认名(CLI `-p` > 文件 `name:`)。

---

### 文件 C · `.claude/hooks/require-linked-worktree.mjs`

#### 发现 10 —【中·健壮性】`deny()` 用错输出协议,结构化字段是死字段
- **证据** `[读码]`:第 5–13 行把 `{hookSpecificOutput:{permissionDecision},systemMessage}` 写到 **stderr** 并 `exit 2`。PreToolUse 结构化决策只从 **stdout + exit 0** 解析;exit 2 时 stderr 当纯文本理由。当前"能拦截"纯靠 exit 2,Claude 看到的是原始 JSON 串;`permissionDecision`/`systemMessage` 无效,且缺 `hookEventName`/`permissionDecisionReason`。
- **建议改动(低风险版)**:exit 2 本就是合法拦截机制,只去掉误导性 JSON 包装。
  ```js
  function deny(message) {
    process.stderr.write(`${message}\n`);
    process.exit(2);
  }
  ```
- **⚠️ 明确不做**:不要改成 "stdout + 结构化 JSON + exit 0"。若字段名写错会 **静默 fail-open(不再拦截)**,是安全倒退。保留 exit 2 语义。
- **验证**:见下方 hook 管道测试,断言拦截用例 stderr 是干净文案、退出码 2。

#### 发现 5 —【严重·安全】matcher/hook 漏掉可读写的工具(Grep/Glob/NotebookEdit)
#### 发现 4 —【严重·安全】只读判定基于会话 cwd,而非写入目标路径
- **证据** `[读码/实测]`:
  - 发现 5:hook 只在 Read/Write/Edit 分支筛查敏感路径;`Grep(path:".env", output_mode:"content")` 打印密钥行,`NotebookEdit`(写工具)在主 worktree 无 worktree 校验、其 `notebook_path` 也跳过敏感检查。
  - 发现 4:第 149–150 行 `if (isLinkedWorktree(cwd) === true) process.exit(0)`,对写目标 `file_path` 不做任何校验 → linked worktree 会话可 `Write` 绝对路径进主 checkout。
- **建议改动**:重写第 128–159 行分派逻辑(需新增 `import { sep } from "node:path"`):
  ```js
  const ti = input.tool_input ?? {};
  const toolName = input.tool_name;
  const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
  const READONLY_TOOLS = new Set(["Read", "Grep", "Glob"]);

  // 1) 对所有路径型入参筛查敏感路径(含 Grep.path / NotebookEdit.notebook_path)
  for (const p of [ti.file_path, ti.notebook_path, ti.path]) {
    if (typeof p === "string" && containsSensitivePath(p)) {
      deny("Access to private .env or .secrets files is blocked; use .env.example as the public contract.");
    }
  }

  // 2) 只读工具:筛查后放行
  if (READONLY_TOOLS.has(toolName)) process.exit(0);

  // 3) Bash 禁令(所有 worktree 生效)
  if (toolName === "Bash") {
    const command = ti.command;
    if (typeof command !== "string") deny("A Bash tool call without a command is blocked.");
    const reason = forbiddenBashReason(command);
    if (reason) deny(reason);
  }

  // 4) worktree 闸门
  const linked = isLinkedWorktree(cwd);
  if (linked === null) deny("Claude could not verify that the current directory is a linked git worktree.");

  if (WRITE_TOOLS.has(toolName)) {
    if (linked !== true) deny("The primary worktree is audit-only. Restart with: claude --worktree <task-name>");
    // 发现 4:linked worktree 下写目标必须落在本 worktree 内
    const root = gitPath(cwd, "--show-toplevel");
    const target = resolve(cwd, ti.file_path ?? ti.notebook_path ?? "");
    if (!root || !(target === root || target.startsWith(root + sep))) {
      deny("Writes must stay inside the current linked worktree.");
    }
    process.exit(0);
  }

  if (toolName === "Bash") {
    if (linked === true) process.exit(0);
    if (!isReadOnlyBash(ti.command)) {
      deny("Only a conservative read-only Bash allowlist is available in the primary worktree. Use Read/Grep/GitNexus, or restart with claude --worktree <task-name>.");
    }
  }
  process.exit(0);
  ```
- **Codex 复核点**:确认 `gitPath(cwd, "--show-toplevel")` 可用(`git rev-parse --path-format=absolute --show-toplevel` 成立,函数已 realpath);确认删除原第 132–159 段后无残留分支。
- **残余风险(记录,不在本次闭合)**:`Grep(pattern, path:".", output_mode:"content")` 递归搜索时仍可能读到密钥文件内容——但本仓 `.env` 已 gitignore,ripgrep 默认跳过 gitignore 文件,故实际风险较低;若将来有非 gitignore 的密钥文件则需另行处理。Bash 在 linked worktree 里用绝对路径写他处(如 `git -C /primary commit`)**不**在本次拦截范围(见第二部分)。

---

### 文件 D · `.claude/settings.json`

#### 发现 5(承上)—【安全】matcher 补齐工具
- **建议改动**:第 28 行
  `"Write|Edit|Bash|Read"` → `"Write|Edit|Bash|Read|Grep|Glob|NotebookEdit"`

#### 发现 6 —【中·安全】Bash deny 语法疑似失效
- **证据** `[读码]`:第 8–19 行用 `Bash(git push *)`(空格+星)。Claude Code 的 Bash 参数通配为冒号形式 `Bash(cmd:*)`;空格+星很可能匹配不到任何真实调用 → 整个声明式 deny 层可能是死规则,防护全落在 hook 上。
- **⚠️ Codex 必须先核实语法**:对照当前 Claude Code 权限文档确认 Bash matcher 正确写法后再改。预期修正为:
  ```
  "Bash(git push:*)", "Bash(gh pr create:*)", "Bash(git merge:*)",
  "Bash(git rebase:*)", "Bash(git cherry-pick:*)", "Bash(git reset --hard:*)",
  "Bash(git clean:*)", "Bash(npm install:*)", "Bash(npm ci:*)",
  "Bash(pnpm install:*)", "Bash(yarn install:*)", "Bash(bun install:*)"
  ```
  `Read(./.env)` / `Read(./.env.local)` / `Read(./.secrets/**)` 格式正确,保留不动。
- **验证**:在 hook 放行前提下构造 `git push origin x`,确认被 settings deny 命中(而非仅靠 hook)。

---

## 第二部分:架构性问题（需负责人/ Codex 决策，本次不盲目改字符串规则）

**共同根因**:从 argv 字符串判断"命令会不会执行 / 写文件 / push"本质不可靠,shell 的 glob / 变量 / eval 展开总能绕过启发式。

| 发现 | 现象 | 证据 |
|---|---|---|
| 1【严重】 | `sed` 的 `w`/`e`、`git grep -O` 可执行命令 / 写文件,却在只读白名单内 | `[实测]` 第 96、81 行 |
| 2【严重】 | `cat *.env`、`cat .env{,}`、`cat .e*` 靠 glob 绕过 `.env` 检查 | `[实测]` 第 39–45 行 |
| 3【严重】 | `p=push; git $p origin main` 靠变量间接绕过所有禁令 | `[实测]` 第 47–58 行 |
| 4-Bash | linked worktree 里 `git -C /primary commit` 无法按目标路径拦截 | `[读码]` |

**两个方向,请二选一并记录决定:**

- **(A) 定位为"防误操作"而非"防对抗"**:接受上述残余风险,在 `AGENTS.md` 明确写清"该 hook 仅防意外、不防对抗性 agent";配套轻收紧——`isReadOnlySegment` 里额外拒绝含 `$` 变量展开或 `=` 赋值的段(可挡住发现 3 的 `p=push` 类),`isReadOnlyBash` 已挡 `$(` 与反引号。**成本低,不改变安全等级定位。**
- **(B) 提升到 OS 级强制**:只读挂载 / 容器 / seccomp 做真正边界,hook 退居友好提示。**成本高,才是真正闭合。**

> Claude 建议:先落第一部分 6 项;第二部分选 (A) 做文档 + 轻收紧,把 (B) 记为后续技改项。

---

## 第三部分:验证闸门

```
1. hook 分派逻辑 → 用 echo JSON 管道打 hook,断言退出码:
     printf '%s' '{"cwd":"<primary>","tool_name":"Write","tool_input":{"file_path":"x"}}' | node .claude/hooks/require-linked-worktree.mjs; echo exit=$?
     - Write(primary) / Read(.env) / Grep(path:.env) / NotebookEdit(primary) → exit 2(拦截)
     - Read(普通) / Grep(普通路径) / Glob → exit 0(放行)
     - (在 linked worktree 内)Write 绝对路径指向主 checkout → exit 2(发现 4)
2. deny() → 上述拦截用例 stderr 为干净文案,不再是 JSON 串
3. compose.test.yaml → docker compose -f compose.test.yaml config 显示 name=garment-canvas-test;裸 down 不再命中 garment-canvas
4. test 脚本 → 经 symlink 绝对路径跑 npm test 确认真跑了测试(发现 8);留 stale 同名集群再跑确认被回收(发现 9)
5. settings → 对照文档确认 Bash matcher 语法;git push 被 deny 命中(发现 6)
最终闸门:npm run check(lint+test)+ npm run build 通过;GitNexus detect_changes 仅影响预期符号;
         每条 deny 路径实测确实拦截(无 fail-open)。
```

---

## 第四部分:执行约束（项目规则）

1. **必须在 linked worktree 执行**:`claude --worktree fix-guardrails`(或等价 `git worktree`)。主 worktree 为 audit-only,hook 会拦写操作,不得绕过。
2. **改符号前跑 GitNexus `impact`**:`deny` / `isReadOnlyBash` / `isReadOnlySegment` / `createComposeProjectName` 等;HIGH/CRITICAL 先告警。
3. **交接前**:`npm run check`、`npm run build`、`detect_changes({scope:"compare", base_ref:"main"})`;测试不得调用付费 provider。
4. 只做本地提交,**不 push / PR / merge / rebase / cherry-pick / reset --hard / clean**;不安装/更新依赖。
5. 完成后按 `AGENTS.md` 回填结构化 handoff(BASE_COMMIT、worktree、branch、commit、findings、tests run、affected flows、residual risks、requested review focus)。

---

## 待 Codex 决策清单

- [ ] **发现 9**:是否接受"去 pid + 放弃同 worktree 并发"?
- [ ] **发现 6**:核实 Bash matcher 正确语法(`Bash(cmd:*)` 还是其他)。
- [ ] **第二部分**:选 (A) 轻收紧 + 文档,还是 (B) OS 级沙箱?
- [ ] 是否同意"第一部分先行落地,第二部分单独技改"的分批策略?
