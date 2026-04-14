/**
 * _utils.ts — opencode-wrapper 公共工具
 *
 * 包含：
 * - JSONC 配置加载
 * - 文件遍历 / 分类 / 白名单
 * - 字符串字面量状态机替换（js 模式 + shell 模式）
 * - 全文替换（data 文件）
 * - 日志
 */

import path from "node:path"
import fs from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import stripJsonComments from "strip-json-comments"

// ============================================================
// 类型定义
// ============================================================

export interface ProductionConfig {
  productName: string
  productNameDisplay: string
  productNameUpper: string
  productDomain: string
  productRepoUrl: string
  upstreamRepo: string
  upstreamRef: string
  desktopAppId: string
  urlScheme: string
  npmPackageName: string
  paths: {
    data: string | null
    cache: string | null
    config: string | null
    state: string | null
  }
  envDefaults?: Record<string, string>
  brandWhitelist: {
    files: string[]
    lines: string[]
  }
  assets: {
    banner: string
    icons: {
      tauri: string
      electron: string
      win: string
    }
  }
}

/** 替换对：[正则, 替换值] */
export type ReplacePair = [RegExp, string]

// ============================================================
// 配置加载
// ============================================================

const ROOT = path.resolve(import.meta.dir, "..")

/** 项目根目录绝对路径 */
export function projectRoot(): string {
  return ROOT
}

/** 加载并验证 production.jsonc */
export async function loadProduction(): Promise<ProductionConfig> {
  const filePath = path.join(ROOT, "production.jsonc")
  const raw = await Bun.file(filePath).text()
  const json = JSON.parse(stripJsonComments(raw))

  // 验证必填字段
  const required: (keyof ProductionConfig)[] = [
    "productName",
    "productNameDisplay",
    "productNameUpper",
    "productDomain",
    "productRepoUrl",
    "upstreamRepo",
    "upstreamRef",
    "desktopAppId",
    "urlScheme",
    "npmPackageName",
  ]
  const missing = required.filter((k) => !json[k])
  if (missing.length > 0) {
    throw new Error(`production.jsonc 缺少必填字段: ${missing.join(", ")}`)
  }
  return json as ProductionConfig
}

// ============================================================
// 文件遍历
// ============================================================

/** 二进制文件扩展名，遍历时跳过 */
const BINARY_EXTS = new Set([
  ".ico", ".icns", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
  ".wasm", ".node", ".exe", ".dll", ".so", ".dylib",
  ".zip", ".tar", ".gz", ".br", ".zst",
  ".ttf", ".otf", ".woff", ".woff2",
  ".sqlite", ".db",
])

/** 遍历时跳过的目录名 */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".turbo"])

export interface WalkOpts {
  /** 额外要跳过的目录名 */
  skipDirs?: Set<string>
  /** 是否跳过二进制文件（默认 true） */
  skipBinary?: boolean
}

/** 递归遍历目录，返回文件绝对路径的异步迭代器 */
export async function* walkFiles(
  dir: string,
  opts: WalkOpts = {},
): AsyncGenerator<string> {
  const skip = opts.skipDirs
    ? new Set([...SKIP_DIRS, ...opts.skipDirs])
    : SKIP_DIRS
  const skipBin = opts.skipBinary !== false

  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) {
        yield* walkFiles(full, opts)
      }
    } else if (entry.isFile()) {
      if (skipBin) {
        const ext = path.extname(entry.name).toLowerCase()
        if (BINARY_EXTS.has(ext)) continue
      }
      yield full
    }
  }
}

// ============================================================
// 文件分类
// ============================================================

/** code 文件扩展名 → 替换模式 */
const CODE_EXT_MAP: Record<string, "js" | "shell"> = {
  ".ts": "js",
  ".js": "js",
  ".tsx": "js",
  ".jsx": "js",
  ".mts": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".rs": "js", // ⚠️ Rust raw string r#"..."# 不被状态机识别，风险极低
  ".sh": "shell",
  ".bash": "shell",
}

export type FileClass =
  | { type: "code"; mode: "js" | "shell" }
  | { type: "data" }

/**
 * 分类文件为 code（js/shell 模式）或 data
 * ⚠️ 无扩展名文件通过 shebang 行检测分类
 */
export function classifyFile(filePath: string, content?: string): FileClass {
  const ext = path.extname(filePath).toLowerCase()

  // 有扩展名 → 直接查表
  if (ext && CODE_EXT_MAP[ext]) {
    return { type: "code", mode: CODE_EXT_MAP[ext] }
  }
  if (ext) {
    return { type: "data" }
  }

  // ⚠️ 无扩展名 → 读首行检测 shebang
  let firstLine: string
  if (content !== undefined) {
    const nlIdx = content.indexOf("\n")
    firstLine = nlIdx === -1 ? content : content.slice(0, nlIdx)
  } else if (existsSync(filePath)) {
    // 只读前 256 字节即可
    const buf = readFileSync(filePath, { encoding: "utf-8" }).slice(0, 256)
    const nlIdx = buf.indexOf("\n")
    firstLine = nlIdx === -1 ? buf : buf.slice(0, nlIdx)
  } else {
    return { type: "data" }
  }

  firstLine = firstLine.trim()
  if (firstLine.startsWith("#!")) {
    if (/\b(node|bun|deno)\b/.test(firstLine)) {
      return { type: "code", mode: "js" }
    }
    if (/\b(sh|bash|zsh|dash)\b/.test(firstLine)) {
      return { type: "code", mode: "shell" }
    }
  }

  return { type: "data" }
}

// ============================================================
// 白名单
// ============================================================

/**
 * 检查文件是否命中白名单（整体跳过）
 * ⚠️ relPath 统一转正斜杠后匹配
 */
export function isWhitelistedFile(
  relPath: string,
  globs: string[],
): boolean {
  const normalized = relPath.replace(/\\/g, "/")
  for (const pattern of globs) {
    const g = new Bun.Glob(pattern)
    if (g.match(normalized)) return true
  }
  return false
}

/** 检查某行是否命中行级白名单 */
export function isWhitelistedLine(
  line: string,
  patterns: string[],
): boolean {
  for (const pat of patterns) {
    if (line.includes(pat)) return true
  }
  return false
}

// ============================================================
// 替换对构建
// ============================================================

/** 从配置构建严格有序的替换对列表 */
export function buildReplacePairs(cfg: ProductionConfig): ReplacePair[] {
  // ⚠️ 顺序至关重要：长模式优先，opencode 小写必须最后
  return [
    [/\bOPENCODE_/g, `${cfg.productNameUpper}_`],   // 1. 环境变量前缀
    [/\bOPENCODE\b/g, cfg.productNameUpper],          // 2. 裸环境变量名
    [/\bOpenCode\b/g, cfg.productNameDisplay],         // 3. 驼峰展示名
    [/\bOpencode\b/g, cfg.productNameDisplay],         // 4. 标题格式展示名
    [/\bopencode-ai\b/g, cfg.npmPackageName],          // 5. npm 包名
    [/\bopencode\.ai\b/g, cfg.productDomain],          // 6. 域名
    [/\bopencode\b/g, cfg.productName],                // 7. 小写（最后）
  ]
}

// ============================================================
// 字符串字面量替换（状态机）
// ============================================================

/**
 * 对 code 文件进行精准替换：
 * - js 模式：仅替换字符串字面量内 + normal 上下文中 OPENCODE/OPENCODE_ 前缀
 * - shell 模式：默认全部替换，仅跳过 # 注释和单引号内容
 *
 * ⚠️ 保留原始换行符风格
 * ⚠️ Rust raw string r#"..."# 不被状态机识别，风险极低
 */
export function replaceStringLiterals(
  content: string,
  pairs: ReplacePair[],
  lineWhitelist: string[],
  mode: "js" | "shell",
): string {
  // 检测换行风格
  const crlf = content.includes("\r\n")
  // 统一为 \n 处理
  const normalized = crlf ? content.replace(/\r\n/g, "\n") : content

  const lines = normalized.split("\n")
  const resultLines: string[] = []

  for (const line of lines) {
    // ⚠️ 行级白名单：命中则整行保留
    if (isWhitelistedLine(line, lineWhitelist)) {
      resultLines.push(line)
      continue
    }

    if (mode === "js") {
      resultLines.push(replaceLineJs(line, pairs))
    } else {
      resultLines.push(replaceLineShell(line, pairs))
    }
  }

  let result = resultLines.join("\n")
  // ⚠️ 恢复原始换行风格
  if (crlf) {
    result = result.replace(/\n/g, "\r\n")
  }
  return result
}

/**
 * JS 模式行级替换：
 * - normal 上下文 → 仅替换 OPENCODE / OPENCODE_ 前缀
 * - 字符串字面量 → 全部替换（import 路径例外，见下）
 * - 注释 → 不替换
 *
 * ⚠️ import/require 路径字面量特殊处理：
 *   - 相对路径（./  ../）：文件未重命名，不替换
 *   - 外部 npm 包（如 opencode-gitlab-auth）：不替换
 *   - workspace 内部包（@opencode-ai/*、opencode、opencode/*）：替换
 */
function replaceLineJs(line: string, pairs: ReplacePair[]): string {
  const segments = tokenizeJs(line)
  let result = ""

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (seg.ctx === "string") {
      const prevText = i > 0 && segments[i - 1].ctx === "normal" ? segments[i - 1].text : ""

      if (_isModuleSpecifier(prevText)) {
        // import/require 路径 → 仅替换 workspace 内部包
        const inner = seg.text.slice(1, -1) // 去掉引号
        if (_isWorkspacePackRef(inner)) {
          result += applyPairs(seg.text, pairs)
        } else {
          result += seg.text // 相对路径或外部包 → 不替换
        }
      } else {
        // 普通字符串字面量 → 全部替换
        result += applyPairs(seg.text, pairs)
      }
    } else if (seg.ctx === "normal") {
      // normal 上下文 → 仅替换 OPENCODE / OPENCODE_ 环境变量相关
      result += replaceEnvVarPatterns(seg.text, pairs)
    } else {
      // comment → 原样保留
      result += seg.text
    }
  }

  return result
}

/** 判断前置 normal 片段是否表明当前字符串为模块路径 */
function _isModuleSpecifier(prevNormal: string): boolean {
  if (/\bfrom\s*$/.test(prevNormal)) return true                     // import { } from "..."
  if (/^\s*import\s*$/.test(prevNormal.trim())) return true          // import "..." 副作用导入
  if (/\b(?:import|require)\s*\(\s*$/.test(prevNormal)) return true  // import(...) require(...)
  return false
}

/**
 * 判断模块路径是否为 workspace 内部包（需随品牌一起替换）
 * - 相对/绝对路径 → false（文件未重命名）
 * - @opencode-ai/* scoped 包 → true
 * - opencode 或 opencode/* 主包 → true
 * - 其他外部包 → false
 */
function _isWorkspacePackRef(specifier: string): boolean {
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
    return false
  }
  if (/^@opencode-ai\//.test(specifier)) return true
  if (specifier === "opencode" || specifier.startsWith("opencode/")) return true
  return false
}

interface Segment {
  text: string
  ctx: "normal" | "string" | "comment"
}

/**
 * 将一行 JS/TS/Rust 代码拆分为 normal / string / comment 片段
 *
 * 状态：
 *  - normal: 普通代码
 *  - singleQuote / doubleQuote / templateLiteral: 字符串内
 *  - lineComment / blockComment: 注释内
 *
 * ⚠️ 模板字面量 ${expr} 内递归回 normal（深度计数）
 * ⚠️ 块注释可能跨行，但本函数逐行处理；后续行由 blockCommentCarry 处理
 */
function tokenizeJs(line: string): Segment[] {
  const segments: Segment[] = []
  let state: "normal" | "singleQuote" | "doubleQuote" | "templateLiteral" | "lineComment" | "blockComment" = "normal"
  let buf = ""
  let templateDepth = 0 // 模板字面量 ${} 嵌套深度
  let braceDepth = 0 // 当前 ${} 内的花括号深度
  let i = 0

  // ⚠️ 行首检查：如果上一行留有未闭合的块注释状态，这里不处理
  // （逐行模式下块注释罕见包含品牌字符串，接受此简化）

  const flush = (ctx: "normal" | "string" | "comment") => {
    if (buf.length > 0) {
      segments.push({ text: buf, ctx })
      buf = ""
    }
  }

  while (i < line.length) {
    const ch = line[i]
    const next = line[i + 1]

    switch (state) {
      case "normal": {
        if (ch === "/" && next === "/") {
          flush("normal")
          // 该行剩余全是行注释
          segments.push({ text: line.slice(i), ctx: "comment" })
          i = line.length
          continue
        }
        if (ch === "/" && next === "*") {
          flush("normal")
          // ⚠️ 块注释：查找 */ 闭合
          const closeIdx = line.indexOf("*/", i + 2)
          if (closeIdx !== -1) {
            segments.push({ text: line.slice(i, closeIdx + 2), ctx: "comment" })
            i = closeIdx + 2
          } else {
            // 块注释延续到行尾（简化：直接保留为注释）
            segments.push({ text: line.slice(i), ctx: "comment" })
            i = line.length
          }
          continue
        }
        if (ch === "'") {
          flush("normal")
          state = "singleQuote"
          buf = ch
          i++
          continue
        }
        if (ch === '"') {
          flush("normal")
          state = "doubleQuote"
          buf = ch
          i++
          continue
        }
        if (ch === "`") {
          flush("normal")
          state = "templateLiteral"
          templateDepth++
          buf = ch
          i++
          continue
        }
        buf += ch
        i++
        break
      }

      case "singleQuote": {
        buf += ch
        if (ch === "\\" && i + 1 < line.length) {
          buf += line[i + 1]
          i += 2
          continue
        }
        if (ch === "'") {
          flush("string")
          state = "normal"
        }
        i++
        break
      }

      case "doubleQuote": {
        buf += ch
        if (ch === "\\" && i + 1 < line.length) {
          buf += line[i + 1]
          i += 2
          continue
        }
        if (ch === '"') {
          flush("string")
          state = "normal"
        }
        i++
        break
      }

      case "templateLiteral": {
        if (ch === "\\" && i + 1 < line.length) {
          buf += ch + line[i + 1]
          i += 2
          continue
        }
        if (ch === "$" && next === "{") {
          // ⚠️ 进入模板表达式 → 切回 normal
          buf += "${"
          flush("string")
          state = "normal"
          braceDepth = 1
          i += 2
          continue
        }
        if (ch === "`") {
          buf += ch
          flush("string")
          templateDepth--
          state = templateDepth > 0 ? "templateLiteral" : "normal"
          i++
          continue
        }
        buf += ch
        i++
        break
      }

      // 不应在逐行模式下到达 blockComment / lineComment 初始状态
      default: {
        buf += ch
        i++
      }
    }

    // ⚠️ 检测模板表达式 ${} 内花括号的嵌套与闭合
    if (state === "normal" && braceDepth > 0) {
      const lastCh = line[i - 1]
      if (lastCh === "{") braceDepth++
      if (lastCh === "}") {
        braceDepth--
        if (braceDepth === 0) {
          // 回到模板字面量
          flush("normal")
          state = "templateLiteral"
        }
      }
    }
  }

  // 清空剩余 buffer
  if (buf.length > 0) {
    const ctx: "normal" | "string" | "comment" =
      state === "singleQuote" || state === "doubleQuote" || state === "templateLiteral"
        ? "string"
        : state === "lineComment" || state === "blockComment"
          ? "comment"
          : "normal"
    segments.push({ text: buf, ctx })
  }

  return segments
}

/**
 * Shell 模式行级替换：
 * - 默认全部替换（normal、双引号、heredoc）
 * - 仅跳过 # 注释和单引号内容
 */
function replaceLineShell(line: string, pairs: ReplacePair[]): string {
  const segments = tokenizeShell(line)
  let result = ""

  for (const seg of segments) {
    if (seg.ctx === "comment" || seg.ctx === "singleQuote") {
      // # 注释和单引号 → 不替换
      result += seg.text
    } else {
      // normal / doubleQuote → 全部替换
      result += applyPairs(seg.text, pairs)
    }
  }

  return result
}

interface ShellSegment {
  text: string
  ctx: "normal" | "doubleQuote" | "singleQuote" | "comment"
}

/** 将一行 shell 代码拆分为上下文片段 */
function tokenizeShell(line: string): ShellSegment[] {
  const segments: ShellSegment[] = []
  let state: "normal" | "doubleQuote" | "singleQuote" = "normal"
  let buf = ""
  let i = 0

  const flush = (ctx: ShellSegment["ctx"]) => {
    if (buf.length > 0) {
      segments.push({ text: buf, ctx })
      buf = ""
    }
  }

  while (i < line.length) {
    const ch = line[i]

    switch (state) {
      case "normal": {
        if (ch === "#") {
          flush("normal")
          // # 到行尾都是注释
          segments.push({ text: line.slice(i), ctx: "comment" })
          i = line.length
          continue
        }
        if (ch === "'") {
          flush("normal")
          state = "singleQuote"
          buf = ch
          i++
          continue
        }
        if (ch === '"') {
          flush("normal")
          state = "doubleQuote"
          buf = ch
          i++
          continue
        }
        buf += ch
        i++
        break
      }

      case "singleQuote": {
        buf += ch
        if (ch === "'") {
          flush("singleQuote")
          state = "normal"
        }
        i++
        break
      }

      case "doubleQuote": {
        buf += ch
        if (ch === "\\" && i + 1 < line.length) {
          buf += line[i + 1]
          i += 2
          continue
        }
        if (ch === '"') {
          flush("doubleQuote")
          state = "normal"
        }
        i++
        break
      }
    }
  }

  // 清空
  if (buf.length > 0) {
    const ctx: ShellSegment["ctx"] =
      state === "singleQuote" ? "singleQuote" : state === "doubleQuote" ? "doubleQuote" : "normal"
    segments.push({ text: buf, ctx })
  }

  return segments
}

/**
 * 对 normal 上下文中仅替换 OPENCODE 相关环境变量模式
 *
 * 替换以下模式（语义上是用户可见的环境变量名）：
 * - OPENCODE_ 前缀
 * - 裸 OPENCODE
 * - process.env.OPENCODE / process.env.OPENCODE_
 */
function replaceEnvVarPatterns(text: string, pairs: ReplacePair[]): string {
  // 从 pairs 中只取前两条（OPENCODE_ 前缀和裸 OPENCODE）
  let result = text
  for (const [re, replacement] of pairs) {
    // ⚠️ 仅应用匹配 OPENCODE 大写的规则（前两条）
    if (re.source.includes("OPENCODE")) {
      // 每次使用前重置 lastIndex（正则带 g 标志）
      re.lastIndex = 0
      result = result.replace(re, replacement)
    }
  }
  return result
}

/** 按顺序应用全部替换对 */
function applyPairs(text: string, pairs: ReplacePair[]): string {
  let result = text
  for (const [re, replacement] of pairs) {
    re.lastIndex = 0
    result = result.replace(re, replacement)
  }
  return result
}

// ============================================================
// 全文替换（data 文件）
// ============================================================

/**
 * 对 data 文件按行级白名单 + 全文替换
 * ⚠️ 保留原始换行符风格
 */
export function replaceFullText(
  content: string,
  pairs: ReplacePair[],
  lineWhitelist: string[],
): string {
  const crlf = content.includes("\r\n")
  const normalized = crlf ? content.replace(/\r\n/g, "\n") : content
  const lines = normalized.split("\n")

  const resultLines = lines.map((line) => {
    if (isWhitelistedLine(line, lineWhitelist)) return line
    return applyPairs(line, pairs)
  })

  let result = resultLines.join("\n")
  if (crlf) {
    result = result.replace(/\n/g, "\r\n")
  }
  return result
}

// ============================================================
// 日志
// ============================================================

const isCI = !!process.env.CI

const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
} as const

export function log(level: "info" | "warn" | "error" | "success" | "dim", msg: string): void {
  const prefix = isCI
    ? { info: "[INFO]", warn: "[WARN]", error: "[ERROR]", success: "[OK]", dim: "[..]" }[level]
    : {
        info: `${COLORS.cyan}ℹ${COLORS.reset}`,
        warn: `${COLORS.yellow}⚠${COLORS.reset}`,
        error: `${COLORS.red}✖${COLORS.reset}`,
        success: `${COLORS.green}✔${COLORS.reset}`,
        dim: `${COLORS.dim}·${COLORS.reset}`,
      }[level]

  const stream = level === "error" ? process.stderr : process.stdout
  stream.write(`${prefix} ${msg}\n`)
}

// ============================================================
// 辅助
// ============================================================

/** upstream/ 目录绝对路径 */
export function upstreamDir(): string {
  return path.join(ROOT, "upstream")
}

/** 执行 shell 命令并返回结果 */
export async function exec(
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd,
    env: { ...process.env, ...opts?.env },
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited

  return { exitCode, stdout, stderr }
}
