/**
 * apply-icons.ts — 图标覆盖
 *
 * 8.1 Tauri：覆盖 icons/prod/ + 修改所有 tauri*.conf.json
 * 8.2 Electron：覆盖 resources/ + 修改 electron-builder.config.ts
 */

import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import {
  loadProduction,
  upstreamDir,
  log,
  replaceStringLiterals,
  buildReplacePairs,
} from "./_utils"

async function main() {
  const cfg = await loadProduction()
  const dir = upstreamDir()
  const assets = cfg.assets ?? ({} as any)
  const icons = assets.icons ?? ({} as any)

  // ============================================================
  // 8.1 Tauri
  // ============================================================
  const tauriSrcDir = path.join(dir, "packages/desktop/src-tauri")

  if (icons.tauri && existsSync(path.join(import.meta.dir, "..", icons.tauri))) {
    const srcDir = path.join(import.meta.dir, "..", icons.tauri)
    const destDir = path.join(tauriSrcDir, "icons/prod")

    log("info", "覆盖 Tauri 图标...")
    await fs.cp(srcDir, destDir, { recursive: true, force: true })
    log("success", "Tauri 图标已覆盖")
  } else if (icons.tauri) {
    log("warn", `Tauri 图标目录不存在: ${icons.tauri}，跳过`)
  }

  // 修改 tauri*.conf.json
  if (existsSync(tauriSrcDir)) {
    const entries = await fs.readdir(tauriSrcDir)
    const confFiles = entries.filter(
      (f) => f.startsWith("tauri") && f.endsWith(".conf.json"),
    )

    for (const confFile of confFiles) {
      const confPath = path.join(tauriSrcDir, confFile)
      try {
        const raw = await Bun.file(confPath).text()
        const conf = JSON.parse(raw)

        let modified = false

        // bundle.identifier
        if (conf.bundle?.identifier) {
          conf.bundle.identifier = cfg.desktopAppId
          modified = true
        }

        // productName
        if (conf.productName !== undefined) {
          conf.productName = cfg.productNameDisplay
          modified = true
        }

        // app.security.dangerousRemoteUrlSchemes / URL schemes
        if (conf.app?.security?.dangerousRemoteUrlSchemes) {
          conf.app.security.dangerousRemoteUrlSchemes =
            conf.app.security.dangerousRemoteUrlSchemes.map((s: string) =>
              s.replace(/\bopencode\b/g, cfg.urlScheme),
            )
          modified = true
        }

        if (modified) {
          await Bun.write(confPath, JSON.stringify(conf, null, 2) + "\n")
          log("dim", `  已修改 ${confFile}`)
        }
      } catch (e) {
        log("warn", `解析 ${confFile} 失败: ${e}`)
      }
    }
  }

  // ============================================================
  // 8.2 Electron
  // ============================================================
  const electronDir = path.join(dir, "packages/desktop-electron")

  if (icons.electron && existsSync(path.join(import.meta.dir, "..", icons.electron))) {
    const srcDir = path.join(import.meta.dir, "..", icons.electron)
    const destDir = path.join(electronDir, "resources")

    log("info", "覆盖 Electron 图标...")
    await fs.cp(srcDir, destDir, { recursive: true, force: true })
    log("success", "Electron 图标已覆盖")
  } else if (icons.electron) {
    log("warn", `Electron 图标目录不存在: ${icons.electron}，跳过`)
  }

  // 修改 electron-builder.config.ts
  const ebConfigPath = path.join(electronDir, "electron-builder.config.ts")
  if (existsSync(ebConfigPath)) {
    const pairs = buildReplacePairs(cfg)
    const content = await Bun.file(ebConfigPath).text()
    const newContent = replaceStringLiterals(
      content,
      pairs,
      cfg.brandWhitelist?.lines ?? [],
      "js",
    )
    if (newContent !== content) {
      await Bun.write(ebConfigPath, newContent)
      log("dim", "  已修改 electron-builder.config.ts")
    }
  }

  log("success", "图标覆盖完成")
}

main().catch((e) => {
  log("error", String(e))
  process.exit(1)
})
