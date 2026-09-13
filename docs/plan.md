# DSH × Figma：用 DeepSeek Harness 直接控制 Figma 做 UI 设计

> 规划文档 v2。v1 假设用 WebSocket + 插件 UI iframe 做网络层；**实测后被推翻**，见第 1 节的取证。
> Phase 0 已落地并通过 MCP stdio 握手验证；Phase 1（读取 + 视觉闭环）已实现并在真机上验收。
> 当前共 95 项自动检查（60 冒烟 + 35 序列化），见第 7 节。

---

## 1. 结论先行：三层架构（已按实测约束修正）

```
┌───────────────────────────────┐
│ DSH agent（deepseek-v4 vision）│
└───────────────┬───────────────┘
                │ MCP over stdio —— 官方 @deepseek-ai/dsh-mcp-client
                ▼
┌───────────────────────────────┐
│ figma-bridge（本地 Node 进程）  │
│  · MCP server (stdio)          │
│  · HTTP server 本机回环 :8790    │
│    （IPv4 + IPv6 双绑，供        │
│     插件用 localhost 访问）      │
│  · 命令队列 / 超时 / 断连收敛    │
└───────────────┬───────────────┘
                │ HTTP 长轮询（单次往返，结果搭下一趟车）
                ▼
┌───────────────────────────────┐
│ Figma 插件 main 沙箱            │
│  · 全局 fetch 拉命令            │
│  · figma API 执行并回传结果      │
└───────────────┬───────────────┘
                │
                ▼
        ui.html 状态面板（纯展示，不参与网络）
```

### 取证：这些约束决定了架构，不是选型偏好

| 事实 | 取证来源 | 后果 |
|---|---|---|
| 插件沙箱的非 Figma 全局**只有** `figma`、`__html__`、`__uiFiles__`、`console`、`setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`、`fetch` | `@figma/plugin-typings/index.d.ts` 的 `declare global` 块 | **没有 `WebSocket`** → 不能用 socket |
| 上面这个清单里**有 `fetch`** | 同上；[Global Objects 文档](https://developers.figma.com/docs/plugins/api/global-objects/)把它列为"across the Plugin API 的全局变量" | **插件主线程能直接联网** → UI iframe 不必做网络层 |
| 插件不能监听端口，UI 是 null origin 的沙箱 iframe | [Making Network Requests](https://developers.figma.com/docs/plugins/making-network-requests/)："Plugin iframes have a `null` origin" | 插件只能主动外连 → 必须有本地桥；桥必须回 `Access-Control-Allow-Origin: *` |
| `documentAccess: "dynamic-page"` 是新插件**必需**字段 | [Plugin Manifest](https://developers.figma.com/docs/plugins/manifest/) | 不能用同步 `figma.getNodeById`，不能遍历所有页面 → **所有命令必须显式传 nodeId** |
| `figma.root.name` 返回当前文件名 | plugin typings 中 `BaseNodeMixin.name` 的 JSDoc | 无需 `enablePrivatePluginApi` 也能拿到文件名 |
| `figma.commitUndo()` / `triggerUndo()` 存在 | plugin typings | 撤销粒度可控：一次批量写 = 一个 undo 步 |
| `BaseNodeMixin.removed: boolean` 存在 | plugin typings | 长链接插件必须做"节点已被删/被撤销"的防御检查 |
| manifest 的 `allowedDomains` **拒绝 IPv4 字面量** | 实测报错 `'http://127.0.0.1:8790' must be a valid URL`；文档列出的合法示例只有 `http://localhost:3000` 一类 | 插件唯一能用的 origin 是 `http://localhost:<端口>` → 桥必须双族回环监听 |

**因此：长轮询不是妥协，而是在"只能主动外连 + 无 WebSocket"约束下的唯一正解。**

### 长轮询协议（一句话）

插件 POST `/figma/poll`，携带上一批命令的结果；桥最多挂起一个响应（默认 25s）。
有命令就立刻用这个挂起的响应投递**一条**，插件串行执行，结果搭下一趟 poll 回来。
一次往返同时完成"投递命令"和"回传上一条结果"，且顺序天然正确。

---

## 2. 被否决的替代方案

| 方案 | 为什么不行 |
|---|---|
| 插件 UI iframe 做网络层（v1 方案） | 主线程的全局 `fetch` 已足够，加 iframe 只是多一层 postMessage 和构建复杂度 |
| WebSocket | 沙箱没有 `WebSocket` 全局，不可用 |
| Figma 官方 Dev Mode MCP Server | 偏只读（`get_code`/`get_image`/`get_variable_defs`），写入能力弱，做不了"设计" |
| 纯 REST API + Personal Token | 能改文件但拿不到选区、看不到当前视口、无法做视觉闭环 |
| 只用 DSH 动态 Cordis 插件 | 进程内、会话级，摸不到 Figma；适合做原型不适合做交付 |

---

## 3. 工具面设计：少而强 + 逃生舱

**反面做法**：每个 Figma API 一个工具（40+ 个）→ 每次请求都灌满 schema、模型选择困难、长尾永久覆盖不到。

**采用做法**：8 个语义工具 + 1 个逃生舱。工具名不带 `figma_` 前缀，因为 DSH 会加命名空间，最终形态是 `mcp__figma__status`。

Phase 0 已实现：`status`、`ping`。Phase 1 已实现：`describe`、`screenshot`。后续：

| 工具 | 作用 | 为什么这样切 |
|---|---|---|
| `status` ✅ | 链路状态、文件/页面/选区、本插件支持的命令清单 | 每次动手前的握手；失败时的第一诊断入口 |
| `ping` ✅ | 往返一个小 payload，测延迟 | 区分"链路慢"和"Figma 慢" |
| `describe(scope, depth, fields, limit)` | 结构化读：选区 / 指定 id / 当前页 | 唯一读入口；深度上限 + 字段投影防 token 爆炸 |
| `screenshot(nodeIds?, scale?)` | 导出 PNG → MCP image content | **杀手锏**：当前模型是 vision，"看→改→再看"闭环靠它 |
| `apply(ops[], parentId?)` | 批量声明式写：create/update/move/delete/rename/group | 一次调用 = 一次 undo（配合 `commitUndo`） |
| `text(ops[])` | 文本专用：字体加载、行高、字距、自动高度 | 字体是最大坑，独立出来才能把 fallback 链做扎实 |
| `tokens(action, payload)` | Variables / Styles 读写与绑定 | 让产出"系统化"而非"好看但不可维护" |
| `components(action, payload)` | 建组件、实例、变体集 | 组件化是 UI 设计的分水岭 |
| `export(nodeIds, format)` | 交付导出 PNG/SVG/PDF | 与截图区分：截图给模型看，导出给人用 |
| `script(code)` | main 线程执行受限 JS（白名单 API） | **逃生舱**：覆盖长尾 API，否则方案永远"差一点" |

### 设计原则

1. **强制"看→写→看"**：任何写入后，桥默认自动追加一张受影响区域的截图返回。
2. **不让模型碰裸 API**：auto-layout 抽象成 `layout: {mode, padding, gap, align, sizing}`，插件侧翻译。模型不该知道 `counterAxisAlignItems` 怎么拼。
3. **失败必须可行动**：每个失败都带 `code` + `hint`。Phase 0 的 `NO_PLUGIN` 已按此实现（告诉用户去哪个菜单、确认什么）。
4. **宁可拒绝也不静默**：协议版本不符时桥回 409 并说明怎么修，插件面板同步报错停机，而不是干挂。

---

## 4. 目录结构（已落地）

```
D:\个人文档\figma\
├─ package.json                 # pnpm workspace + 构建脚本
├─ pnpm-workspace.yaml          # 包的 store 在 .pnpm-store（不碰全局）
├─ tsconfig.base.json
├─ docs\plan.md                 # 本文档
├─ .dsh\skills\figma-design\    # 后续：DSH 项目级 skill（设计规范）
└─ packages\
   ├─ protocol\                 # 共享线协议：类型 + 校验函数 + 常量（唯一真源）
   ├─ bridge\
   │  ├─ src\mcp.ts             # 入口：MCP server + 绑端口重试 + 关闭钩子
   │  ├─ src\bridge.ts          # HTTP 服务 + 客户端注册表 + 命令队列/超时
   │  ├─ src\tools.ts           # 面向模型的工具描述
   │  └─ scripts\smoke.mjs      # 30 项端到端冒烟检查
   └─ plugin\
      ├─ manifest.json
      ├─ ui.html                # 状态面板（纯展示）
      ├─ src\code.ts            # main 线程：网络循环 + 命令 handler 注册表
      ├─ src\protocol-types.d.ts# 把协议类型提升为环境类型，见第 6 节
      └─ scripts\verify-bundle.mjs
```

**零打包器**：`tsc` 直出。`protocol` 出 ESM+d.ts；`bridge` 出多文件 ESM（Node 原生跑）；`plugin` 出单文件经典脚本。

---

## 5. 分阶段实施

### Phase 0 — 打通链路 ✅ 已完成
最小插件 + 最小 bridge + DSH profile patch。已交付 `status` / `ping`。

### Phase 1 — 读 + 视觉闭环 ✅ 已实现并在真机验证
`describe`、`screenshot` 已实现，并在真实 Figma 文件（`Accfox / 客户端V2.0`）上跑通视觉评审。设计要点：

- **`describe`**：深度受限的节点树，含 id/type/name/坐标尺寸/auto-layout（用 Figma 自己的词汇：`layoutMode`/`itemSpacing`/`padding`/`layoutSizing`）/fills/strokes/文本/组件引用/**变量绑定**。
  带 `depth`、`limit`、`fields` 三重封顶；截断时用 `depthLimited` / `countLimited` **区分是哪一种上限**并给出对应修法。`mixed` 会被显式报出（见第 6 节）。
  默认读选区；`scope:"page"` 读当前页顶层；`nodeIds` 直读指定节点。
- **`screenshot`**：`exportAsync` 导出 PNG → **手写 base64**（沙箱没有 `btoa`/`TextEncoder`）→ 搭 poll 回传 → 桥渲染成 **MCP image content**。
  每张图前有一条 caption（节点 id / 像素尺寸 / 实际缩放），导出失败的节点**逐个列出原因**——静默丢图和"画布是空的"对模型来说长得一模一样。
  像素预算 1.6M/张，超出自动降 scale 并在 caption 里报出实际值；单次最多 4 张。
- **`PLUGIN_MISSING_COMMAND`**：插件每次 poll 都自报支持的命令，所以在模型看到工具、插件却跑不了时，桥会**提前拦下**并给出"去重跑插件"的指令，而不是丢进 Figma 变成泛化失败。

**真机验收结果**：`describe` 读到 `Accfox / 客户端V2.0` 的真实结构（9 个顶层节点，含 8 个页面）；
`screenshot` 把 1920×1080 登录页以 0.88x（自动降档并如实报出）推进模型上下文。
模型因此指出 5 个带节点 id 的问题：内容未垂直居中（`885:1924` 的 `counterAxisAlign: MIN` + 不对称 padding 导致下方空 352px）、
法务文案 12px 且换行为硬回车（`1435:6003`）、QR 所在子树被非整数缩放 ≈1.2647 倍导致 QR 落在 227.65px、
QR 上圆角浅灰卡片套直角近黑边框（`1435:5999` / `1435:6000`）、
以及设计系统应用方向反了（主标题填充硬编码 `#1d2129`，最不显眼的同意文案反而绑了变量）。

> 后续核实推翻了第 4 条：`1435:6000` 的 `strokeWeight` 是 **0**，那条近黑边框并不渲染。
> 见第 6 节——`strokes` 数组存在被直接读成"有可见边框"，是这次评审里唯一一次把推断当事实。

### Phase 2 — 写 ✅ 已实现并在真机上完成第一次写入
`apply` 已实现（create / update / move / rename / delete，白名单校验、`ref` 解析、每批一次 `commitUndo()`），
`text` **并入 `apply`** 而非独立工具（理由见 README）。验收清单里"一句话生成登录页"尚未做，
但写入通路已用真实文件验证。

**真机验收结果**（`Accfox / 客户端V2.0` 登录页）：把 `885:1924` 从"上方 168 / 下方 352"改成**上下各 260**，两次 `apply`：

| 步骤 | 操作 | `1435:5971` 的 y | 上/下空白 |
|---|---|---|---|
| 0 | — | 168 | 168 / 352 |
| 1 | `layout.counterAxisAlign: MIN → CENTER` | 339 | 339 / 181 |
| 2 | `layout.padding: {168,10,10,10} → 24` | **260** | **260 / 260** |

第 1 步后仍未居中（差 158px），而 `168 − 10 = 158` 正好是内边距差——内容在**内边距盒**里居中，
而不是在视觉画布上。两步的数值都在动手前算准，实测完全吻合；每一步都用 `screenshot` 复看，
不是只看返回的 JSON。

**顺带发现的操作经验**：改了桥代码（尤其 `tools.ts` 的工具增删）后，DSH 的 MCP client 不会重取工具列表
（新工具报 `unknown tool`），但也**不需要重启 DSH**——结束桥进程即可，client 会在退避内重连并重新执行
磁盘上最新的 `dist/mcp.js`。已写进 README。

### Phase 3 — 系统化（约 1.5 天）
`tokens`、`components`、`.dsh/skills/figma-design/SKILL.md`。**验收**：产出 Variables + 组件库 + 3 个页面，颜色/间距全部变量绑定。

### Phase 4 — 逃生舱与稳健性（约 1 天）
`script`、多文件路由（按 token 注册，工具带可选 `target`）、配对码鉴权。**验收**：杀掉桥再启动，插件自愈。

### Phase 5 — 发布 Figma Community
见第 8 节，这条路径有前置约束。

---

## 6. 踩过的坑（都是实际发生的，不是假想）

| 坑 | 现象 | 处理 |
|---|---|---|
| `isolatedModules` 让 tsc 在产物末尾补 `export {}` | Figma 加载经典脚本时**语法报错** | 插件源码保持**零 import/export**；共享类型经 `src/protocol-types.d.ts`（无产出）提升为全局类型。`verify-bundle.mjs` 每次构建强制校验 |
| SDK 的 `StdioServerTransport` 只监听 stdin 的 `data`/`error`，**不监听 EOF** | DSH 会话结束时桥不会退出；HTTP server 持有事件循环 → **每个会话留一个孤儿进程** | 在 `mcp.ts` 里自己监听 `process.stdin` 的 `end`/`close`。实测 stdin 关闭后 **316ms 干净退出** |
| esbuild 的 JS API 用管道 stdio 拉起子进程 | 开发沙箱下**永久 EPERM** | 完全弃用打包器，改 `tsc` 直出；顺带得到可读的堆栈 |
| 绑端口失败就退出进程 | DSH 会直接丢失工具，用户什么都看不到 | 改为：工具常驻、每次调用原样返回绑定错误、后台 10s 重试自愈。多开 DSH 会话时这条特别有用 |
| PowerShell `>` 重定向默认写 UTF-16LE | 抓取到的 stdout 被判定为二进制、JSON 解析失败 | 只用它做一次性诊断，正式校验走 `cmd /c` 重定向 |
| Figma manifest 校验器**拒绝 IPv4 字面量** | 导入/发布第一步就报 `Invalid value for allowedDomains. 'http://127.0.0.1:8790' must be a valid URL.`，整条链路卡死在装机环节 | 只用 `http://localhost:<端口>`（文档列出的合法形式）。**连带后果**：`localhost` 在不同机器上解析到 `::1` 或 `127.0.0.1`，只绑一族会让插件报"连不上"且无法自愈 → 桥改为**双回环地址监听**，并加进冒烟测试做回归保护 |
| 图省事写成 `String(error)` | 面板显示 `Cannot reach … — [object Object]`，把真实原因（连接被拒 / CSP 拦截 / DNS）全吃掉了 | Figma 沙箱的 `fetch` **不用 `Error` 拒绝，而是抛普通对象**。改为依次尝试 `message`/`error`/`reason`/`detail`/`name`，再退到 `JSON.stringify`，最后才打印 key 列表 |
| 用 `http://${host}:${port}` 拼地址 | `/figma/health` 里出现 `http://::1:8790` 这种畸形 URL | IPv6 字面量必须加方括号；抽 `formatOrigin()` 并加冒烟检查 |
| DSH 补丁层里**裸写** `- id: xxx` 来新增插件 | DSH 只在日志里留一句 `[loader] patch: entry "xxx" not found` 然后**静默跳过**，表现为"重启了但工具就是不出现" | 新增必须包在 `insert:` 里。权威语义见 `dsh-app-boot/lib/index.js` 的 `applyEntryPatches()`：`if (insert) {...data.push(...insert)}`，否则按 id 覆盖已有条目。README 已改，并加了离线自检流程 |
| 靠"改一次配置重启一次 DSH"调试补丁 | 每轮验证都要重启，成本极高 | 发现 `dsh --profile <name> --dump-config` 与应用启动**共用同一份补丁语义**（注释原文：so a dump can never drift from what boots），可在不重启的情况下复现 `patch: entry not found` 并确认修复 |
| 担心插件包在 profile 里解析不到 | 一度准备用 `dsh plugin add` 往 profile 装包 | 读 `lib/module-resolution.js` + `lib/package-overlay-CMBrTgnt.js`：解析走"桌面安装 / profile"双源 overlay，`profiles/node_modules` 是共享依赖根；`dsh-mcp-client` 命中 install 侧（版本相同时 install 优先），parentURL = app 入口 → 从 app 的 `node_modules` 解析。**无需改动 profile 依赖** |
| 以为 profile 的 `patchReload: "live"` 会重载补丁里的 host 插件 | 改完补丁等 30s，MCP server 进程**纹丝不动**（pid 与启动时间不变，DSH 日志也没有任何新的 loader 消息） | **实测证伪**：该补丁只在应用启动时读取。改补丁（包括只加一个 env）后必须重启 DSH。`patchReload: live` 应只覆盖客户端插件模块，不含 host 侧 MCP server |
| 验证脚本把 stderr 重定向掉 | `2>$null` 后冒烟输出"1 check failed"却看不到是哪一条——因为 `check()` 用 `console.error` 报失败，失败详情被自己的重定向吃了 | 断言失败必须可见：跑校验时保留 stderr，或用 `2>&1`。这条差点让我在"看起来全过"的状态下收工 |
| 断言写死大小写 | `hint.includes('re-run')` 对上文案里的 `Re-run` 失败，看起来像产品 bug | 修的是断言不是代码。凡是断言人写文案的地方，一律不区分大小写 |
| 序列化器把 `figma.mixed` **静默丢弃** | 真实案例：Accfox 的 `1435:6003` 同时报出 `variables.fills`（填充绑了变量）**却完全没有 `fills` 字段**——两行文字颜色不同使 `fills` 为 mixed。模型看到的是"有填充绑定、但节点没有填充"这种自相矛盾的信息，接着就会跳过该属性 | `figma.mixed` 是**答案**而非缺失。所有可能 mixed 的字段（`fills`/`strokes`/`cornerRadius`/`strokeWeight`/`opacity`/`visible`/`fontSize`/`fontName`/`lineHeight`/`letterSpacing`/`textAlign*`）一律输出字符串 `"mixed"`，工具描述里也写明这层语义 |
| 单个 `truncated` 标志混合了两种截断 | `describe(depth:1)` 报 `truncated: true`，读者会以为节点数超限，实际是**深度**到了——两者需要完全不同的修法（加深 vs 缩范围） | 拆成 `depthLimited` / `countLimited` 并各给针对性提示；`truncated` 保留为汇总 |
| 插件是无导出的经典脚本 ⇒ 序列化器不可测 | 最容易对模型撒谎的代码（描述画布）恰恰无法 import，此前**零测试覆盖** | 用 `vm` 在带桩 `figma` 的环境里**求值**整个 bundle：经典脚本的顶层 `function` 声明会成为全局属性，于是 `serializeNode` / `describeCommand` 可直接调用。新增 `scripts/test-serializer.mjs`（35 项），已接入 `pnpm build` |
| **没有构建身份**，无法判断 Figma 里跑的是哪份产物 | 连续两次构建之间，面板的版本号都是 `v0.1.0`、命令列表都是 `status,ping,describe,screenshot`——**完全一样**。等于每次改完都要靠猜（或盲目重新导入）来确认插件是否更新，而且模型也无法核对自己面对的是哪个实现 | 新增 `scripts/stamp-build.mjs`：用编译产物的 sha256 前 8 位替换 `src/code.ts` 里的 `__BUILD_ID__` 占位符。build id 出现在**面板、`/figma/health`、`status` 返回**三处。相同源码重建得到相同 id（无改动即无改动），重复 stamp 会被拒绝并说明原因 |
| `strokeWeight: 0` 被当作"噪音"省略 ⇒ 数据说"有描边"、画布上什么都没有 | 真机 `1435:6000` 报了 `strokes: [近黑的 #1d2129]` 却**没有 `strokeWeight`**，读者只能按 Figma 默认值 1 理解——于是"有一个近黑 1px 边框"。这个结论被写进了视觉评审，**其实是错的**：描边存在但线宽为 0，根本不渲染 | 规则改为「**只有当存在描边时才报线宽，且此时一定报**」：无描边 ⇒ 不报（顺带消掉每个节点都带的 `strokeWeight: 1` 噪音）；有描边 ⇒ 0、`mixed`、具体值都如实报出。`strokeExists` 同时覆盖 `strokes === 'mixed'`。新增 3 条单测，变异检验确认旧的 `!== 0` 规则会让其中 2 条失败 |
| 把"代码里读到的"当成"画布上看到的" | 上一条的根因：`strokes` 数组存在被我直接读成"有可见边框"，而没有核对线宽。**这是评审里唯一一次把推断当事实**，还正好是最难从截图确认的细节 | 涉及渲染结果的结论必须能同时被数据与截图其中至少一方确证；只靠"属性存在"推断外观时，明确标注为待确认，而不是写进结论 |
| `tokens` 只枚举**本地**变量，而真实设计系统在库里 | 真机第一次 `audit` 报"160 个未绑定字面量，**0 个有同值候选**"。一开始像功能失效，核查后发现是**边界问题**：`getLocalVariablesAsync()` 拿不到库变量，而该文件的设计系统确实在团队库里（`describe` 报出的 `VariableID:17bfc0ab…/6286:95` 这种带 `/` 的 id 就是库变量）。枚举库需要 `teamlibrary` 权限 | **不枚举库，改为从文档反向发现**：走一遍节点收集所有 `boundVariables` id，用 `getVariableByIdAsync` 解析、用 **`resolveForConsumer(node)`** 取"在该使用点上真正渲染的值"（它会处理别名与模式覆盖）。这比枚举库更有用——得到的是"这个文件实际依赖的 token"及其生效值。这些库变量按值并入候选索引，`audit` 因此能建议复用它们；`list` 用 `source: 'local' \| 'library'` 区分 |
| 用渲染后的值去建"值→变量"索引 | 写这个功能的测试时发现：颜色变量的 `value` 是渲染形态（`'#4e5969'` 字符串），而按值比较需要一个原始 RGBA 对象。拿渲染值去建索引会让**每一个库颜色变量都静默地当不成候选**——功能看起来完好，只是永远不给建议 | 使用记录里同时保存 `token`（给人看/给模型读）和**原始 `key`**（给索引比较用），两者分开存。变异检验确认：把库变量排除出索引后，3 条断言失败，失败输出正好是"finding 里没有候选" |

---

## 7. Phase 0 验证记录

**协议层 —— `node packages/bridge/scripts/smoke.mjs`，60/60 通过**（用一个假插件替代 Figma 驱动完整协议）：
- 无插件时不挂起，回 `NO_PLUGIN` 且 hint 指向具体菜单
- 空闲 poll 真的被挂起满 250ms 窗口（证明长轮询成立），并下发 token
- 命令按调用顺序单条投递、`args` 正确、`id` 唯一且回传时保持不变
- 插件不响应 → 250ms 预算内回 `COMMAND_TIMEOUT`，之后链路仍可用
- 协议版本不符 → HTTP 409 + `PROTOCOL_MISMATCH` + 修复提示
- 畸形请求体 → 400，桥不崩
- **能用 `http://localhost:<端口>` 连通**（插件唯一被允许的 origin），且同时绑定了 `127.0.0.1` 与 `::1`，IPv6 origin 带方括号
- 插件中途消失 → 及时回 `PLUGIN_DISCONNECTED`，不等满预算
- `/figma/health` 暴露绑定地址、文件名与选区数（模型诊断用）

**真机（真实 Figma + 真实文件）—— 已跑通**：
- 插件导入成功（`manifest.json` 通过 Figma 校验，含 `networkAccess`）
- 插件面板显示 `connected`；`/figma/health` 报回真实身份：`fileName: "估价师"`、`pageName: "Page 1"`、`commands: ["status","ping"]`
- **这证明整条链路可用**：Figma 沙箱全局 `fetch` → `http://localhost:8790` → CSP 放行 → 双族回环 → 桥
- 杀掉桥再重启，插件在退避窗口内（≤10s）**自动重连**，无需重启插件

**MCP stdio 层 —— 通过 `cmd /c` 重定向驱动真实二进制**：
- `initialize` → `{"name":"dsh-figma-bridge","version":"0.1.0"}`，协议 2025-06-18
- `tools/list` → **4 个工具**：`status`、`ping`、`describe`、`screenshot`，schema 与 `readOnlyHint` 正确
- `tools/call describe` / `screenshot` → 在无插件时回 `NO_PLUGIN` 且带指引
- `tools/call 不存在的工具` → 明确列出可用工具
- stdin EOF → 316ms 内退出

**Phase 1 的图像通路 —— 9 项专测（`contentForResult`）**：

这条通路最危险的地方是**静默失败**：截图没能以图片形式到达模型，和"工具返回空"对模型来说完全一样，模型就会对着没看过的设计下判断。所以单独覆盖：
- 图像块数量正确、`mimeType` 透传、**base64 逐字节一致**（用真实 1x1 PNG）
- caption 排在图**之前**，保证图和节点 id 不会错配
- 超过 4 张时封顶，且明确告知丢了几张 + 出路（改截父级 frame）
- 超大图被拒，且拒绝理由写明"降低 scale"，而不是让模型以为画布是空的
- 非图片 MIME（`image/svg+xml`）不被冒充成图片
- 空 bundle 也说明 `skipped` 的原因
- 失败结果渲染出 `code` + `message` + `hint`
- `PLUGIN_MISSING_COMMAND` 在桥侧拦下插件未实现的命令，且**从未投递给插件**（冒烟里断言了这一点）

**插件序列化器 —— `node packages/plugin/scripts/test-serializer.mjs`，35/35 通过**：

单文件经典脚本无法 import，于是用 `vm` 在带桩 `figma` 的环境里求值整个 bundle，直接调用其中的 `serializeNode` / `describeCommand`。覆盖：
- 所有可能 mixed 的字段（`fills`/`strokes`/`cornerRadius`/`strokeWeight`/`opacity`/`visible`/`fontSize`/`fontName`/`lineHeight`/`letterSpacing`/`textAlign*`）都报出 `"mixed"` 而非消失
- 具体值不受影响：坐标取整、hex 颜色、变量绑定、auto-layout、零 padding 省略
- 截断区分 `depthLimited` / `countLimited`，且提示文案各指其因
- 真实回归用例：绑定变量但 mixed 的填充，必须同时报出 `variables.fills` 与 `fills: "mixed"`

**两处修复都做了变异检验**（临时退回旧逻辑确认测试会失败）：mixed 修复使 4 项失败（含真实回归用例），截断标志修复使 4 项失败——其中一条失败信息正是旧行为的症状：明明是深度截断，提示却说"节点预算用尽"。

**完整闭环（DSH 托管，端到端）—— 已跑通**：
- 补丁修正为 `insert:` 后，DSH 启动日志不再有 `patch: entry ... not found`
- `node` 进程由 **DSH Desktop 自己拉起**（DSH 19:25:29 启动，桥 19:25:37 启动），非残留进程
- 模型工具列表中出现 `mcp__figma__status` / `mcp__figma__ping`，**成功调用**
- `status` 返回真实身份：`fileName: 估价师`、`page: 0:1/Page 1`、`bridge.paired: true`、插件侧耗时 **2ms**
- `ping` 带回中文 echo，插件侧耗时 **0ms** —— 顺带验证了整条链路的 UTF-8 无损
- 即 **模型 → MCP stdio → bridge → HTTP 长轮询 → 插件沙箱 → `figma` API** 全通

**插件产物** —— `dist/code.js` 15 KB 纯经典脚本，无 import/export/require；UTF-8 无乱码。

**尚未验证（需要真人操作 Figma）**：
1. 插件运行期间用户能否手动编辑画布 → 决定这是"AI 交钥匙"还是"人机协作"模式
2. `figma.showUI(..., {visible:false})` 能否在隐藏面板下保持长连接
3. 发布流程中的数字 `id` 字段与评审

---

## 8. 发布 Figma Community 的前置约束（重要）

官方文档明确：`devAllowedDomains` **只在开发期生效**；想让**已发布**的插件访问本地服务器，必须把 localhost 写进 `allowedDomains`，且此时 `reasoning` 是**必填**。

而且实测发现：`allowedDomains` 里**只能写 `http://localhost:<端口>`**，写 `http://127.0.0.1:<端口>` 会被校验器判为"不是合法 URL"。当前 `manifest.json` 已按此配置（含 `reasoning`），所以既能开发也能过发布校验。

还剩两件事：

1. **端口与 manifest 耦合**：端口可配置，但 `allowedDomains` 只能枚举固定端口。改端口就必须同步改 manifest，否则 Figma 按 CSP 拦掉请求。插件面板上已写明这条提示。
2. **评审风险**：一个"必须配套本地服务才能工作"的插件可能被评审质疑可用性。缓解：面板里给出清晰的英文引导 + 链接到 bridge 安装说明。

已完成：

3. **`id` 字段** —— `1680977634792093219`，以字符串写进 `manifest.json`（超过 2^53，字符串是 manifest 的合法类型，也避免被解析器改写精度）。
   **注意**：加了 `id` 之后必须**重新 `Import plugin from manifest…`**，光重跑插件不生效（manifest 在导入时读取）。
   上架文案与素材清单见 [`上架文案.md`](上架文案.md)。

**备选（若评审受阻）**：把直连本地改造成"中继模式"——插件连你自己的 `wss://` 中继，本地桥也连同一中继。为此第 2 节的传输层要抽成可替换实现；Phase 0 尚未抽出，属于 Phase 5 的工作。

---

## 9. 主要风险与对策

| 风险 | 对策 |
|---|---|
| 字体加载失败 / 中文乱码 | `text` 统一走 `loadFontAsync`；fallback 链 Inter → Noto Sans SC；字体列表缓存到桥 |
| auto-layout 语义翻译错 | 协议层只暴露语义化 `layout` 对象，插件侧集中翻译；禁止裸传 Figma 原始字段 |
| 大文件读取 token 爆炸 | `describe` 硬性 depth 上限 + 字段投影 + 节点数上限；桥侧对工具输出有 120k 字符截断保护（已实现） |
| 命令超时后 Figma 仍在执行 | 超时提示里明确写"命令可能仍在运行，请查看 Figma 窗口" |
| 固定端口 ⇒ 一次只能跑一个 DSH 实例 | 已实现的绑定失败自愈 + 明确指引；根治方案是 Phase 4 的"代理到已有 daemon" |
| 本机任意进程可通过 8790 驱动 Figma | 目前只绑 loopback。Phase 4 加配对码：面板显示 6 位码，桥校验 |
| 模型"自嗨式"设计 | 强制看-改-再看；Phase 3 的 skill 内置评分清单（栅格/对比/层级/一致性/可访问性） |
| 图标依赖外网 | 内置 SVG 集 + `createNodeFromSvg`，不依赖运行时抓取 |
