/**
 * apply-banner.ts — TUI banner 替换
 *
 * 目标：upstream/packages/opencode/src/cli/logo.ts
 *
 * 1. assets.banner 文件存在 → 读取文件内容替换 logo 字符串字面量
 * 2. assets.banner 未配置或文件不存在 → 根据 productNameDisplay 生成默认方框 banner
 *
 * ⚠️ logo.ts 导出格式为：
 *   export const logo = { left: [...], right: [...] }
 * 两者均支持替换此对象格式及旧版字符串字面量格式。
 */

import path from "node:path"
import { existsSync } from "node:fs"
import { loadProduction, upstreamDir, log, projectRoot, isVerbose, verboseLog } from "./_utils"

// ============================================================
// 默认 banner 生成
// ============================================================

/**
 * 根据 productNameDisplay 生成简单方框样式的 logo 对象替换代码
 *
 * 生成示例（productNameDisplay = "MyCode"）：
 *   export const logo = {
 *     left:  ["            ", "╔══════════╗", "║  MyCode  ║", "╚══════════╝"],
 *     right: ["            ", "            ", "            ", "            "],
 *   }
 */
function generateDefaultLogo(productNameDisplay: string): string {
  const padH = 2
  const inner = padH + productNameDisplay.length + padH
  const blank   = " ".repeat(inner + 2)           // 与框同宽的空格行
  const topLine = "╔" + "═".repeat(inner) + "╗"
  const midLine = "║" + " ".repeat(padH) + productNameDisplay + " ".repeat(padH) + "║"
  const botLine = "╚" + "═".repeat(inner) + "╝"

  const leftRows  = [blank, topLine, midLine, botLine]
  const rightRows = leftRows.map(() => blank)

  const serArr = (arr: string[]) =>
    "[" + arr.map((s) => JSON.stringify(s)).join(", ") + "]"

  return (
    `export const logo = {\n` +
    `  left:  ${serArr(leftRows)},\n` +
    `  right: ${serArr(rightRows)},\n` +
    `}`
  )
}

// ============================================================
// 工具
// ============================================================

/** 将 newContent 的行尾符规范化成与 original 保持一致（纯 LF 或纯 CRLF） */
function normalizeLineEndings(newContent: string, original: string): string {
  const useCRLF = original.includes("\r\n")
  // 先统一到 LF
  const lf = newContent.replace(/\r\n/g, "\n")
  return useCRLF ? lf.replace(/\n/g, "\r\n") : lf
}

// ============================================================
// 替换逻辑
// ============================================================

/**
 * 将 content 中的 logo 导出替换为 newLogoBlock
 * 支持：
 *   - 对象格式：export const logo = { ... }
 *   - 模板字面量：export const logo = `...`
 *   - 字符串字面量：export const logo = "..."
 * 返回替换后的文件内容；若未找到任何模式则返回 null
 */
function replaceLogo(content: string, newLogoBlock: string): string | null {
  // 对象格式（当前上游）：{ 内不含 }，匹配跨行
  const objectPat = /export\s+const\s+(logo|LOGO)\s*=\s*\{[^}]*\}/s
  if (objectPat.test(content)) {
    return content.replace(objectPat, newLogoBlock)
  }

  // 模板字面量格式
  const tplPat = /export\s+const\s+(logo|LOGO)\s*=\s*`[^`]*`/s
  if (tplPat.test(content)) {
    return content.replace(tplPat, newLogoBlock)
  }

  // 单/双引号字符串格式
  const strPat = /export\s+const\s+(logo|LOGO)\s*=\s*["'][^"']*["']/
  if (strPat.test(content)) {
    return content.replace(strPat, newLogoBlock)
  }

  return null
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const cfg = await loadProduction()
  const assets = cfg.assets ?? ({} as any)
  const bannerPath = assets.banner
    ? path.join(projectRoot(), assets.banner)
    : null

  const logoFile = path.join(upstreamDir(), "packages/opencode/src/cli/logo.ts")
  if (!existsSync(logoFile)) {
    log("warn", "logo.ts 不存在，跳过 banner 注入")
    return
  }

  const content = await Bun.file(logoFile).text()

  // ── 情形 A：使用自定义 banner 文件 ──────────────────────────
  if (bannerPath && existsSync(bannerPath)) {
    const bannerRaw = await Bun.file(bannerPath).text()

    // 转义 banner 内容为 JS 模板字符串（保留 ANSI \x1b）
    const escaped = bannerRaw
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$/g, "\\$")
      .replace(/\\\\x1b/g, "\\x1b")

    const logoBlock = "export const logo = `" + escaped + "`"
    const newContent = replaceLogo(content, logoBlock)
    if (newContent === null) {
      log("warn", "未找到可替换的 logo 导出模式，跳过 banner 注入")
      return
    }

    await Bun.write(logoFile, normalizeLineEndings(newContent, content))
    log("success", `banner 已替换（来源：${assets.banner}）`)

    if (isVerbose()) {
      log("dim", `目标文件: ${logoFile}`)
      log("dim", `Banner 源: ${bannerPath}`)
      log("dim", `=== Banner 内容预览 (${bannerRaw.split("\n").length} 行) ===`)
      log("dim", bannerRaw.slice(0, 300) + (bannerRaw.length > 300 ? "..." : ""))
    }
    return
  }

  // ── 情形 B：未配置 banner 文件 → 生成默认方框 banner ────────
  if (bannerPath && !existsSync(bannerPath)) {
    log("warn", `banner 文件不存在: ${assets.banner}，使用默认生成 banner`)
  } else {
    verboseLog("未配置 assets.banner，使用默认生成 banner")
  }

  const logoBlock = generateDefaultLogo(cfg.productNameDisplay)
  const newContent = replaceLogo(content, logoBlock)
  if (newContent === null) {
    log("warn", "未找到可替换的 logo 导出模式，跳过默认 banner 生成")
    return
  }

  await Bun.write(logoFile, normalizeLineEndings(newContent, content))
  log("success", `默认 banner 已生成（productNameDisplay: ${cfg.productNameDisplay}）`)

  if (isVerbose()) {
    log("dim", `目标文件: ${logoFile}`)
    log("dim", `=== 生成的 logo 内容 ===`)
    log("dim", logoBlock)
    log("dim", "========================")
  }
}

main().catch((e) => {
  log("error", String(e))
  process.exit(1)
})

