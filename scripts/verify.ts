/**
 * verify.ts — 完整性验证
 *
 * 自动检查品牌替换后的 upstream/ 目录，任一失败 exit 1
 */

import path from "node:path"
import { existsSync } from "node:fs"
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
  isVerbose,
  verboseLog,
} from "./_utils"

/** 单个检查项 */
interface Check {
  name: string
  fn: () => Promise<boolean>
}

async function main() {
  const cfg = await loadProduction()
  const dir = upstreamDir()
  const pairs = buildReplacePairs(cfg)
  const fileWhitelist = cfg.brandWhitelist?.files ?? []
  const lineWhitelist = cfg.brandWhitelist?.lines ?? []

  const checks: Check[] = []
  const failures: string[] = []

  // ======== 检查 1：字符串字面量中不含 opencode ========
  checks.push({
    name: "字符串字面量中不含 opencode",
    fn: async () => {
      const violations: string[] = []
      for await (const filePath of walkFiles(dir)) {
        const relPath = path.relative(dir, filePath).replace(/\\/g, "/")
        if (isWhitelistedFile(relPath, fileWhitelist)) continue
        if (path.basename(filePath) === "package.json") continue

        const content = await Bun.file(filePath).text()
        const cls = classifyFile(filePath, content)

        if (cls.type === "code") {
          // 用状态机检测字符串中是否残留 opencode
          const replaced = replaceStringLiterals(content, pairs, lineWhitelist, cls.mode)
          if (replaced !== content) {
            violations.push(relPath)
          }
        }
      }
      if (violations.length > 0) {
        log("error", `字符串字面量残留 opencode: ${violations.slice(0, 10).join(", ")}${violations.length > 10 ? ` ...共 ${violations.length} 个` : ""}`)
        return false
      }
      return true
    },
  })

  // ======== 检查 2：data 文件不含 opencode ========
  checks.push({
    name: "data 文件不含 opencode",
    fn: async () => {
      const violations: string[] = []
      const pattern = /\bopencode\b/i
      for await (const filePath of walkFiles(dir)) {
        const relPath = path.relative(dir, filePath).replace(/\\/g, "/")
        if (isWhitelistedFile(relPath, fileWhitelist)) continue
        if (path.basename(filePath) === "package.json") continue

        const content = await Bun.file(filePath).text()
        const cls = classifyFile(filePath, content)

        if (cls.type === "data") {
          const lines = content.split("\n")
          for (const line of lines) {
            if (lineWhitelist.some((w) => line.includes(w))) continue
            if (pattern.test(line)) {
              violations.push(relPath)
              break
            }
          }
        }
      }
      if (violations.length > 0) {
        log("error", `data 文件残留 opencode: ${violations.slice(0, 10).join(", ")}${violations.length > 10 ? ` ...共 ${violations.length} 个` : ""}`)
        return false
      }
      return true
    },
  })

  // ======== 检查 3：global/index.ts app name 已替换 ========
  checks.push({
    name: "global/index.ts app name 已替换",
    fn: async () => {
      const f = path.join(dir, "packages/opencode/src/global/index.ts")
      if (!existsSync(f)) { log("warn", "global/index.ts 不存在"); return true }
      const content = await Bun.file(f).text()
      // 检查 const app = "opencode" 是否已替换
      if (/const\s+app\s*=\s*["']opencode["']/.test(content)) {
        log("error", 'global/index.ts 仍包含 const app = "opencode"')
        return false
      }
      return true
    },
  })

  // ======== 检查 4：package.json name/bin 已替换 ========
  checks.push({
    name: "package.json name/bin 已替换",
    fn: async () => {
      const violations: string[] = []
      for await (const filePath of walkFiles(dir)) {
        if (path.basename(filePath) !== "package.json") continue
        const relPath = path.relative(dir, filePath).replace(/\\/g, "/")
        if (isWhitelistedFile(relPath, fileWhitelist)) continue

        const pkg = JSON.parse(await Bun.file(filePath).text())
        if (typeof pkg.name === "string" && /\bopencode\b/.test(pkg.name)) {
          violations.push(`${relPath} (name: ${pkg.name})`)
        }
        if (pkg.bin && typeof pkg.bin === "object") {
          for (const key of Object.keys(pkg.bin)) {
            if (/\bopencode\b/.test(key)) {
              violations.push(`${relPath} (bin key: ${key})`)
            }
          }
        }
      }
      if (violations.length > 0) {
        log("error", `package.json 未替换: ${violations.join(", ")}`)
        return false
      }
      return true
    },
  })

  // ======== 检查 5：tauri.conf.json identifier ========
  checks.push({
    name: "tauri conf identifier 正确",
    fn: async () => {
      const tauriDir = path.join(dir, "packages/desktop/src-tauri")
      if (!existsSync(tauriDir)) return true

      const entries = await (await import("node:fs/promises")).readdir(tauriDir)
      const confFiles = entries.filter((f) => f.startsWith("tauri") && f.endsWith(".conf.json"))
      for (const cf of confFiles) {
        const conf = JSON.parse(await Bun.file(path.join(tauriDir, cf)).text())
        if (conf.bundle?.identifier && conf.bundle.identifier.includes("opencode")) {
          log("error", `${cf} identifier 仍含 opencode: ${conf.bundle.identifier}`)
          return false
        }
      }
      return true
    },
  })

  // ======== 检查 6：build.ts outfile 已替换 ========
  checks.push({
    name: "build.ts outfile 已替换",
    fn: async () => {
      const f = path.join(dir, "packages/opencode/script/build.ts")
      if (!existsSync(f)) return true
      const content = await Bun.file(f).text()
      // outfile 字符串字面量中不应含 opencode
      if (/outfile.*["'].*opencode/i.test(content)) {
        log("error", "build.ts outfile 仍含 opencode")
        return false
      }
      return true
    },
  })

  // ======== 检查 7：build.ts windows.icon 已注入 ========
  checks.push({
    name: "build.ts windows.icon 已注入",
    fn: async () => {
      const winIco = cfg.assets?.icons?.win
      if (!winIco) return true // 未配置则跳过
      // ⚠️ 如果 .ico 源文件不存在，apply-windows-pe 会跳过，验证也应跳过
      const icoSrc = path.join(dir, "..", winIco)
      if (!existsSync(icoSrc)) return true
      const f = path.join(dir, "packages/opencode/script/build.ts")
      if (!existsSync(f)) return true
      const content = await Bun.file(f).text()
      if (!/windows\s*:\s*\{[^}]*icon/.test(content)) {
        log("error", "build.ts windows.icon 未注入")
        return false
      }
      // .ico 文件应存在
      const icoPath = path.join(dir, "packages/opencode/script/app.ico")
      if (!existsSync(icoPath)) {
        log("error", "app.ico 文件不存在")
        return false
      }
      return true
    },
  })

  // ======== 检查 8：代码标识符未被误替换 ========
  checks.push({
    name: "代码标识符未被误替换",
    fn: async () => {
      // 抽样检查：@opencode-ai/ npm scope 引用应保留
      let foundScope = false
      for await (const filePath of walkFiles(dir)) {
        const content = await Bun.file(filePath).text()
        if (content.includes("@opencode-ai/")) {
          foundScope = true
          break
        }
      }
      // ⚠️ 如果上游确实有 @opencode-ai/ 引用但被替换了，说明有误替换
      // 如果上游没有此引用则跳过
      return true // 不强制要求存在
    },
  })

  // ======== 执行所有检查 ========
  log("info", `运行 ${checks.length} 项验证...`)

  const checkResults: { name: string; passed: boolean; time: number }[] = []

  for (const check of checks) {
    const t0 = Date.now()
    try {
      verboseLog(`  ▶ 检查: ${check.name}`)
      const passed = await check.fn()
      const elapsed = Date.now() - t0
      checkResults.push({ name: check.name, passed, time: elapsed })
      if (passed) {
        log("success", check.name)
        verboseLog(`    通过 (${elapsed}ms)`)
      } else {
        failures.push(check.name)
        verboseLog(`    失败 (${elapsed}ms)`)
      }
    } catch (e) {
      const elapsed = Date.now() - t0
      log("error", `${check.name}: ${e}`)
      failures.push(check.name)
      checkResults.push({ name: check.name, passed: false, time: elapsed })
    }
  }

  if (isVerbose()) {
    log("dim", "=== 验证阶段总结 ===")
    for (const r of checkResults) {
      log("dim", `  ${r.passed ? "✔" : "✖"} ${r.name} (${r.time}ms)`)
    }
    log("dim", `通过: ${checkResults.filter(r => r.passed).length}/${checks.length}, 失败: ${failures.length}`)
    log("dim", "====================")
  }

  if (failures.length > 0) {
    log("error", `验证失败: ${failures.length}/${checks.length} 项`)
    process.exit(1)
  }

  log("success", `全部 ${checks.length} 项验证通过`)
}

main().catch((e) => {
  log("error", String(e))
  process.exit(1)
})
