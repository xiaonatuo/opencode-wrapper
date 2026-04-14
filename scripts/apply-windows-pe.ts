/**
 * apply-windows-pe.ts — Windows PE 图标注入
 *
 * 目标文件：upstream/packages/opencode/script/build.ts
 * 将 windows: {} → windows: { icon: "./script/app.ico" }
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

  // 修改 build.ts：windows: {} → windows: { icon: "./script/app.ico" }
  const content = await Bun.file(buildTsPath).text()

  // ⚠️ 匹配 windows: {} 或 windows: { } 等空对象形式
  const windowsPattern = /windows\s*:\s*\{\s*\}/
  if (!windowsPattern.test(content)) {
    // 检查是否已有 icon 字段
    if (/windows\s*:\s*\{[^}]*icon/.test(content)) {
      log("info", "windows.icon 已存在，跳过")
      return
    }
    log("warn", "未找到 windows: {} 模式，跳过 PE 图标注入")
    return
  }

  const newContent = content.replace(
    windowsPattern,
    'windows: { icon: "./script/app.ico" }',
  )

  await Bun.write(buildTsPath, newContent)
  log("success", "Windows PE 图标已注入 build.ts")
  verboseLog(`修改内容: windows: {} → windows: { icon: "./script/app.ico" }`)
  verboseLog(`目标文件: ${buildTsPath}`)
}

main().catch((e) => {
  log("error", String(e))
  process.exit(1)
})
