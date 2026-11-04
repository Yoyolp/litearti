# 登录凭证（Cookie）：现状与后续

> **状态：搁置（2026-11-02）。**
>
> 代码已经写完并通过单元测试与界面验证，但**端到端链路没有验证过**——真实的「登录 → 读到正文」需要一个人扫码/输手机号，只能手动做。界面默认不暴露任何登录入口：只有书源 JSON 里声明了 `auth` 才会出现，而仓库里没有这样的书源。
>
> 也就是说：**这是个半成品，但是个不会碍事的半成品。** 不影响现有任何功能。

本文记录三件事，供后续接手：

1. 保留了什么（代码与验证状态）
2. 删除了什么（以及为什么）
3. 还剩什么没做（含唯一一个未验证的 bug 和复现方法）

---

## 一、一句话现状

需要登录的网站之前不能当书源用。为此实现了：书源声明 `auth` → 界面出现「登录」→ 应用内弹窗打开站点登录页 → 关闭时抓取 Cookie → 之后该源的所有请求自动带 Cookie（仅限声明的 host）。

**抓取本身已经跑通**（日志里能看到抓到 3–4 个 Cookie），**但收尾逻辑有一个未验证的修复**，见[第六节](#六未完成的-bug最重要)。所以没有对外宣称可用。

---

## 二、保留了什么

### 2.1 新增文件

| 文件 | 行数 | 作用 |
|---|---|---|
| `src-tauri/src/crypto.rs` | 110 | `seal`/`unseal`：凭证落盘的唯一出入口。**目前是空实现**（只加 `plain:` 前缀），接口留好 |
| `src-tauri/src/credentials.rs` | 291 | 凭证存储：按 sourceId 存、按 host 精确匹配、`status` 只返回元数据 |
| `src-tauri/src/login.rs` | 380 | 登录窗口 + WebView2 Cookie 抓取（Windows 专属） |
| `scripts/verify-ui-credentials.mjs` | 277 | 打包应用上的 18 项验证 |

### 2.2 修改的文件

| 文件 | 改了什么 |
|---|---|
| `src-tauri/src/lib.rs` | 注册 3 个模块、3 个命令；`source_fetch` 改为接收 `AppHandle` 并解析凭证 |
| `src-tauri/src/net.rs` | `fetch(request, cookie)` 多一个参数；`SourceRequest` 增加 `source_id`；新增 2 条白名单测试 |
| `src-tauri/src/sources.rs` | `read_json`/`write_json` 提升为 `pub(crate)`，供凭证复用 |
| `src-tauri/Cargo.toml` | Windows 专属依赖：`webview2-com`、`windows-core` |
| `src/sources/schema.ts` | 新增 `AuthConfig` 与校验规则 |
| `src/sources/engine.ts` | 请求带上 `sourceId`；401/403 且声明了 `auth` 时给出「需要登录」提示 |
| `src/api/library.ts` | `sourceId` 字段 + 4 个新函数（登录、状态、清除、事件订阅） |
| `src/stores/sources.ts` | 凭证状态、`startLogin`/`finishLogin`/`clearLogin` |
| `src/views/SourcesView.vue` | 登录按钮、状态点、结果提示 |
| `src/i18n/index.ts` | 8 条登录文案 |
| `scripts/verify-source-schema.mjs` | `auth` 块的 13 项测试 |

### 2.3 新增的命令与事件

| 名称 | 说明 |
|---|---|
| `source_login_start(sourceId)` | **async**（原因见 8.1），打开登录窗口后立即返回 |
| `credentials_status()` | 返回 `{ [sourceId]: { host, updatedAt, origin, hasCookie } }`，**不含 Cookie** |
| `credentials_clear(sourceId)` | 删除一条凭证 |
| 事件 `source-login-finished` | `{ sourceId, ok, message, cookieCount }` |

### 2.4 书源 JSON 新字段

```jsonc
"auth": {
  "type": "cookie",                        // 必填，目前只有这一种
  "loginUrl": "https://site.com/",         // 可选，默认 homepage
  "host": "site.com"                       // 可选，默认 loginUrl 的 host
}
```

**凭证本身绝不写进书源文件**——书源是可分享、可导出的，Cookie 不是。

---

## 三、删除了什么

| 删掉的 | 原因 |
|---|---|
| `scripts/_probe-login.mjs` | 临时探针（诊断抓取用），一次性 |
| `login.rs` 里的 `eprintln!` 调试日志 | 用完即删，正式代码不留输出 |
| `%APPDATA%/app.litearti.reader/sources/credentials.json` | 测试期间写入的空凭证文件（`entries: {}`） |
| `sources.json` 里的测试书源 | 探针把文件覆盖成了 `[]`，已恢复为只有 `bqg5555` |
| `scripts/_diag-*.mjs`、`scripts/_probe-js-in-element.mjs` 等 | 更早几轮的一次性诊断脚本 |

### 没有创建 `sources/fanqienovel.json`

番茄小说没有做成书源，原因见第五节。**这不是遗漏，是判断。**

---

## 四、验证状态

### 已验证（在当前二进制上重跑过）

| 项 | 结果 |
|---|---|
| `cargo test` | ✅ 89 项通过（原 63 + 新增 26） |
| `scripts/verify-ui-credentials.mjs` | ✅ 18 项通过（打包应用） |
| 9 套离线脚本 | ✅ 全通过 |
| `vue-tsc --noEmit` | ✅ 通过 |
| `tauri build` | ✅ 通过 |

其中凭证 UI 验证覆盖了最要紧的一条：**`credentials_status` 的返回里不存在 Cookie 明文**（断言序列化结果不含测试值、且没有 `cookie` 字段）。

### 未验证

| 项 | 为什么没验 |
|---|---|
| 真实登录后能读到正文 | 需要扫码/手机号，只能人工 |
| 抓取的 Cookie 真能通过站点鉴权 | 同上 |
| 修复 ③ 是否生效 | 见第六节 |

---

## 五、番茄小说为什么没做成书源

`https://fanqienovel.com/` 实测结论：

| 能力 | 结论 | 证据 |
|---|---|---|
| 搜索 | ❌ | `/search/<kw>` 返回 200 但只是 10 KB 的客户端壳，HTML 里没有任何 `/page/` 链接；`/api/author/search/search_book/v1` 返回空体，POST 返回 `{"code":-2,"message":"参数有误"}`，需要签名参数 |
| 详情/目录 | ✅ | `/page/<id>` 服务端渲染 196 KB，含 352 个 `/reader/` 链接，书名/作者/简介齐全 |
| 正文 | ❌ **字体反爬** | 章节区 258 字里有 **76 个 PUA 字符**（U+E000–U+F8FF），配随机命名的 woff2（`font-DNMrHsV173Pd4pgy`）。要看懂必须解析字体 cmap 反推字形映射 |
| 付费墙 | ❌ | 正文只给几百字预览，其余提示「会员登录后，可在网页畅读全文」 |
| 登录 | ✅ | JS 弹窗（`.muye-to-vip-login-btn`），没有独立路由 |

关键判断：**正文读不了不是登录问题，是字体反爬。** 就算登录成功，正文仍是 PUA。所以做个书源出来只会让人点进去看到一堆乱码——比没有更糟。

想支持这类站，需要的是引擎级新能力（字体解混淆），不是书源配置。那是另一个量级的工程，且每个站点一套映射，维护成本极高。

---

## 六、未完成的 bug（最重要）

### 现象

登录窗口被**页面自己**关掉时（站点弹窗里的关闭按钮，或 `window.close()`），worker 线程永不退出，抓到的 Cookie 不落盘，前端收不到 `source-login-finished`。

### 根因

1. JS 的 `window.close()` **不触发** `WindowEvent::CloseRequested`（只有用户点标题栏 × 才触发），所以 `should_close` 永远为 false。
2. 窗口对象仍留在 Tauri 的注册表里，`get_webview_window()` 继续返回 `Some`。
3. 但 webview 内容已经死了，每次 `GetCookies` 都返回 `0x8007139F`（`ERROR_INVALID_STATE`）。
4. 于是循环一直空转，`should_close` 和「窗口消失」两个退出条件都不成立。

### 已写的修复（**未验证**）

在 `src-tauri/src/login.rs` 的抓取循环里：连续 3 次抓取失败**且已经成功抓到过 Cookie**，就判定会话结束、跳出循环并落盘。

```rust
Err(error) => {
    consecutive_errors += 1;
    last_error = error.to_string();
    if consecutive_errors >= 3 && latest.is_some() {
        break;
    }
}
```

### 怎么验证这条修复

需要一个会自己关窗、或者能被程序关掉的页面。最省事的办法是复用之前的探针思路：

1. 造一个声明 `auth` 的临时书源（homepage 指向任意会设 Cookie 的站）
2. 调 `source_login_start`
3. 等窗口出现，用 CDP 连上它、执行 `window.close()`
4. 等 5–10 秒，看 `credentials_status` 是否出现该 sourceId
5. 看 `sources/credentials.json` 里是否真的写进去了

如果第 4、5 步仍为空，说明修复不生效，请优先检查：`consecutive_errors` 是否被 `Ok(_)`（空结果）重置掉——空结果也会走 `Ok` 分支。必要时可以改成「webview 可见性判断」或用 `IsVisible` COM 调用。

---

## 七、如何恢复开发

建议顺序：

1. **先验证 bug ③**（第六节），这是唯一卡住链路的东西。
2. 找一个**既能登录、正文又不是字体反爬**的站，做一个真书源。
3. 补文档：`docs/book-source-api.md` 里 `auth` 块目前没有正式条目；`docs/book-sources.md` 的「已知限制」需要一条。
4. 端到端人工验证：登录 → 搜索 → 读一章 → 重启应用仍有效。
5. 决定 `seal` 要不要上真加密（现在明文，见 8.4）。

**注意**：恢复开发时不要再把 `eprintln!` 留在代码里；诊断用临时探针脚本，跑完删掉。

---

## 八、设计要点（接手必读）

### 8.1 两个主线程死锁陷阱

**陷阱一：同步命令里建窗口。**
`source_login_start` 原本是同步 `fn`，Tauri 在主线程执行它，而建窗口内部要等同一个线程的事件循环 → 直接挂死，表现为前端按钮无响应、整个调不返回。
**必须 `async fn`。**

**陷阱二：在 `CloseRequested` 里抓 Cookie。**
`on_window_event` 跑在主线程；`with_webview` 把闭包投递到 webview 线程；COM 完成回调又需要主线程泵消息。在主线程里阻塞等回调 = 死锁。
**所以：事件回调只置一个 `AtomicBool`，抓取放到独立线程。**

### 8.2 为什么抓取改成了「存活期轮询」

第一版是「关闭时抓一次」，结果稳定拿到 `0x8007139F`：`prevent_close` 虽然把窗口留在了屏幕上，WebView2 却已经把 profile 拆了。
改成窗口存活期间每秒抓一次、记住最后一次成功的结果，关闭时直接落盘。副作用是好的：用户登录完立刻关窗也不会丢。

### 8.3 host 精确匹配

Cookie 只在请求 host **完全等于**凭证 host 时才注入（忽略大小写与末尾点，忽略端口）。

- 不给子域名继承：`cdn.example.com` 拿不到 `example.com` 的凭证
- 这比浏览器 cookie jar **更严格**，是刻意选择：窄规则不会把会话发给意外的主机

跨主机重定向的安全性由 `reqwest` 保证：`remove_sensitive_headers` 在 host/port/scheme 任一变化时移除 `Cookie`。**如果哪天把重定向策略改成 `allow_all`，这个保证就没了，必须在 `net.rs` 里自己实现。**

### 8.4 `seal` 的空实现

```rust
plain:     当前格式，明文
enc:v1:    预留，将来加密后使用
```

格式现在就是终态：将来 `seal` 改成产出 `enc:v1:`，旧数据仍是 `plain:`，不需要迁移。`unseal` 遇到 `enc:v1:` 会报「请升级应用」而不是静默解出乱码。

**这意味着 Cookie 目前是明文落盘的。** 任何能读你用户目录的程序都能拿到登录态。这是按「先留接口」的决定做的，不是疏忽。

### 8.5 前端永远拿不到 Cookie

IPC 上没有任何命令返回 Cookie 明文；`credentials_status` 只给 host/时间/是否有。渲染层即使被完全控制，也没有东西可偷。

---

## 九、安全边界与已知限制

| 项 | 状态 |
|---|---|
| Cookie 明文存储 | ⚠️ 已知，`seal` 留了接口 |
| 仅 Windows 能自动抓取 | 非 Windows 返回明确错误；凭证存储与注入本身跨平台 |
| 不支持子域名 | 一个源一个 host |
| 不自动续期 | 不解析 `Set-Cookie`；失效靠 401/403 提示重登 |
| 不支持 `Authorization` 等头 | 存储结构留了扩展位，未实现 |
| 单条 Cookie 上限 | 16 KB，超出报错而不是截断 |

---

## 十、文件索引

| 文件 | 看什么 |
|---|---|
| `src-tauri/src/crypto.rs` | seal/unseal 的约定 |
| `src-tauri/src/credentials.rs` | host 匹配规则、status 不含明文 |
| `src-tauri/src/login.rs` | 窗口创建、抓取循环、**未完成的退出条件** |
| `src-tauri/src/net.rs` | Cookie 注入位置与白名单 |
| `src/sources/schema.ts` | `auth` 校验 |
| `src/api/library.ts` | 4 个新函数 |
| `src/views/SourcesView.vue` | 登录 UI |
| `scripts/verify-ui-credentials.mjs` | 18 项验证，含「不泄露 Cookie」 |
