# 维护速查

> 一张表解决 90% 的日常问题。找不到就往下看文档索引。
>
> **前提**：先读 [`android.md`](android.md) 的第 3、4 节，那里是不看就会踩的坑。

---

## 我要做什么，看哪里

| 我要… | 去做 | 详细 |
|---|---|---|
| 出 Android 包 | `pwsh scripts/build-android.ps1 -Release` | [android.md §2](android.md) |
| 出桌面版 | `pnpm app:build` | README |
| 跑测试 | `cd src-tauri; cargo test --lib`（176 个） | — |
| 检查前端类型 | `pnpm build` | — |
| 加一个书源格式 | 改 `schema.ts` + `selector.ts` | [book-source-api.md](book-source-api.md) |
| 加一个查看器 | 实现 `ViewerHost`，注册到 `registry.ts` | [viewer-contract.md](viewer-contract.md) |
| 加一个导出格式 | 注册 descriptor | [export.md](export.md) |
| 改视觉样式 | **只改 `tokens.css`**，组件里不许写死数值 | [design-system.md](design-system.md) |
| 查某个设计为什么这样 | — | [project-map/03-decisions.md](project-map/03-decisions.md) |
| 审代码、找边界 | — | [project-map/04-audit-guide.md](project-map/04-audit-guide.md) |

---

## 三个必须记住的约束

改代码前先确认没破坏它们：

| 约束 | 违反的表现 | 怎么查 |
|---|---|---|
| **前端不 `fetch`** | 网络请求绕过了 Rust 的校验、cookie、超时 | 全局搜 `fetch(`，应该为 0 |
| **Tauri 只在适配层** | 视图直接 `invoke`，移动端迁移会崩 | 只有 4 个文件该 import `@tauri-apps/api`：`src/api/library.ts`、`src/discover/api.ts`、`src/export/pickDirectory.ts`、`src/sources/mirror.ts` |
| **组件不写死数值** | 设计系统失效，改主题要动每个文件 | 搜 `px`，除 `tokens.css` 外应为 0 |

---

## Android 五条铁律

这几条都是踩出来的，**违反任意一条都会在真机上炸**：

1. **加插件后必须检查 Kotlin 侧进了 dex**
   ```powershell
   # 解压 APK 的 classes*.dex，搜类名。fs 插件的包名是 com.plugin.fs
   ```
   否则 Rust 半边在、构建成功、运行时报 plugin not found。（[坑 3](android.md)）

2. **HTTP 一律走 `tls::builder()`，不要 `reqwest::Client::builder()`**
   在 Android 上会直接 abort 进程。（[坑 2](android.md)）

3. **升级 pdfjs-dist 前先验证新 API**
   ```powershell
   Select-String -Path 'node_modules\pdfjs-dist\build\pdf.worker.mjs' -Pattern 'getOrInsertComputed' -AllMatches
   ```
   结果必须是 0。（[坑 4](android.md)）

4. **不要用 `pnpm tauri android build`（Windows）**
   会在编完 Rust 之后因符号链接失败。用脚本，或开开发者模式。

5. **构建完必须验证前端真的嵌进去了**
   `.so` 约 10 MB 说明有前端；9 MB 说明是 dev 模式，装上会白屏。（[坑 1](android.md)）

---

## 常见故障 → 原因

| 现象 | 大概率原因 |
|---|---|
| 装上打开白屏，`Failed to request localhost:1420` | 缺 `custom-protocol` feature（坑 1） |
| 一联网就闪退到桌面 | TLS 走了平台验证器（坑 2） |
| 调用插件报 not found | Kotlin 侧没进 dex（坑 3） |
| PDF 报 `xxx is not a function` | pdfjs 版本太新（坑 4） |
| 全屏按钮没反应 | Android WebView 的限制，需 CSS 兜底（坑 5） |
| 封面一直不出来 | 域名被污染 + 并发雪崩（坑 6） |
| 装不上 APK | 签名不对（`apksigner verify --print-certs`） |
| http 书源全部报网络错误 | `usesCleartextTraffic` 没开 |

---

## 把包装到手机

```powershell
$adb='C:\Users\<you>\AppData\Local\Android\Sdk\platform-tools\adb.exe'

& $adb devices -l          # 状态必须是 device；unauthorized 要去手机上点「允许」
& $adb install -r release-android\litearti-0.1.0-arm64-v8a.apk
& $adb shell am start -n app.litearti.reader/.MainActivity

# 日志
& $adb logcat -s RustStdoutStderr:* AndroidRuntime:E
& $adb logcat -d -b crash    # 崩溃专用缓冲区
```

---

## 构建产物在哪

| 产物 | 路径 |
|---|---|
| Android APK | `release-android/litearti-<version>-<abi>.apk` |
| 前端产物 | `dist/` |
| Rust 产物 | `src-tauri/target/<triple>/<profile>/` |
| Android 工程 | `src-tauri/gen/android/`（可改，见 android.md 附录） |
| 签名密钥 | `D:\Myproject\litearti-keys\litearti-release.jks`（**自签名，正式分发要换**） |

---

## 验证脚本怎么用

```bash
node scripts/verify-source-schema.mjs      # 断言，失败 exit 1
node scripts/shots-library.mjs             # 只生成截图，需要人看
```

`verify-*` 证明「功能对」，`shots-*` 证明「看着对」。**两者都要**——一个卡片可以逻辑全对但布局塌成 0 高度。

---

## 文档索引

| 想知道 | 读 |
|---|---|
| Android 怎么构建、踩过什么坑 | [android.md](android.md) |
| 代码审计从哪开始 | [project-map/README.md](project-map/README.md) |
| 目录职责 | [project-map/01-structure.md](project-map/01-structure.md) |
| 分层与边界 | [project-map/02-architecture.md](project-map/02-architecture.md) |
| 某个决定的理由与被拒方案 | [project-map/03-decisions.md](project-map/03-decisions.md) |
| 整体介绍与技术选型 | [project-overview.md](project-overview.md) |
| 书源怎么写 | [book-source-api.md](book-source-api.md) |
| 视觉规范 | [design-system.md](design-system.md) |
