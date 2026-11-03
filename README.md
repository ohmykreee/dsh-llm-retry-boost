# dsh-llm-retry-boost

给 DeepSeek Harness 的模型请求加一层「**临时故障无限重试 + 封顶退避**」，同时让**配置类错误继续走内置重试逻辑**（默认 5 次、且只对可重试错误生效）。

它是一个 Host 插件包（bundle），以 Loader 行 `llm-retry-boost` 挂载在 profile 里；配置页是它的浏览器半身（`client.js`），注册到 Plugins 页面的 `plugins.row.config` 槽位。运行时依赖只有宿主自带的 `@deepseek-ai/schemastery`（peer，不随包安装）和页面里的 React。

---

## 1. 它解决什么问题

`@deepseek-ai/dsh-llm-retry`（内置执行器）按每个 provider 的 `retryPolicy` 决定是否重试。默认是 **normal 模式**：

| | 内置 normal（默认） | 内置 always | 本插件（默认配置） |
|---|---|---|---|
| 可重试错误的**次数** | 5 次 | 无限 | **无限** |
| 可重试错误的**等待** | 500ms 起×2，10s 封顶 | 同 normal 的退避字段 | **1s 起×2，60s 封顶**（可配） |
| 判断依据 | 错误码白名单 | 不判断，全部重试 | **白名单**（同内置的 5 类 + HTTP 状态） |
| 配置类错误（key 错、模型名错、请求非法、额度耗尽…） | 不重试，直接报错 | **也会无限重试** ← 危险 | **交回内置逻辑**（默认即不重试，直接报错） |

所以：

- 用 `retryPolicy.mode: always` 能做到无限重试，但它把「认证失败 / 请求非法 / 额度耗尽」也一起无限重试了——界面永远转圈、错误永远不冒出来、请求一直在烧。
- 本插件只替换**预算**，不替换**分类**：`SERVER`（engine overloaded）、`RATE_LIMIT`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE` 无限退避重试；其余错误原样交给内置执行器。

---

## 2. 行为细节

### 2.1 重试判定

一个失败是否进入无限重试，只看 `LlmFailure.code` / `LlmFailure.status`：

- 错误码命中 `retryableCodes`（默认 `EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT`）；
- 或错误码形如 `HTTP_503` 且状态命中 `retryableHttpStatuses`（默认 `408, 425, 429, 500, 502, 503, 504`）；
- 或 `failure.status` 命中同一状态表（兜底给没映射到语义码的适配器）。

命中 → 本插件负责重试；未命中 → **原样 `next()`**，交给内置 `llm-retry` 执行器，行为与没装本插件时**完全一致**。

`ABORTED` 与已 abort 的 turn 永远不重试。

### 2.2 等待时间

```
delay(n) = min(initialDelayMs × 2^(n-1) × jitter, maxDelayMs)
```

- `n` 是当前 retry 链里的第几次（从 1 开始），每次失败递增；
- `jitter` 在 `[1-jitterRatio, 1+jitterRatio]` 内均匀取值；
- provider 返回的 `Retry-After` 优先，但同样被 `maxDelayMs` 封顶；
- 到达 `maxDelayMs` 后保持该值继续重试（这就是「直到达到时间增加上限」）。

默认曲线：1s → 2s → 4s → 8s → 16s → 32s → 60s → 60s → …（永久）。

### 2.3 日志与事件

- 每次调度都会在会话日志写入内置的 `llm/retry` 事件（`mode: always`，或有限次时 `normal` + `maxRetries`），等待结束后写 `llm/retry-started`——和内置执行器的记录方式一致，重启/回放都能看懂当时发生了什么。
- 每次重试还会在宿主日志打一行 warn：`llm-retry-boost: deepseek-account SERVER (turn 3, step 1) — attempt #4 in 8000ms`。

### 2.4 边界

- **重试计数在内存里**，按 `(session, provider)` 记链，遇到 `step/start` / `turn/end` 归零（与内置 projection 的规则一致）。重启进程只会让退避曲线从 1s 重新开始，不会破坏日志。
- **取消即停**：turn 被取消（Esc / abort）时退避计时器立刻结束，中止当前重试，不再发请求。
- **插件卸载即停**：`apply` 的 cleanup 会 abort 生命周期信号并移除监听。
- **只覆盖 agent turn 内的请求**：直接调用 `ctx.llm.stream()` 的消费者本来就不重试（内置执行器也只挂在 `agent/request-error` 上）。
- 本插件**不修改** provider 的 `retryPolicy`，也**不替换**内置 `llm-retry` 行。若你把某个 provider 的 `retryPolicy` 设成 `always`，配置类错误在 `next()` 之后仍会被内置执行器无限重试——保持默认 `normal` 即可避免。

---

## 3. 配置

### 3.1 在插件页面里改（推荐）

侧边栏 **插件** → 已安装的 **LLM 无限重试（封顶退避）** → 这一行上的 **配置**，打开的就是这个插件的配置页。页面上直接改：

- **重试预算**：`maxRetries`（`0` = 一直重试，直到服务恢复）
- **等待曲线**：`initialDelayMs`（首次等待）、`maxDelayMs`（等待上限）、`jitterRatio`（抖动）
- **其他行为**：`respectRetryAfter`、`configErrorBehavior`、`logRetries`、`enabled`

每个字段都带一句说明和生效范围；被 profile 覆盖过的字段会显示「已覆盖」和「恢复默认」。改完点 **保存**，值会写进当前 profile 的配置并立即生效，**不需要重启**——插件在每次失败时读取当前值，而不是在启动时快照一次。

白名单（`retryableCodes` / `retryableHttpStatuses`）**故意不放进表单**：它们决定的是「哪些失败归本插件管」，改动应该走下面 3.2 的 YAML，和它所在的 patch 一起被 review。

### 3.2 写在 Loader 行上

完整配置（默认值见 `cordis.patch.yml`）：

```yaml
- insert:
    - id: llm-retry-boost
      name: dsh-llm-retry-boost
      config:
        enabled: true
        retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
        retryableHttpStatuses: [408, 425, 429, 500, 502, 503, 504]
        maxRetries: 0
        initialDelayMs: 1000
        maxDelayMs: 60000
        jitterRatio: 0.1
        respectRetryAfter: true
        configErrorBehavior: delegate
        logRetries: true
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后监听还在，但每个失败都原样交给内置执行器——所以可以在插件页面里随时再打开，不用重装。 |
| `retryableCodes` | 内置 5 类 | 进入无限重试的失败码白名单。想连 `TRANSPORT` 都不无限重试（比如 baseURL 写错时快速失败），把它从列表里删掉。 |
| `retryableHttpStatuses` | `408,425,429,500,502,503,504` | 匹配 `HTTP_<status>` 或 `failure.status`。 |
| `maxRetries` | `0` | `0` = 无限；`>0` = 最多重试这么多次，用完就按失败结束当前 step（**不会**再叠加内置的 5 次）。 |
| `initialDelayMs` | `1000` | 首次等待；每次 ×2。最小 100。 |
| `maxDelayMs` | `60000` | 等待上限，也是 `Retry-After` 的上限。 |
| `jitterRatio` | `0.1` | 抖动比例，`0` 关闭。 |
| `respectRetryAfter` | `true` | 是否采用 provider 的 `Retry-After`。 |
| `configErrorBehavior` | `delegate` | `delegate`：非白名单错误原样交给内置执行器（配置错误 = 立即报错，与官方默认一致）。`bounded`：非白名单错误也重试，但**沿用内置的有限预算与退避**（`maxRetries`、`initialDelayMs`、`maxDelayMs` 取自 provider 的 `retryPolicy`，缺省 5 次 / 500ms→10s）。 |
| `logRetries` | `true` | 每次重试打一行 warn。 |

> 未知字段会**直接报错**（loader 行加载失败并给出字段名），避免 YAML 拼错后静默使用默认值。

改完 `cordis.patch.yml` 后由 Loader 热重载（或重启 profile）生效；插件页面保存的则是同一份 profile patch，所以两种改法看到的是同一份配置。

---

## 4. 安装

通过 DSH 的 Plugin Manager（设置 → 插件 → 添加插件 → 填本目录的绝对路径），等价于：

```
plugin_manager action: install_bundle target: "C:\\...\\dsh-llm-retry-boost"
```

安装后 profile 的 `package.json` 会多出 `dsh-llm-retry-boost` 依赖与 bundle 条目，`node_modules` 里是一个指向本目录的 link——所以改代码后重启 DSH 就会用新文件。

浏览器半身在 `package.json` 的 `dsh.client` 里声明，页面启动时由 `dsh-client-modules` 扫描进模块表。**从没有 `client.js` 的旧版升上来时，插件行已经加载、但页面还没扫描过新的客户端清单**：重启 DSH，或关掉再打开插件行之后刷新一次页面，配置页才会出现（之后改 `client.js` 由 client HMR 负责）。

---

## 5. 测试

```powershell
npm test
# 等价于
node test/policy.test.mjs
node test/client.test.mjs
```

`test/policy.test.mjs` 用一个小型的 Cordis waterfall（`prepend` 顺序、`next()` 链、`session/event` feed）驱动真实的 `apply()`，断言：退避曲线与封顶、抖动区间、`Retry-After` 封顶、`step/start` 归零、配置错误委派、`bounded` 沿用内置预算与退避、有限 `maxRetries` 的终止、abort 不重试、卸载清理、「本插件先于内置执行器拿到失败」，以及 `.volatile()` 引用被读穿、改值后下一次失败立即按新值决策。

`test/client.test.mjs` 用一个极小的 React 替身驱动浏览器半身（`window.__ModuleLoader__` 工厂 + 组件函数），断言：注册的槽位与 key、字典、字段与默认值、只读/加载/不可用状态、保存时产生的精确 `set`/`unset` 操作、以及逐字段的非法值拦截。

另外验证过的（本机）：

- 把行在 Plugin Manager 里关掉再打开后，`Config.listConfigs` 的 `status` 从 `absent` 变成 `schema`，投影出的 JSON Schema 里八个可编辑字段带 `x-cordis.volatile: true`，两个白名单没有——说明宿主加载了 `Config`，Settings 会把它们投影成表单。
- 通过 profile 的 junction 路径（`--preserve-symlinks`）直接加载 `lib/index.js`，`Config(...)` 校验、默认值、`resolveSettings` 读穿引用都正常。

---

## 6. 已知限制

- 无限重试意味着**期间该 turn 不会失败**：只有成功、用户取消、或卸载插件才会结束。这是本插件的目的，不想要就设 `maxRetries`。
- 每次重试都是一次真实计费请求。
- 退避计数不跨进程持久化（日志里有完整历史，但计数会从 1s 重新开始）。
- provider 显式配置 `retryPolicy: always` 时，`delegate` 分支仍会被内置执行器无限重试（见 2.4）。

---

## 7. 许可

[MIT](LICENSE)，Copyright (c) 2026 ohmykreee。
