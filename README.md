# dsh-union-view

DSH Web GUI 的**联合视图**：同时勾选多个会话，把它们的转录拼成一条只读的联合时间线。

会话多了以后，问题不是"找不到会话"，而是"同一件事散在三个会话里"——需求在 A 里定、实现在 B 里试、结论在 C 里。
联合视图把这些会话放进同一块画布，原样并排，不合并、不改写、不注入。

```
┌ 对话  GAL视窗  [联合视图]  轨迹 ┐
│ 联合视图  2 个会话 · 1449 条消息 · 只读   [时间线][分栏][轮次对齐] [系统事件][刷新][选择会话][清空] │
│ ── 长上下文自动总结优化 ──┬── 数控雕刻文件任务指导 ── │
│ AI 23:44:00             │ AI 15:34:21             │
│ 确认：`SessionBinding` …│ [调用 read_image …]     │
└─────────────────────────┴─────────────────────────┘
```

## 三种布局

| 布局 | 用途 |
| --- | --- |
| **时间线** | 所有会话的消息按时间交错排，看"当时到底先后发生了什么" |
| **分栏** | 每个会话一列，各自独立滚动，看"同一时刻两边各在做什么" |
| **轮次对齐** | 左侧是轮次序号，第 N 轮各会话的内容并排，看"同一个问题两边分别怎么答" |

![时间线](docs/screenshots/timeline.png)
![分栏](docs/screenshots/columns.png)
![轮次对齐](docs/screenshots/turns.png)

## 与相邻方案的边界

| 已有能力 | 它做了什么 | 本插件不做的事 |
| --- | --- | --- |
| `@` 引用会话（`dsh-session-reference`） | 把另一个会话的快照**注入当前轮**的模型上下文 | 不注入。联合视图不进模型上下文，模型看不见 |
| `dsh-belief-merge` | 读取其它会话的模型面，合并后**每轮注入** | 不合并、不评分、不检测矛盾 |
| `dsh-maze` | 多会话**对比**（差异视图） | 不做 diff，不做评分 |
| 侧边栏 | 一次显示**一个**会话 | 不改会话归属，不新建会话实体 |

一句话：**联合视图是视图，`/weld` 是数据操作**。前者没有新会话、没有合并产物、没有不可逆写入，随时关掉原会话一字未改；后者会真的生成一个新会话文件（源会话仍只读）。

联合视图本身不碰 prefix cache：billion-context 的压缩块谱系、`mNNNNN` 引用编号、会话日志都不参与，读的是客户端已经加载的 `ChatSnapshot`。`/weld` 生成的是**新**会话，新会话的第一轮就是全新前缀，与原会话的缓存无关。

## 焊接成新会话：`/weld`

联合视图是只读的，模型看不见它。如果你需要**让模型真的同时看到几个会话的历史**，用 `/weld` 把它们焊成一个真实的新会话。

```
/weld <会话id前缀> <会话id前缀> … [--turns N]
```

- 不给 `--turns` 就是全量焊接；给了就每个源只取**最近 N 轮**（长会话全量焊接会直接顶到窗口上限，实测两个几百条的会话合起来 1.1 万条事件，必须截断）
- 新会话会出现在侧栏，有独立 id、独立文件，**可以继续对话**——模型看到的是真实历史，不是注入
- 只读源会话：只读取、只合并到新文件，源会话一个字节都不改
- 自动剥掉 reasoning 块（思考过程不进新会话）

新会话标题显示「未命名」，因为 `session/title` 事件带 `messageSeqs` 引用，合并后指向已被裁掉的消息会让日志校验失败，所以直接丢弃。改个名即可。

### 为什么不能手写会话文件

自己往 `~/.dsh/sessions/<project>/session-<uuid>/` 里写一个格式正确的 `session.v4.jsonl.zstd`，侧栏里**不会出现**。两条硬约束：

1. **文件格式**：header 必须独占第一个 zstd frame 且以单个 `\n` 结尾，之后每条事件各自成一个 frame。全部塞进一个 frame 会被 `assertZstdHeaderFrame` 判成 `corrupt Zstandard session log`，而 `listArtifacts` 会**静默跳过**这类文件——不报错，就是没有。
2. **所有权账本**：侧栏不是扫目录得来的，是读 `~/.dsh/storages/workspace.json` 里 `tables.workspaces[<id>].sessionIds`。没进这个数组的会话文件，格式再对也不显示。

`/weld` 的绕法是自己写文件 + 调 `workspaceRegistry` 的 `attachSession(newId)`：它会先用 `host.readSessionHeader` 校验 header 里的 `cwd`（realpath 归一后）等于工作区路径，通过了才把 id 前插进 `sessionIds`。直接改 `workspace.json` 也能生效，但**只能用 Node 的 `JSON.parse`/`stringify` 改**——用正则删数组元素会留下孤立逗号，JSON 一坏，整个 GUI 变成「暂无会话」。

## 安装

```bash
dsh plugin install dsh-union-view
```

装完重启 DSH Web（刷新页面即可，客户端 bundle 会被自动发现）。

### 本地开发安装

`pnpm` 不可用或想直接跑源码：

```bash
node scripts/build-client.mjs     # 打包客户端到 .dsh-plugin/client.js
node scripts/install-local.mjs    # 复制到 ~/.dsh/plugins/dsh-union-view + junction + 写 profile
```

`install-local.mjs` 做三件事：复制仓库到 `~/.dsh/plugins/dsh-union-view`（排除 `node_modules`/`.git`）、
在 web profile 的 `node_modules` 下建**目录联接**（不需要管理员权限）、把包名追加进 `dsh.profile.bundles`
（`package.json` 先备份成 `package.json.bak-unionview-<时间戳>`）。脚本幂等，可反复跑。

## 用法

1. 打开任意会话，切到「联合视图」标签。
2. 点「选择会话」，勾选要联合的会话（可多选；勾选状态存在 `localStorage`，下次自动恢复）。
3. 选布局。三布局随时切换，滚动位置各自维护。
4. 「系统事件」开关：打开后额外显示 `turn/step` 边界、工具结果等系统节点（默认只显示对话正文）。
5. 「刷新」重新读一次会话目录（新会话不会自动出现）。

## 渲染上限

只读视图也怕一次渲染十万个节点，所以：

- 时间线最多渲染**最近 400 条**消息，上方提示「更早的 N 条已折叠」
- 分栏每列同样按最近 400 条截断，各自独立
- 轮次对齐最多渲染**最近 120 轮**，每格最多 3 条正文 + 「还有 N 条」

## 实现要点

- 注册在 `conversation.view` 槽位（`id: 'union'`，`order: 6`），与 `gal-view` 同构；
  `dsh.client.inject: ["slots"]` 只保证 bundle 被加载，**运行时还必须在 `src/client.js` 里
  `export const inject = ['slots', 'sessions', 'uiConversation']`** —— 少写一个，cordis 就不会把服务挂到插件
  ctx 上，`ctx.sessions` 永远是 `undefined`。
- 数据源：`ctx.sessions.retain(sessionId, { source: 'unionView' })` → `await ref.ready` →
  `ctx.uiConversation.binding(ref.binding).target('chat')`，从 `ChatSnapshot.legacy.nodes` 拿节点数组。
  纯客户端读取，不写任何东西。
- 只读保证：不调 `activate`、不 `prompt`、不 `fork`、不 `decompress`，只用 `retain` 的引用计数。
- 铺满会话主体：`data-union-view` 的根节点先 `position: relative`，`useEffect` 往上找到第一个
  `position !== 'static'` 的祖先（实测是 `.wSkVaW_body`），挂 `data-union-fill` 交给 CSS 绝对定位。
  **定位必须在 CSS 里写，不能写内联 style**（内联 `position` 会盖掉 CSS 的 `absolute`，面板就会
  按内容高度涨到 11 万像素）。

## 已知限制

- 只读：不能在联合视图里发消息。想继续问，切回原会话。
- 消息正文按纯文本渲染（保留 `**`、反引号原样），不做 markdown 排版 —— 这是有意的，转录要保真。
- 不感知 billion-context 的压缩块：如果某个会话已经折叠过历史，联合视图看到的是折叠后的可见节点。
- 未做跨会话搜索/过滤；未做导出。

## 许可

MIT
