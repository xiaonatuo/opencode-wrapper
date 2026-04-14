/**
 * migrate-config.ts — 迁移补丁注入
 *
 * 在 upstream/packages/opencode/src/index.ts 注入运行时迁移代码
 * 将旧品牌（opencode）的配置/数据/缓存目录迁移到新品牌目录
 */

import path from "node:path"
import { existsSync } from "node:fs"
import { loadProduction, upstreamDir, log, isVerbose, verboseLog } from "./_utils"

async function main() {
  const cfg = await loadProduction()
  const dir = upstreamDir()

  const targetFile = path.join(dir, "packages/opencode/src/index.ts")
  if (!existsSync(targetFile)) {
    log("warn", "upstream src/index.ts 不存在，跳过迁移补丁注入")
    return
  }

  const content = await Bun.file(targetFile).text()

  // ⚠️ 幂等检查：已注入则跳过
  if (content.includes("_wrapperMigrate")) {
    log("info", "迁移补丁已存在，跳过（幂等）")
    return
  }

  // 旧品牌名用于推导旧路径
  const oldName = "opencode"
  const newName = cfg.productName

  // 如果新旧相同则无需迁移
  if (oldName === newName) {
    log("info", "品牌名与上游一致，跳过迁移补丁")
    return
  }

  const migrationCode = `
// ===== 由 opencode-wrapper 注入：迁移补丁 ===== @brand-keep
import _migratePath from "node:path"
import _migrateFs from "node:fs"

;(function _wrapperMigrate() {
  const oldBrand = ${JSON.stringify(oldName)} // @brand-keep
  const newBrand = ${JSON.stringify(newName)}
  const lockName = "migration.lock"

  // 推导 XDG 风格路径（跨平台）
  function _xdgPaths(brand: string) {
    const home = process.env.HOME || process.env.USERPROFILE || ""
    const platform = process.platform

    let data: string, cache: string, config: string, state: string
    if (platform === "darwin") {
      data = _migratePath.join(home, "Library/Application Support", brand)
      cache = _migratePath.join(home, "Library/Caches", brand)
      config = _migratePath.join(home, ".config", brand)
      state = _migratePath.join(home, ".local/state", brand)
    } else if (platform === "win32") {
      const appData = process.env.APPDATA || _migratePath.join(home, "AppData/Roaming")
      const localAppData = process.env.LOCALAPPDATA || _migratePath.join(home, "AppData/Local")
      data = _migratePath.join(appData, brand)
      cache = _migratePath.join(localAppData, brand)
      config = _migratePath.join(appData, brand)
      state = _migratePath.join(localAppData, brand)
    } else {
      data = _migratePath.join(process.env.XDG_DATA_HOME || _migratePath.join(home, ".local/share"), brand)
      cache = _migratePath.join(process.env.XDG_CACHE_HOME || _migratePath.join(home, ".cache"), brand)
      config = _migratePath.join(process.env.XDG_CONFIG_HOME || _migratePath.join(home, ".config"), brand)
      state = _migratePath.join(process.env.XDG_STATE_HOME || _migratePath.join(home, ".local/state"), brand)
    }
    return { data, cache, config, state }
  }

  const oldPaths = _xdgPaths(oldBrand)
  const newPaths = _xdgPaths(newBrand)

  // 迁移任务列表
  type MigrationItem = { src: string; dest: string; label: string }
  const items: MigrationItem[] = []

  // 1. 全局数据/缓存/配置/状态目录
  for (const key of ["data", "cache", "config", "state"] as const) {
    items.push({ src: oldPaths[key], dest: newPaths[key], label: key + " 目录" })
  }

  // 2. 派生路径（log/bin）
  items.push({ src: _migratePath.join(oldPaths.data, "log"), dest: _migratePath.join(newPaths.data, "log"), label: "log 目录" })
  items.push({ src: _migratePath.join(oldPaths.cache, "bin"), dest: _migratePath.join(newPaths.cache, "bin"), label: "bin 目录" })

  // 3. 配置文件名迁移（在 config 目录中）
  const configFileNames = [
    [oldBrand + ".json",  newBrand + ".json"],
    [oldBrand + ".jsonc", newBrand + ".jsonc"],
    ["config.json",       "config.json"],  // 通用名称不变
  ]
  for (const [oldFile, newFile] of configFileNames) {
    items.push({
      src: _migratePath.join(oldPaths.config, oldFile),
      dest: _migratePath.join(newPaths.config, newFile),
      label: "配置文件 " + oldFile,
    })
  }

  // 4. 项目级隐藏目录 @brand-keep
  // 从 CWD 检测
  const cwdOldDir = _migratePath.join(process.cwd(), "." + oldBrand)
  const cwdNewDir = _migratePath.join(process.cwd(), "." + newBrand)
  items.push({ src: cwdOldDir, dest: cwdNewDir, label: "项目级隐藏目录" })

  // 5. managed config 目录中的旧品牌配置文件 @brand-keep
  if (process.platform === "darwin") {
    items.push({
      src: "/Library/Application Support/" + oldBrand,
      dest: "/Library/Application Support/" + newBrand,
      label: "macOS 系统级配置",
    })
  } else if (process.platform !== "win32") {
    items.push({
      src: "/etc/" + oldBrand,
      dest: "/etc/" + newBrand,
      label: "Linux 系统级配置",
    })
  }

  // 检查 lock
  const lockPath = _migratePath.join(newPaths.config, lockName)
  if (_migrateFs.existsSync(lockPath)) return // 已迁移

  let migrated = 0
  for (const item of items) {
    try {
      if (!_migrateFs.existsSync(item.src)) continue
      if (_migrateFs.existsSync(item.dest)) continue // ⚠️ 目标已存在，不覆盖

      const stat = _migrateFs.statSync(item.src)
      if (stat.isDirectory()) {
        _migrateFs.cpSync(item.src, item.dest, { recursive: true })
      } else {
        // 确保目标目录存在
        _migrateFs.mkdirSync(_migratePath.dirname(item.dest), { recursive: true })
        _migrateFs.copyFileSync(item.src, item.dest)
      }
      migrated++
    } catch {
      // 迁移失败不阻塞启动
    }
  }

  if (migrated > 0) {
    try {
      _migrateFs.mkdirSync(_migratePath.dirname(lockPath), { recursive: true })
      _migrateFs.writeFileSync(lockPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        from: oldBrand,
        to: newBrand,
        itemsMigrated: migrated,
      }, null, 2))
    } catch {
      // lock 写入失败不阻塞
    }
  }
})()
// ===== 迁移补丁注入结束 =====
`

  // 在文件顶部（import 之后）注入
  // 找到最后一个顶层 import 语句后插入
  // ⚠️ 保持原文件换行风格
  const eol = content.includes("\r\n") ? "\r\n" : "\n"
  const normalizedMigration = migrationCode.replace(/\n/g, eol)
  const lines = content.split(eol)
  let lastImportIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import\s/.test(lines[i])) {
      lastImportIdx = i
    }
    // 跳过 import block 后的空行
    if (lastImportIdx >= 0 && i > lastImportIdx + 5) break
  }

  const insertIdx = lastImportIdx >= 0 ? lastImportIdx + 1 : 0
  lines.splice(insertIdx, 0, normalizedMigration)

  await Bun.write(targetFile, lines.join(eol))
  log("success", "迁移补丁已注入 src/index.ts")
  if (isVerbose()) {
    log("dim", `目标文件: ${targetFile}`)
    log("dim", `迁移任务数: items (根据运行时实际路径计算)`)
    log("dim", `旧品牌: ${oldName} → 新品牌: ${newName}`)
    log("dim", "=== 注入代码预览 (300 字符) ===")
    log("dim", migrationCode.slice(0, 300) + (migrationCode.length > 300 ? "..." : ""))
    log("dim", "=== 预览结束 ===")
  }
}

main().catch((e) => {
  log("error", String(e))
  process.exit(1)
})
