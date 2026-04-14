/**
 * apply-paths.ts — 全局路径注入
 *
 * 目标文件：upstream/packages/opencode/src/global/index.ts
 * 当 production.jsonc 中 paths.* 存在非 null 字段时，注入运行时路径展开代码
 */

import path from "node:path"
import { existsSync } from "node:fs"
import { loadProduction, upstreamDir, log, isVerbose, verboseLog } from "./_utils"

async function main() {
  const cfg = await loadProduction()
  const paths = cfg.paths ?? {}

  // 检查是否有非 null 路径配置
  const entries = Object.entries(paths).filter(([, v]) => v !== null && v !== undefined)
  if (entries.length === 0) {
    log("info", "paths 全部为 null，跳过路径注入（步骤 6 已替换字符串）")
    return
  }

  const targetFile = path.join(upstreamDir(), "packages/opencode/src/global/index.ts")
  if (!existsSync(targetFile)) {
    log("warn", `目标文件不存在: packages/opencode/src/global/index.ts，跳过`)
    return
  }

  const content = await Bun.file(targetFile).text()

  const envPrefix = cfg.productNameUpper
  const rawDefaults = cfg.envDefaults ?? {}

  const sharedDefaults: Record<string, string> = {}
  const win32Defaults: Record<string, string> = {}
  const linuxDefaults: Record<string, string> = {}
  const darwinDefaults: Record<string, string> = {}

  for (const [k, v] of Object.entries(rawDefaults)) {
    if (typeof v === "string") {
      sharedDefaults[k] = v
      continue
    }
    if (v && typeof v === "object") {
      if (typeof v.windows === "string") win32Defaults[k] = v.windows
      if (typeof v.linux === "string") linuxDefaults[k] = v.linux
      if (typeof v.macos === "string") darwinDefaults[k] = v.macos
    }
  }

  // 生成路径赋值语句
  // ⚠️ 在 global/index.ts 中 Path 导出为 Global.Path（namespace），必须使用完整引用
  const assignments: string[] = []
  const hasData = paths.data !== null && paths.data !== undefined
  const hasCache = paths.cache !== null && paths.cache !== undefined

  for (const [key, tpl] of entries) {
    assignments.push(`  Global.Path.${key} = _expandEnvPath(${JSON.stringify(tpl)}, Global.Path.${key})`)
  }

  // ⚠️ 如果 data 被覆盖 → 同步重算 Path.log
  if (hasData) {
    assignments.push(`  Global.Path.log = path.join(Global.Path.data, "log")`)
  }
  // ⚠️ 如果 cache 被覆盖 → 同步重算 Path.bin
  if (hasCache) {
    assignments.push(`  Global.Path.bin = path.join(Global.Path.cache, "bin")`)
  }

  // 将各平台 defaults 序列化嵌入注入代码（构建期固化，无运行时依赖）
  const ser = (o: Record<string, string>) =>
    JSON.stringify(o, null, 2).split("\n").map((l, i) => (i === 0 ? l : `  ${l}`)).join("\n")

  // ⚠️ 保持原文件换行风格
  const eol = content.includes("\r\n") ? "\r\n" : "\n"
  const injectionLf = `
// ===== 由 opencode-wrapper 注入 ===== @brand-keep
// 环境变量默认值（构建期固化自 production.jsonc envDefaults）
// 优先级：process.env > 变量级 OS 专属 defaults > 变量级共享 defaults > XDG fallback
const _envDefaultsByPlatform: Record<string, Record<string, string>> = {
  win32: ${ser(win32Defaults)},
  linux: ${ser(linuxDefaults)},
  darwin: ${ser(darwinDefaults)},
}
const _envDefaultsShared: Record<string, string> = ${ser(sharedDefaults)}
function _expandEnvPath(tpl: string, fallback: string): string {
  const _osDef = _envDefaultsByPlatform[process.platform] ?? {}
  let ok = true
  const r = tpl.replace(/\\$\\{([^}]+)\\}/g, (_, n) => {
    const v = process.env[n] || _osDef[n] || _envDefaultsShared[n]
    if (!v) { ok = false; return "" }
    return v
  })
  return ok && r !== "" ? r : fallback
}
// ⚠️ ${envPrefix}_CUSTOM_PATHS=0 可绕过
if (process.env.${envPrefix}_CUSTOM_PATHS !== "0") {
${assignments.join("\n")}
}
// ===== 注入结束 =====
`
  const injection = injectionLf.replace(/\n/g, eol)

  const existingBlockPattern = new RegExp(
    `${eol === "\r\n" ? "\\r\\n" : "\\n"}?// ===== 由 opencode-wrapper 注入 ===== @brand-keep[\\s\\S]*?// ===== 注入结束 =====${eol === "\r\n" ? "\\r\\n?" : "\\n?"}`,
  )
  const contentWithoutOldInjection = content.replace(existingBlockPattern, eol)

  const initAnchor = `${eol}await Promise.all([`
  const anchorIdx = contentWithoutOldInjection.indexOf(initAnchor)
  const newContent = anchorIdx === -1
    ? contentWithoutOldInjection + eol + injection
    : contentWithoutOldInjection.slice(0, anchorIdx) + eol + injection + contentWithoutOldInjection.slice(anchorIdx)

  await Bun.write(targetFile, newContent)
  log("success", `路径注入完成：${entries.length} 个路径覆盖 + ${(hasData ? 1 : 0) + (hasCache ? 1 : 0)} 个派生路径同步`)
  if (isVerbose()) {
    log("dim", `=== 注入目标文件: ${targetFile} ==`)
    log("dim", "=== 注入内容开始 ===")
    log("dim", injectionLf)
    log("dim", "=== 注入内容结束 ===")
    log("dim", `路径模板: ${entries.map(([k, v]) => `${k}=${v}`).join(", ")}`)
    log("dim", `支持的平台: win32=${Object.keys(win32Defaults).join(",") || "无"}, linux=${Object.keys(linuxDefaults).join(",") || "无"}, darwin=${Object.keys(darwinDefaults).join(",") || "无"}`)
  }
}

main().catch((e) => {
  log("error", String(e))
  process.exit(1)
})
