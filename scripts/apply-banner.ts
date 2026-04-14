/**
 * apply-banner.ts — TUI banner 替换
 *
 * 目标：upstream/packages/opencode/src/cli/logo.ts
 * 读取 assets/banner.txt，替换 logo 导出常量
 */

import path from "node:path"
import { existsSync } from "node:fs"
import { loadProduction, upstreamDir, log, projectRoot, isVerbose, verboseLog } from "./_utils"

async function main() {
  const cfg = await loadProduction()
  const assets = cfg.assets ?? ({} as any)
  const bannerPath = assets.banner
    ? path.join(projectRoot(), assets.banner)
    : null

  if (!bannerPath || !existsSync(bannerPath)) {
    log("info", "未配置 banner 或文件不存在，跳过")
    return
  }

  const logoFile = path.join(
    upstreamDir(),
    "packages/opencode/src/cli/logo.ts",
  )
  if (!existsSync(logoFile)) {
    log("warn", "logo.ts 不存在，跳过 banner 注入")
    return
  }

  const bannerRaw = await Bun.file(bannerPath).text()
  const content = await Bun.file(logoFile).text()

  // 手动转义 banner 内容为 JS 字符串，保留 ANSI 转义序列（\x1b）
  const escapedBanner = bannerRaw
    .replace(/\\/g, "\\\\")           // 先转义反斜杠
    .replace(/`/g, "\\`")             // 转义模板字面量的反引号
    .replace(/\$/g, "\\$")            // 转义 $ 避免模板表达式
    .replace(/\\\\x1b/g, "\\x1b")    // ⚠️ 恢复 ANSI 转义序列

  // 查找并替换 logo 常量
  // 常见模式：export const logo = `...` 或 export const LOGO = `...`
  const logoPattern = /export\s+const\s+(logo|LOGO)\s*=\s*`[^`]*`/s
  if (logoPattern.test(content)) {
    const newContent = content.replace(
      logoPattern,
      `export const $1 = \`${escapedBanner}\``,
    )
    await Bun.write(logoFile, newContent)
    log("success", "banner 已替换")
    if (isVerbose()) {
      log("dim", `目标文件: ${logoFile}`)
      log("dim", `Banner 源: ${bannerPath}`)
      log("dim", `=== Banner 内容预览 (${bannerRaw.split("\n").length} 行) ==`)
      log("dim", bannerRaw.slice(0, 300) + (bannerRaw.length > 300 ? "..." : ""))
    }
    return
  }

  // 尝试双引号/单引号字符串形式
  const logoPatternStr = /export\s+const\s+(logo|LOGO)\s*=\s*["'][^"']*["']/
  if (logoPatternStr.test(content)) {
    const newContent = content.replace(
      logoPatternStr,
      `export const $1 = \`${escapedBanner}\``,
    )
    await Bun.write(logoFile, newContent)
    log("success", "banner 已替换")
    verboseLog(`目标文件: ${logoFile}`)
    return
  }

  log("warn", "未找到可替换的 logo 常量导出模式")
}

main().catch((e) => {
  log("error", String(e))
  process.exit(1)
})
