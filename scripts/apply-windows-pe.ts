/**
 * apply-windows-pe.ts — Windows PE 图标注入
 *
 * 目标文件：upstream/packages/opencode/script/build.ts
 * 将 compile.windows 配置改为仅对 win32 目标生效：
 * ...(item.os === "win32" ? { windows: { icon: "./script/app.ico" } } : {})
 */

import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { loadProduction, upstreamDir, log, projectRoot, isVerbose, verboseLog } from "./_utils"

async function main() {
  const cfg = await loadProduction()
  const assets = cfg.assets ?? ({} as any)
  const icons = assets.icons ?? ({} as any)
  const winIcoSrc = icons.win

  if (!winIcoSrc) {
    log("info", "未配置 assets.icons.win，跳过 Windows PE 图标注入")
    return
  }

  const icoPath = path.join(projectRoot(), winIcoSrc)
  if (!existsSync(icoPath)) {
    log("warn", `ICO 文件不存在: ${winIcoSrc}，跳过`)
    return
  }

  const buildTsPath = path.join(
    upstreamDir(),
    "packages/opencode/script/build.ts",
  )
  if (!existsSync(buildTsPath)) {
    log("warn", "upstream build.ts 不存在，跳过")
    return
  }

  // 复制 .ico 到上游构建目录
  const destIco = path.join(
    upstreamDir(),
    "packages/opencode/script/app.ico",
  )
  await fs.copyFile(icoPath, destIco)
  log("dim", "  已复制 app.ico → upstream/packages/opencode/script/app.ico")

  // 修改 build.ts：仅在 win32 目标时注入 windows.icon，避免 linux/darwin 构建报错
  // 统一为 LF 处理，写回时恢复原始换行风格，避免 verify 误报
  const rawContent = await Bun.file(buildTsPath).text()
  const hasCRLF = rawContent.includes("\r\n")
  const content = hasCRLF ? rawContent.replace(/\r\n/g, "\n") : rawContent
  const displayNameLit = JSON.stringify(cfg.productNameDisplay)
  const conditionalWindows =
    `...(item.os === "win32" ? { windows: { icon: "./script/app.ico", title: ${displayNameLit}, description: ${displayNameLit}, publisher: ${displayNameLit} } } : {}),`

  // 兼容三种上游/历史注入形态：
  // 1) windows: {}
  // 2) windows: { icon: "./script/app.ico" }
  // 3) ...(item.os === "win32" ? { windows: { ... } } : {}),
  const emptyWindowsLine = /^(\s*)windows\s*:\s*\{\s*\}\s*,\s*$/m
  const plainIconWindowsLine =
    /^(\s*)windows\s*:\s*\{\s*icon\s*:\s*["']\.\/script\/app\.ico["']\s*\}\s*,\s*$/m
  const conditionalWindowsLine =
    /^(\s*)\.\.\.\(item\.os\s*===\s*["']win32["']\s*\?\s*\{\s*windows\s*:\s*\{.*\}\s*\}\s*:\s*\{\s*\}\s*\)\s*,\s*$/m

  let newContent = content
  if (emptyWindowsLine.test(content)) {
    newContent = content.replace(emptyWindowsLine, (_m, indent: string) => `${indent}${conditionalWindows}`)
  } else if (plainIconWindowsLine.test(content)) {
    newContent = content.replace(plainIconWindowsLine, (_m, indent: string) => `${indent}${conditionalWindows}`)
  } else if (conditionalWindowsLine.test(content)) {
    newContent = content.replace(conditionalWindowsLine, (_m, indent: string) => `${indent}${conditionalWindows}`)
  } else {
    log("warn", "未找到可替换的 compile.windows 配置，跳过 PE 图标注入")
    return
  }

  const finalContent = hasCRLF ? newContent.replace(/\n/g, "\r\n") : newContent

  if (finalContent === rawContent) {
    log("info", "windows 条件注入已是最新配置，跳过")
    return
  }

  await Bun.write(buildTsPath, finalContent)
  log("success", "Windows PE 图标条件注入已完成（仅 win32）")
  verboseLog(
    `修改内容: compile.windows → ${conditionalWindows.replace(/\s+/g, " ")}`,
  )
  verboseLog(`目标文件: ${buildTsPath}`)
}

main().catch((e) => {
  log("error", String(e))
  process.exit(1)
})
