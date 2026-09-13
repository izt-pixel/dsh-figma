# DSH Figma Bridge

让 **DeepSeek Harness（DSH）** 直接读写 Figma 画布：在 DSH 里说"帮我把这个页面的间距统一成 8pt 栅格"，
模型真的去改图层，而不是吐一段代码让你手动拼。

分两块：

- **`packages/plugin`** —— 装进 Figma 的插件，跑在插件 main 沙箱里，有完整的 `figma` API。
- **`packages/bridge`** —— 本地 Node 进程。对外是 DSH 的一个 MCP server，对内是插件长轮询的 HTTP 端点。

```
DSH agent ──MCP/stdio──> bridge ──HTTP 长轮询──> Figma 插件 ──figma API──> 画布
                      127.0.0.1:8790
```

为什么是长轮询而不是 WebSocket：Figma 插件沙箱的全局对象里**只有** `figma`、`fetch`、`console`、
`setTimeout` 系列、`__html__`、`__uiFiles__` —— **没有 `WebSocket`**，插件也不能监听端口。
细节和取证见 [`docs/plan.md`](docs/plan.md)。

**公开文档（给用户和 Figma 评审看的那个网址）**：
<https://izt-pixel.github.io/dsh-figma/> —— 讲怎么装、怎么用、坏了怎么查；
隐私政策在 <https://izt-pixel.github.io/dsh-figma/PRIVACY.html>。

---

## 快速开始

> **只想用插件、不想读源码？** 直接看 [`docs/使用说明.md`](docs/使用说明.md)——
> 那篇讲的是怎么开机、面板每一行什么意思、坏了先看哪三处。本文件讲的是怎么把它搭起来。

### 0. 前置

- Node ≥ 22
- pnpm
- Figma 桌面版或网页版

### 1. 构建

```bash
pnpm install
pnpm build
```

构建产物：

| 路径 | 用途 |
|---|---|
| `packages/bridge/dist/mcp.js` | DSH 要启动的 MCP server |
| `packages/plugin/dist/code.js` | Figma 插件主线程代码（单文件经典脚本） |
| `packages/plugin/ui.html` | 插件状态面板 |

> 项目**不使用打包器**：`tsc` 直出。插件必须是"无 import/export 的经典脚本"，
> 因为 Figma 没有模块加载器；`packages/plugin/scripts/verify-bundle.mjs` 每次构建都会强制校验这一点。

### 2. 把插件装进 Figma

1. Figma 里打开任意设计文件
2. 菜单 `Plugins → Development → Import plugin from manifest…`
3. 选择 `packages/plugin/manifest.json`
4. 运行 `Plugins → Development → DSH Figma Bridge`

面板出现后应显示 `connected`。如果显示 `offline`，说明桥还没起来（先做第 3 步）。

### 改代码之后怎么重载插件

| 改了什么 | 要做什么 |
|---|---|
| `packages/plugin/src/*`（即 `dist/code.js`） | **关闭插件再重新运行即可**，不需要重新导入；用面板右上角的 build id 确认 |
| `manifest.json`（权限、`networkAccess`、`main`/`ui` 路径） | 需要 `Import plugin from manifest…` 重新导入 |
| 只改了桥（`packages/bridge/*`，含 `tools.ts` 的工具增删） | **结束桥进程**即可，不用重启 DSH —— 见下 |
| profile 补丁（`cordis.patch.yml`） | 必须重启 DSH |

Figma 的开发插件每次运行都会从磁盘重读 `main`/`ui`——这正是开发流程的设计。

**改了桥为什么只要结束进程？** DSH 的 MCP client 只在**连接时**取一次工具列表，之后再改 `tools.ts`
不会生效（新工具调不到，报 `unknown tool`）。但它对"本地服务器进程崩溃"有**自动重连并刷新工具集**
的行为，而重连就是重新执行 `node …/dist/mcp.js`——也就是磁盘上最新那份。所以：

```powershell
Get-Process node | Stop-Process -Force    # DSH 会在退避内重新拉起新版桥
```

比重启 DSH 快得多。桥是无状态的（客户端注册表会由插件重新 poll 自动重建，退避 ≤10s）。

**怎么确认 Figma 里跑的确实是你刚构建的那份？** 看面板右上角的 **build id**：

```
v0.1.0 · p1 · 2cf7f0d2
                  ^^^^^^^^ 每次构建都会变（源码的哈希）
```

（上面这个 `2cf7f0d2` 是当前 `dist/code.js` 里真实的 id，不要把它当固定值读——
它跟着源码走。哪天它和面板显示的不一致，就说明两边不是同一份产物。）

之前只有版本号和命令列表可看，而这两者在"只改内部逻辑、不加工具"的构建之间**完全一样**——
等于没有任何办法判断插件是否已更新。build id 补上了这个缺口，它也出现在
`/figma/health` 和 `status` 的返回里。相同源码重建会得到相同的 id（无改动就是无改动），
重复 stamp 会被拒绝。

> **`networkAccess` 只能用 `localhost`，不能写 `127.0.0.1`。**
> Figma 的 manifest 校验器会把 IPv4 字面量判为非法 URL，导入或发布时报
> `Invalid value for allowedDomains. 'http://127.0.0.1:8790' must be a valid URL.`
> 因此插件唯一被允许的 origin 是 `http://localhost:8790`，桥也相应地同时绑定
> `127.0.0.1` 与 `::1` 两个回环地址（因为 `localhost` 在不同机器上解析结果不同）。
>
> **连带约束**：端口写死在 `allowedDomains` 里。改端口必须同步改 manifest，
> 否则 Figma 会按 CSP 拦掉请求——CSP 报错在插件开发者控制台里才能看到。

### 3. 接入 DSH

编辑你的 DSH profile 补丁层 —— 本机是
`C:\Users\izhao\.dsh\profiles\desktop\cordis.patch.yml`：

```yaml
# 新增插件必须包在 `insert:` 里。裸写 `- id: xxx` 会被当成"覆盖一个已存在的
# 条目"，而它并不存在，于是被静默跳过（日志：patch: entry "xxx" not found）。
- insert:
    - id: mcp-figma
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: figma
        transport: stdio
        command: node
        args: ['D:\个人文档\figma\packages\bridge\dist\mcp.js']
        env:
          FIGMA_BRIDGE_PORT: '8790'
        # 截图和批量节点操作会超过 60s 默认值
        toolCallTimeoutMs: 120000
```

**改完先离线自检，不用重启**——`dsh` CLI 与应用启动共用同一份补丁语义：

```bash
node "D:\DeepSeekharness\dsh\DSH Desktop\resources\app.asar.unpacked\node_modules\@deepseek-ai\dsh\lib\bin.js" \
  --profile desktop --dump-config
```

它会把合成后的配置树打出来。看到 `- id: mcp-figma` 且**没有** `patch: entry ... not found` 警告，
才算补丁生效。这一步能省掉大量"改一次重启一次"的往返。

然后**重启 DSH Desktop**（这个补丁在应用启动时读取，不热加载）。重启后模型会多出六个工具
（清单见文末「工具」一节），先确认最基础的两个连得上：

- `mcp__figma__status` —— 链路状态、文件、页面、当前选区
- `mcp__figma__ping` —— 往返测延迟

想断开就把这个 `- id: mcp-figma` 条目删掉。

> 若 `node` 不在 DSH 的 PATH 上，把 `command` 换成绝对路径，例如
> `C:\Program Files\nodejs\node.exe`。

### 3b. 不重启 DSH 也想验证 Figma 那一侧？

桥可以脱离 DSH 单独跑 HTTP 模式：

```bash
pnpm serve:standalone        # 等价于 node packages/bridge/dist/mcp.js --standalone
```

这个模式不接 MCP、不碰 stdin，只提供插件要长轮询的 HTTP 端点。
适合先确认"插件 ↔ 桥"这一段通了（面板应显示 `connected`），再重启 DSH 让桥由 DSH 托管。
注意它和 DSH 自己启动的桥**抢同一个端口**：要重启 DSH 时先把 standalone 的桥停掉。

---

## 排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 面板 `Offline`，`/figma/health` 也连不上 | 桥没在跑。DSH 的 profile 补丁只在**应用启动时**读取，改完必须重启 DSH | 重启 DSH Desktop；或临时用 `pnpm serve:standalone` |
| 面板 `Offline`，但 `/figma/health` 正常 | 端口不一致，或 manifest 的 `allowedDomains` 与端口不匹配（被 CSP 拦掉，只在插件开发者控制台可见） | 对齐插件面板端口、`FIGMA_BRIDGE_PORT`、`manifest.json` 三处 |
| 面板错误显示 `[object Object]` | 旧版插件产物。Figma 沙箱的 `fetch` 抛的是普通对象而非 `Error` | 重新构建并重新运行插件（`pnpm build` 后重跑插件即可加载新 `code.js`） |
| 重启 DSH 后模型仍没有 `mcp__figma__*` 工具 | 补丁被跳过。常见原因：新增插件没包在 `insert:` 里，DSH 会把它当"覆盖不存在的条目"并静默跳过 | 跑一次 `--dump-config` 自检（见第 3 步）；日志里搜 `patch: entry` —— 出现即说明补丁没应用 |
| 日志出现 `patch: entry "mcp-figma" not found` | 同上：裸 `- id:` 形式是覆盖语义，不是新增 | 用 `- insert:` 包裹后重跑 `--dump-config` 确认警告消失 |

---

## 验证

```bash
# 全部自动检查：60 项协议冒烟 + 45 项序列化单测 + 125 项写入单测
pnpm test

# 分开跑
pnpm smoke              # 桥的协议层（用假插件替代 Figma 驱动完整协议）
pnpm test:serializer    # 插件的序列化器（vm + 桩 figma，直接调用内部函数）
pnpm test:apply         # 插件的写执行器（记录型桩，断言真正写进节点的值）
pnpm verify:plugin      # 插件产物必须是纯经典脚本，且 ui.html 存在

# 手动看诊断（需要桥在跑）
curl http://localhost:8790/figma/health
```

`/figma/health` 会列出已连接的插件实例、绑定的地址，以及它报回的**文件名/页面/选区**——
一眼就能分清"桥没起来"、"桥起来了但插件没连"、"都连上了"三种状态。

### 为什么序列化器能测

插件的 `dist/code.js` 必须是**无导出的经典脚本**（Figma 没有模块加载器），所以里面的函数无法 import。
但经典脚本的顶层 `function` 声明会成为全局属性——`test-serializer.mjs` 因此用 `vm` 在带桩 `figma`
的环境里求值整个 bundle，然后直接调用 `serializeNode` / `describeCommand`。

这段代码是**最容易对模型撒谎**的地方：`describe` 说某个属性不存在、而它其实存在时，模型会跳过它，
下一次写入就是静默的数据丢失。所以它值得有独立测试，而不是只能靠人在 Figma 里点。

`pnpm build` 会依次跑 `tsc` → 产物校验 → 序列化测试，任一失败即构建失败。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `FIGMA_BRIDGE_PORT` | `8790` | HTTP 端口。改动后**插件面板里的端口和 `manifest.json` 的 `allowedDomains` 都要一起改** |
| `FIGMA_BRIDGE_HOST` | `127.0.0.1` | 主绑定地址；桥会自动附带绑定另一族回环（`::1`），两族都只在本机。<br>**不要改成 `0.0.0.0`** —— 那等于把画布控制权交给整个局域网 |
| `FIGMA_BRIDGE_TIMEOUT_MS` | `120000` | 单条命令预算 |
| `FIGMA_BRIDGE_LOG` | `info` | `debug` / `info` / `warn` / `error`。日志一律走 stderr（stdout 是 MCP 通道） |

---

## 目录

```
packages/protocol/     线协议：类型、校验函数、常量（唯一真源）
packages/bridge/       本地桥：MCP server + HTTP 端点 + 命令队列
  src/mcp.ts           入口：MCP 接线、绑端口重试、关闭钩子
  src/bridge.ts        HTTP 服务、客户端注册表、超时与断连收敛
  src/tools.ts         面向模型的工具描述（提示词的一部分，不是文档）
  src/render.ts        工具结果 → MCP content（含图像路径，单独可测）
  scripts/smoke.mjs    端到端冒烟检查
packages/plugin/       Figma 插件
  src/code.ts          网络循环 + 命令 handler 注册表 + 节点序列化/base64
  src/protocol-types.d.ts  把协议类型提升为全局类型，让 code.ts 保持零 import
  ui.html              状态面板（纯展示，不参与网络）
  scripts/stamp-build.mjs     把源码哈希写进产物的 build id
  scripts/verify-bundle.mjs   保证产物是无 import/export 的经典脚本
  scripts/test-serializer.mjs vm + 桩 figma，直接测内部序列化函数
docs/plan.md           架构取证的规划文档
docs/使用说明.md        使用者视角：装机、读面板、重载、排障（面向用插件的人）
PRIVACY.md             隐私政策：插件只访问 localhost，作者不接收任何数据
```

---

## 工具

模型看到的名字带 `mcp__figma__` 前缀（DSH 的 MCP 命名空间）。

| 工具 | 作用 |
|---|---|
| `status` | 链路状态、文件、页面、当前选区、本插件支持的命令清单。任何 Figma 操作失败时先调它 |
| `ping` | 往返测延迟，不碰文档；用来区分"链路慢"和"Figma 慢" |
| `describe` | 结构化读画布：深度受限的节点树，含坐标尺寸、auto-layout、fills、文本、**变量绑定**。带 `depth`/`limit`/`fields` 三重封顶，截断时明说 |
| `screenshot` | 导出 PNG **作为图片进入模型上下文**——这是模型唯一能"看见"自己改动结果的途径 |
| `apply` | 批量写画布：create / update / move / rename / delete。**一次调用 = 一个 undo 步**；create 可内联 `children` 一次搭出整棵树，并可用 `ref` 让后续操作引用它 |
| `tokens` | 设计变量：`list` 读集合与变量、`audit` 找出手写色值并指出「哪个变量已经恰好等于这个值」、`bind` 绑定、`create` 新建、`delete` 删除（仍被绑定的变量会拒绝删除并告知用在哪） |

`describe` 说的是文档**声称**的样子，`screenshot` 展示的是用户**实际看到**的样子。
两者之间的落差就是设计 bug 的藏身处，所以改完一定要截图，而不是只看 JSON。

### 图像约束

- 每张图默认调 2x，像素预算 1.6M（超出自动降 scale，并在图注里报出实际值），单次最多 4 张
- 每个导出失败的节点会**逐个列出原因**——静默丢图对模型来说和"画布是空的"长得一样
- 插件沙箱没有 `btoa`/`TextEncoder`，base64 是手写的（`src/code.ts`）

---

## 现状

已实现 `status` / `ping` / `describe` / `screenshot` / `apply` / `tokens`。
后续按 [`docs/plan.md`](docs/plan.md) 推进：`components`（系统化）→ `script`（逃生舱）→ 发布。

使用者视角的操作说明（装机、读面板、排障）见 [`docs/使用说明.md`](docs/使用说明.md)；
数据去向见 [`PRIVACY.md`](PRIVACY.md)。

> **与规划的一处偏离**：规划里 `text` 是独立工具（理由是"字体是最大的坑"），实现时**并入 `apply`**。
> 理由：`apply` 本来就必须处理 TEXT 节点，独立工具会让同一件事有两种写法、并长期占两份 schema token。
> 字体风险在 `apply` 内部处理——`loadFontAsync` + fallback 链（Inter → Noto Sans SC → Arial），
> 且**每次替换都写进结果的 notes**，不会静默换字体。

> **改完 profile 补丁必须重启 DSH。** 实测 `patchReload: "live"` 不会重载补丁里的 host 插件
> ——改完等 30s，MCP server 进程连 pid 都不变。改配置前先用 `--dump-config` 离线自检。
