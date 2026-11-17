# 审计指南：从哪开始，查什么

---

## 零、先跑一遍

审代码之前先确认它现在是绿的。红的套件会让你分不清是自己看错了还是它本来就坏。

```bash
# Rust：167 个单元测试，不需要网络
cd src-tauri && cargo test

# 类型与构建
npx vue-tsc --noEmit
pnpm build

# 纯逻辑验证（不需要应用在跑）
node scripts/verify-bgm-parse.mjs
node scripts/verify-bgm-match.mjs
node scripts/verify-library-query.mjs
node scripts/verify-source-engine.mjs
node scripts/verify-source-schema.mjs
node scripts/verify-source-selector.mjs
node scripts/verify-source-aggregate.mjs
node scripts/verify-xpath-selector.mjs
node scripts/verify-video-engine.mjs
node scripts/verify-importable-sources.mjs
node scripts/verify-txt-chapters.mjs
node scripts/verify-zip.mjs
node scripts/verify-export-convert.mjs
node scripts/verify-epub-package.mjs
node scripts/verify-epub-e2e.mjs

# 界面验证：需要应用带调试端口启动
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
src-tauri\target\debug\litearti.exe

node scripts/verify-ui-library.mjs
node scripts/verify-library-online.mjs
node scripts/verify-ui-sources-v2.mjs
node scripts/verify-ui-discover.mjs
node scripts/verify-mirror-cover.mjs
node scripts/verify-sniff.mjs
node scripts/verify-stream-proxy.mjs
node scripts/verify-stream-playback.mjs
```

**要网络的部分**：`verify-ui-discover`、`verify-mirror-cover`、`verify-stream-playback`、`verify-bgm-parse`（不，这个离线，用的是 fixture）。

---

## 一、不变量清单

这些是可以**机械检查**的。每一条被破坏都对应一个已知 bug 或安全漏洞。

### 1.1 边界

| 检查 | 命令 | 期望 |
|---|---|---|
| 前端没有直接 `fetch` | 搜 `fetch(` in `src/` | **0 处** |
| Tauri 只在适配层 | 搜 `from '@tauri-apps` in `src/` | **恰好 4 个文件**：`api/library.ts`、`discover/api.ts`、`export/pickDirectory.ts`、`sources/mirror.ts` |
| 视图不 import Tauri | 上面结果里不应有 `views/` 或 `components/` | 0 |
| scheme handler 检查 label | `proto.rs` 的 `handle` 开头 | 必须有 `webview_label() != "main"` 拒绝分支 |

### 1.2 安全

| 检查 | 位置 | 期望 |
|---|---|---|
| cookie 不进 URL | `proto.rs` 的 `build_request` | 只解析 `s=`（sourceId），没有 cookie 参数 |
| cookie 不外泄 | `credentials.rs` | 没有任何 `#[tauri::command]` 返回 cookie 值 |
| JS 沙箱无 `allow-same-origin` | `sandbox.ts` | `sandbox="allow-scripts"` 且**不含** `allow-same-origin` |
| 镜像不允许传 URL | `rules_mirror.rs` | `Mirror` 是 enum，不接受任意字符串 base |
| 规则名校验 | `rules_mirror.rs::is_safe_rule_name` | 拒绝 `..`、`/`、`?`、`#`、`.` 开头 |
| 封面只接受 http(s) | `bangumi.rs::cover` | `file:` 必须报错 |
| 流代理只允许 http(s) | `stream.rs::ensure_web_url` | 初始 + 每次重定向都校验 |

### 1.3 数据兼容

| 检查 | 位置 | 期望 |
|---|---|---|
| `Entry` 新字段有默认值 | `model.rs` | 所有后加字段带 `#[serde(default)]` |
| 旧 `library.json` 能加载 | 手工：删掉 `kind` / `reference` 字段后读取 | 不报错，`kind` 默认 `file` |
| 偏好逐字段校验 | `viewPrefs.ts` / `readingPrefs.ts` | 一个字段坏了不影响其他字段 |

### 1.4 播放

| 检查 | 位置 | 期望 |
|---|---|---|
| 原生 HLS 判定 | `AnimePlayerView.vue` | `canPlayType(...) === 'probably'`，**不能是** `!== ''` |
| stream origin 分平台 | `sources/stream.ts::streamOrigin` | Windows 用 `http://kazumi-stream.localhost` |
| `Content-Range` 在暴露头里 | `proto.rs` | `Access-Control-Expose-Headers` 含 `Content-Range`，否则拖动进度条失效 |
| 播放器主动 `play()` | `AnimePlayerView.vue` | `MANIFEST_PARSED` / `loadedmetadata` 时调 `play()`，否则 `currentTime` 卡 0 |

### 1.5 嗅探

| 检查 | 位置 | 期望 |
|---|---|---|
| 判断层无平台依赖 | `sniff/pick.rs` | 不 import `tauri` / `windows` |
| 采集层不进测试二进制 | `sniff/mod.rs` | `#[cfg(all(target_os = "windows", not(test)))]` |
| 嗅探窗口 label 不是 main | `sniff/windows.rs::new_window_label` | `sniff-<uuid>` |
| 窗口移出屏幕而非隐藏 | `sniff/windows.rs` | `visible(true)` + 负坐标 |
| 判断层不把 `.ts` 当候选 | `sniff/pick.rs::is_candidate` | 分片不算入口 |

### 1.6 匹配

| 检查 | 位置 | 期望 |
|---|---|---|
| 两个匹配策略没有混用 | `library/rematch.ts`（严格）vs `discover/match.ts`（模糊） | rematch 用 `sameTitle`，discover 用 `similarity` |
| 续作标记被剥离 | `discover/match.ts::stripContinuation` | `第X季` 剥，`剧场版/番外` **不剥** |
| 空 key 不匹配任何东西 | 两边 | `normalizeTitle('')` 得到的空串必须返回不匹配 |

---

## 二、已知弱点

按风险排序。这些**不是 bug，是已知的取舍**——但审计时值得关注。

### 2.1 高：`sniff/windows.rs` 没有单元测试

**状况**：CDP 采集层完全靠 `scripts/verify-sniff.mjs` 一个端到端脚本覆盖。

**为什么**：它的 COM 初始化会让 `cargo test` 的二进制在**加载期**就崩（`0xC0000139`），一个测试都跑不了。

**风险**：那个脚本坏了，采集层就是无测试状态。

**建议**：改采集层时手动跑 `verify-sniff.mjs`，并在真机上确认窗口能开、事件能到。

### 2.2 高：番剧进度有两份存储

**状况**：未加入资料库的临时观看写 `localStorage`，加入后 `Entry.progress` 才算真相。

**风险**：如果某条路径同时写两边，会出现"资料库说第 3 集，播放器说第 5 集"。

**审计**：搜 `savePlaybackProgress` 和 `setProgress` 的调用点，确认没有同时写。

### 2.3 中：`verify-ui-discover.mjs` 依赖外部服务

**状况**：它连真实的 `api.kazumi.fyi`。

**风险**：镜像挂了就红，看起来像代码坏了。

**判断**：先单独跑 `verify-mirror-cover.mjs`，如果它也红就是网络问题。

### 2.4 中：镜像不可控

**状况**：`api.kazumi.fyi` 是 Kazumi 项目的服务，GitCode 镜像会比上游滞后（实测少一条规则）。

**风险**：镜像下线 → 发现板块和规则浏览同时失效，且**没有回退方案**（直连 `api.bgm.tv` 在部分网络不通）。

### 2.5 中：`cargo test` 里没有真实 HTTP 测试

**状况**：`net.rs` 的超时分类测试驱动真实 socket，但其余网络模块的测试都是本地缓存/参数校验，不发请求。

**风险**：`bangumi.rs` / `rules_mirror.rs` 的真实请求路径只在 `verify-mirror-cover.mjs` 里验证。

### 2.6 低：`login.rs` 的 `unused_mut` 警告

既存，未清。不影响行为。

---

## 三、按功能找代码

| 想审 | 从这开始 |
|---|---|
| 资料库导入/删除/重命名 | `src-tauri/src/library.rs` → `src/stores/library.ts` → `src/views/LibraryView.vue` |
| 筛选排序 | `src/library/query.ts`（纯函数，可直接测） |
| 源解析 | `src/sources/schema.ts` → `selector.ts` → `engine.ts` |
| JS 沙箱 | `src/sources/sandbox.ts` |
| 源网络 | `src-tauri/src/net.rs` |
| 番剧播放 | `src/views/AnimePlayerView.vue` → `src/sources/stream.ts` → `proto.rs` → `stream.rs` |
| 嗅探 | `src-tauri/src/sniff/pick.rs`（先看这个，纯函数）→ `windows.rs` |
| 发现 | `src/views/DiscoverView.vue` → `src/discover/subject.ts` → `src-tauri/src/bangumi.rs` |
| 规则镜像 | `src/sources/mirror.ts` → `src-tauri/src/rules_mirror.rs` |
| 查看器契约 | `src/types/viewer.ts` + `docs/viewer-contract.md` |
| 视觉系统 | `src/styles/tokens.css` + `docs/design-system.md` |

---

## 四、审代码时的提问顺序

对每个不熟悉的实现，依次问：

1. **它违反了哪条边界吗？**（见 §1）—— 如果是，先确认是不是刻意的
2. **`03-decisions.md` 里有记录吗？**—— 有记录说明想过了；没记录说明可能是随手写的
3. **它被测试覆盖了吗？**—— 有测试说明有人验证过行为；没有就小心
4. **它的错误路径说什么？**—— 错误信息应该指向真正的原因。`No such file or directory (os error 2)` 给中文用户没用
5. **它写了什么不该写的数据？**—— 尤其是 cookie、用户文件、进度

---

## 五、什么算"审完了"

不是"每行都看过"。是这五件事有了答案：

- [ ] 三条硬边界（网络/Rust、Tauri/适配层、无组件库）现在成立吗？
- [ ] 安全清单（§1.2）全过吗？
- [ ] 新加的代码有测试吗？测试是跑真实代码还是复制了一份逻辑？
- [ ] 有决定没有记录在 `03-decisions.md` 里吗？（有的话补上，这是审计最有价值的产出）
- [ ] 已知弱点（§2）里有哪条恶化了？

**最后一条最重要**：这个项目的文档价值在于记下了"为什么"，而代价是它会过期。审计的产出如果不是修好代码，那至少应该是让这份地图重新变准。
