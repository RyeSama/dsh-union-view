# 更新记录

## 0.3.0

**联合视图只显示你和 AI 说的话**

以前一屏里混着三种噪音，现在都滤掉了：

- **AI 的思考过程**：不显示，也不参与合并。以前的判断读的是内容块的 `type` 字段，实际字段叫 `kind`，所以一条都没命中——这是思考过程一直没被剥掉的真因。
- **工具调用与工具结果**：`[调用 read_image]` 这类行不再出现，几十条连着刷屏的情况没了。
- **系统注入**：`<AEGIS_DSH_ROUTING_BOOTSTRAP>`、`Time sampled while preparing turn 12…`、`Browser time zone for this request…`、`[Compressed conversation section]`、`Current working directory…` 这些宿主塞给 AI 的内容，以前被当成用户说的话搬上了桌，现在按整块/逐行规则过滤。

**合并侧同步收紧**

`/weld` 生成新对话时：剥掉思考过程（包括 `data.stream` 里那份逐 token 回放记录）、剥掉工具内容块与 `tool/call`、`tool/result` 事件、剥掉会话开头的重复初始化事件、引用去重。

**已知问题：合并出来的新对话可能打不开**

dsh 从磁盘读回日志时会校验结构（turn 必须连续、`turn/start` 必须跟在上一轮收尾之后、`sourceEventSeqs` 不能重复也不能指向后面的行），跨会话拼接很难同时满足，报 `SessionFormatError: turn/start does not open the expected turn`。

已试过四种修法都不行：按顺序重编号 turn、末尾轮补齐 `turn/end`、保留首组初始化事件、引用去重。要做稳得改成走宿主自己的 `ctx.sessions.create()`，让内核自己写日志，而不是手写文件。

按钮已标注「（实验）」，README 的「已知限制」里写清了。

## 0.2.0

**新增：在联合视图里直接生成新对话**

勾几个对话 → 填「每个取最近 N 轮」→ 点「合并为新会话」。不用再手打 `/weld` 和对话编号。生成的新对话在侧栏最上面（显示「未命名」），点开能接着聊；原对话不受影响。提交后会自动刷一次会话列表，不用手动刷新页面。

配套改动：

- `/weld` 不带参数时列出最近 12 个对话（编号、时间、第一句话），照着抄就行
- 合并时会剥掉 AI 的思考过程，只留用户和 AI 的最终输出，省下大量窗口
- README 重写为面向普通用户的说明，技术细节收进折叠区

## 0.1.0

首个版本。
