# opencode-wrapper

基于 [opencode](https://github.com/anomalyco/opencode) 的产品化包装器。  
一键将上游源码中所有用户可见的 "opencode" 品牌替换为你的自定义产品名，涵盖 UI 文本、日志输出、环境变量、进程名、配置路径、桌面应用标识和图标等。

## 设计原则

- **不 fork，只包装** — 上游代码作为临时目录自动拉取，不提交到本仓库
- **字符串字面量级精度** — 代码文件通过状态机识别字符串上下文，仅替换用户可见文本；变量名、函数名、import 路径等代码结构标识符不受影响
- **全部 TypeScript** — 所有脚本用 [Bun](https://bun.sh) 运行，跨平台，无 bash/sed/jq 依赖
- **幂等** — 重复执行安全，通过 `.wrapper-stamp` 避免重复拉取和打补丁

## 快速开始

### 前置要求

- [Bun](https://bun.sh) ≥ 1.0
- Git

### 1. 克隆并安装依赖

```bash
git clone <your-repo-url>
cd opencode-wrapper
bun install
```

### 2. 配置品牌

编辑 `production.jsonc`，至少填写以下必填字段：

| 字段 | 说明 | 示例 |
|------|------|------|
| `productName` | 小写产品名（CLI 命令名、目录名） | `mycode` |
| `productNameDisplay` | 驼峰展示名（UI 标题） | `MyCode` |
| `productNameUpper` | 全大写（环境变量前缀） | `MYCODE` |
| `productDomain` | 产品域名 | `mycode.example.com` |
| `upstreamRepo` | 上游仓库地址 | `https://github.com/anomalyco/opencode` |
| `upstreamRef` | 上游版本（tag 或 SHA） | `v1.4.2` |
| `desktopAppId` | 桌面应用标识符 | `com.example.mycode` |
| `urlScheme` | URL Scheme | `mycode` |
| `npmPackageName` | npm 包名 | `mycode-ai` |
| `productRepoUrl` | 产品仓库地址 | `https://github.com/your-org/mycode` |

### 3. 放置资产文件（可选）

```
assets/
  banner.txt              TUI 启动 banner（纯文本，`#` 会被渲染为 █ 块字符）
  icons/
    tauri/                 Tauri 桌面端图标集
    electron/              Electron 桌面端图标集
    app.ico                Windows PE 图标（多分辨率 ICO）
```

`assets.banner` 未配置或文件不存在时，构建会使用 [figlet](https://github.com/cmatsuoka/figlet) Banner3 字体自动从 `productNameDisplay` 生成像素块风格的 banner，无需手动准备。

### 4. 构建

```bash
# 完整流程：拉取上游 → 品牌替换 → 构建
bun run build

# 仅品牌替换，不执行上游构建
bun run build --brand-only

# 跳过上游拉取（适用于本地已有 upstream/）
bun run build --skip-fetch

# 构建后自动运行验证
bun run build --verify

# 输出详细日志（脚本输出、注入内容、验证详情、阶段总结）
bun run build --verbose
```

构建完成后，上游产物会自动复制到项目根目录的 `dist/`。每次构建开始前，根目录 `dist/` 会先清理，避免旧产物残留。

### 5. 控制构建目标（可选）

`production.jsonc` 支持通过 `buildTargets` 精确声明要构建的 OS/架构组合，格式与上游 `upstream/packages/opencode/script/build.ts` 的目标定义保持一致：

```jsonc
"buildTargets": [
       {
              "os": "linux",
              "arch": "x64",
              "abi": "musl"
       },
       {
              "os": "linux",
              "arch": "x64",
              "abi": "musl",
              "avx2": false
       },
       {
              "os": "darwin",
              "arch": "x64",
              "avx2": false
       },
       {
              "os": "win32",
              "arch": "x64"
       }
]
```

- `os`: `linux`、`darwin`、`win32`
- `arch`: `x64`、`arm64`
- `abi: "musl"`: 仅 Linux musl 变体
- `avx2: false`: baseline 变体（无 AVX2）

未配置 `buildTargets` 时，仍沿用上游默认构建逻辑。

## 构建流程

`bun run build` 串行执行以下步骤：

```
fetch-upstream     拉取上游源码（幂等，检查 .wrapper-stamp）
       ↓
apply-brand        品牌替换（核心，状态机 + JSON 结构化处理）
       ↓
apply-paths        全局路径注入（从 production.jsonc 动态生成）
       ↓
apply-icons        图标覆盖（Tauri + Electron）
       ↓
apply-windows-pe   Windows PE 图标注入
       ↓
apply-banner       TUI banner 替换
       ↓
migrate-config     迁移补丁注入（旧品牌 → 新品牌配置自动迁移）
       ↓
apply-build-targets 构建目标注入（将 buildTargets 透传给上游）
       ↓
upstream build     调用上游 bun build 输出最终产物
       ↓
copy dist          复制 upstream/packages/opencode/dist → 项目根 dist/
```

也可单独运行各步骤：

```bash
bun run fetch          # 仅拉取上游
bun run brand          # 仅品牌替换
bun run verify         # 验证替换结果
```

## 品牌替换策略

### 替换对（严格有序，长模式优先）

| 序号 | 匹配模式 | 替换为 |
|------|---------|--------|
| 1 | `OPENCODE_` | `{productNameUpper}_` |
| 2 | `OPENCODE` | `{productNameUpper}` |
| 3 | `OpenCode` | `{productNameDisplay}` |
| 4 | `Opencode` | `{productNameDisplay}` |
| 5 | `opencode-ai` | `{npmPackageName}` |
| 6 | `opencode.ai` | `{productDomain}` |
| 7 | `opencode` | `{productName}` |

### 文件分类处理

| 文件类型 | 处理方式 |
|---------|---------|
| **代码文件**（`.ts`/`.js`/`.rs`） | 状态机（JS 模式）：字符串字面量全替换，normal 上下文仅替换环境变量模式，注释不动 |
| **Shell 脚本**（`.sh`/`.bash`） | 状态机（Shell 模式）：默认全替换，仅跳过 `#` 注释和单引号内容 |
| **数据文件**（`.json`/`.yaml`/`.html` 等） | 全文替换（排除白名单行） |
| **`package.json`** | JSON 结构化处理：`name`/`displayName`/`bin`/`scripts` 单独处理；依赖键名仅重写 `workspace:*` 引用，外部依赖保持不变 |

### 白名单

在 `production.jsonc` 的 `brandWhitelist` 中配置：

- **文件级**（`files`）：glob 模式匹配的文件整体跳过
- **行级**（`lines`）：包含指定字符串的行保留不替换

在代码中添加 `@brand-keep` 注释即可保护该行不被替换。

## 全局路径覆盖

`production.jsonc` 的 `paths` 字段支持自定义数据/缓存/配置/状态目录位置：

```jsonc
"paths": {
  "data":   "${APPDATA}/mycode",      // Windows 示例
  "cache":  null,                      // null = 使用默认 XDG 路径
  "config": "${HOME}/.config/mycode",
  "state":  null
}
```

- `${ENV_VAR}` 模板在运行时展开
- 可选 `envDefaults` 为路径模板中的环境变量提供默认值
- `envDefaults` 支持两种值：字符串（所有平台共享）或对象（按 `windows` / `linux` / `macos` 区分）

```jsonc
"envDefaults": {
       "MY_CODE_VAR": "1",
       "MY_CODE_ROOT": {
              "windows": "C:\\Users\\Public\\mycode",
              "linux": "/opt/mycode",
              "macos": "/Library/Application Support/mycode"
       }
}
```

- 路径变量解析优先级：运行时环境变量 → 变量级平台默认值 → 变量级共享默认值 → 默认 XDG 路径
- 设置 `{PRODUCT_UPPER}_CUSTOM_PATHS=0` 可在运行时绕过路径覆盖

## 详细日志

执行 `bun run build --verbose` 时，所有阶段会输出详细日志，包括但不限于：

- 子脚本执行过程中的完整输出
- 被修改的文件及命中的替换规则
- 注入到上游文件中的内容
- 验证阶段每个检查项的结果与耗时
- 上游构建过程的实时输出
- 每个阶段完成后的耗时和总结报告

## 配置迁移

构建会自动注入运行时迁移补丁：用户从上游 opencode 切换到新品牌产品后，首次启动时自动将旧品牌的配置/数据/缓存目录复制到新品牌目录下：

- 全局 XDG 数据/缓存/配置/状态目录
- 项目级 `.opencode/` → `.{productName}/`
- 配置文件名（`opencode.json` → `{productName}.json`）
- 系统级配置（macOS `/Library/Application Support/`、Linux `/etc/`）

迁移策略：**仅当目标不存在时复制**，不覆盖已有数据。通过 `migration.lock` 保证幂等。

## 补丁

将 `.patch` 文件放入 `patches/` 目录，会在拉取上游后按字典序自动应用（`git apply --whitespace=fix`）。

补丁变更后 `fetch-upstream` 会自动检测 `patchHash` 变化并重新拉取。

## 验证

`bun run verify` 执行 8 项自动检查：

1. 代码文件字符串字面量中不残留 `opencode`
2. 数据文件不残留 `opencode`
3. `global/index.ts` app name 已替换
4. `package.json` name/bin 已替换
5. Tauri conf identifier 正确
6. `build.ts` outfile 已替换
7. Windows PE 图标已注入
8. 代码标识符未被误替换

## CI

`.github/workflows/build.yml` 提供三平台（Ubuntu / macOS / Windows）矩阵构建，自动上传产物。

## 项目结构

```
production.jsonc              品牌配置（JSONC，支持注释）
package.json                  wrapper 包声明
scripts/
  _utils.ts                   公共工具（状态机 / JSONC / 遍历 / 日志）
  build.ts                    主编排
  fetch-upstream.ts           上游拉取（幂等）
  apply-brand.ts              品牌替换（核心）
  apply-paths.ts              全局路径注入
  apply-icons.ts              图标覆盖
  apply-windows-pe.ts         Windows PE 图标
  apply-banner.ts             TUI banner
  migrate-config.ts           迁移补丁注入
  apply-build-targets.ts      构建目标注入
  verify.ts                   完整性验证
assets/
  banner.txt                  TUI 启动 banner
  icons/                      图标资产
patches/                      上游补丁
.github/workflows/            CI 配置
dist/                         根目录构建产物输出
upstream/                     (git ignored) 上游源码临时目录
```

## 许可证

本包装器代码遵循 [MIT](LICENSE) 许可证。上游 opencode 遵循其自身许可证。
