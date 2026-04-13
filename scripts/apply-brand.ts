/**
 * apply-brand.ts — 品牌替换（核心）
 *
 * 遍历 upstream/ 全部文件，根据文件分类：
 * - code 文件 → replaceStringLiterals（js/shell 模式状态机）
 * - data 文件 → replaceFullText
 * - package.json → JSON 结构化处理
 */

import path from "node:path"
import {
  loadProduction,
  upstreamDir,
  walkFiles,
  classifyFile,
  isWhitelistedFile,
  replaceStringLiterals,
  replaceFullText,
  buildReplacePairs,
  log,
  type ProductionConfig,
  type ReplacePair,
} from "./_utils"

// ============================================================
// package.json 结构化处理
// ============================================================

/**
 * 对 package.json 进行 JSON 结构化修改
 * ⚠️ 唯一处理入口，不经过 replaceFullText
 */
function processPackageJson(
  content: string,
  cfg: ProductionConfig,
  pairs: ReplacePair[],
): string {
  const pkg = JSON.parse(content)

  // name 字段
  if (typeof pkg.name === "string") {
    pkg.name = pkg.name.replace(/\bopencode\b/g, cfg.productName)
  }

  // displayName
  if (typeof pkg.displayName === "string") {
    pkg.displayName = applyPairsToString(pkg.displayName, pairs)
  }

  // description
  if (typeof pkg.description === "string") {
    pkg.description = applyPairsToString(pkg.description, pairs)
  }

  // bin 的 key
  if (pkg.bin && typeof pkg.bin === "object") {
    const newBin: Record<string, string> = {}
    for (const [key, val] of Object.entries(pkg.bin)) {
      const newKey = key.replace(/\bopencode\b/g, cfg.productName)
      newBin[newKey] = val as string
    }
    pkg.bin = newBin
  }

  // ⚠️ 从上游仓库 URL 推导原始包目录名（目录未重命名）
  const upstreamDirName = cfg.upstreamRepo.split("/").pop()?.replace(/\.git$/, "") ?? "opencode"
  // 用于恢复脚本中被误替换的目录路径
  const revertPkgPath = (s: string) =>
    s.replace(
      new RegExp(`packages\\/${cfg.productName.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}(?=[/\\\\\\s"']|$)`, "g"),
      `packages/${upstreamDirName}`,
    )

  // scripts 的 value
  if (pkg.scripts && typeof pkg.scripts === "object") {
    for (const [key, val] of Object.entries(pkg.scripts)) {
      if (typeof val === "string") {
        // ⚠️ 替换后恢复 --cwd packages/<dir> 等实际目录路径（目录未重命名）
        pkg.scripts[key] = revertPkgPath(applyPairsToString(val, pairs))
      }
    }
  }

  // 依赖字段：workspace 引用的 key 需要替换（保持 name 一致），外部依赖 key 不动
  const depKeys = new Set(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])
  for (const dk of depKeys) {
    const deps = pkg[dk]
    if (!deps || typeof deps !== "object") continue
    const newDeps: Record<string, string> = {}
    for (const [key, val] of Object.entries(deps)) {
      if (typeof val === "string" && (val as string).startsWith("workspace:")) {
        // ⚠️ workspace 引用 → 替换 key（与 name 字段同步）
        newDeps[applyPairsToString(key, pairs)] = val as string
      } else {
        newDeps[key] = val as string
      }
    }
    pkg[dk] = newDeps
  }

  // 递归遍历其他字符串值（跳过 dependencies/devDependencies）
  function walk(obj: unknown, parentKey?: string): unknown {
    if (typeof obj === "string") {
      return applyPairsToString(obj, pairs)
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => walk(item))
    }
    if (obj && typeof obj === "object") {
      const result: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(obj)) {
        if (depKeys.has(k)) {
          result[k] = v // 已单独处理
        } else if (k === "name" || k === "displayName" || k === "description" || k === "bin" || k === "scripts") {
          result[k] = v // 已单独处理
        } else {
          result[k] = walk(v, k)
        }
      }
      return result
    }
    return obj
  }

  const walked = walk(pkg) as Record<string, unknown>
  // 恢复已单独处理的字段
  walked.name = pkg.name
  walked.displayName = pkg.displayName
  walked.description = pkg.description
  walked.bin = pkg.bin
  walked.scripts = pkg.scripts
  for (const dk of depKeys) {
    if (pkg[dk]) walked[dk] = pkg[dk]
  }

  // 检测原始缩进
  const indent = detectIndent(content)
  let result = JSON.stringify(walked, null, indent)
  // 保留尾部换行（如果原始有）
  if (content.endsWith("\n")) result += "\n"
  return result
}

/** 检测 JSON 文件的缩进 */
function detectIndent(content: string): number {
  const match = content.match(/^(\s+)"/m)
  return match ? match[1].length : 2
}

/** 对单个字符串应用替换对 */
function applyPairsToString(text: string, pairs: ReplacePair[]): string {
  let result = text
  for (const [re, replacement] of pairs) {
    re.lastIndex = 0
    result = result.replace(re, replacement)
  }
  return result
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const cfg = await loadProduction()
  const dir = upstreamDir()
  const pairs = buildReplacePairs(cfg)

  const fileWhitelist = cfg.brandWhitelist?.files ?? []
  const lineWhitelist = cfg.brandWhitelist?.lines ?? []

  let totalFiles = 0
  let modifiedFiles = 0
  let packageJsonCount = 0

  for await (const filePath of walkFiles(dir)) {
    const relPath = path.relative(dir, filePath).replace(/\\/g, "/")

    // ⚠️ 白名单文件跳过
    if (isWhitelistedFile(relPath, fileWhitelist)) {
      continue
    }

    totalFiles++

    const content = await Bun.file(filePath).text()
    let newContent: string

    const basename = path.basename(filePath)

    if (basename === "package.json") {
      // ⚠️ package.json 走专用 JSON 结构化处理
      newContent = processPackageJson(content, cfg, pairs)
      packageJsonCount++
    } else {
      const cls = classifyFile(filePath, content)

      if (cls.type === "code") {
        newContent = replaceStringLiterals(content, pairs, lineWhitelist, cls.mode)
      } else {
        newContent = replaceFullText(content, pairs, lineWhitelist)
      }
    }

    if (newContent !== content) {
      await Bun.write(filePath, newContent)
      modifiedFiles++
    }
  }

  log("success", `品牌替换完成：扫描 ${totalFiles} 文件，修改 ${modifiedFiles} 文件（含 ${packageJsonCount} 个 package.json）`)
}

main().catch((e) => {
  log("error", String(e))
  process.exit(1)
})
