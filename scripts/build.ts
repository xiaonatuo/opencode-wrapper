/**
 * build.ts — 主编排脚本
 *
 * 串行执行：fetch-upstream → apply-brand → apply-paths → apply-icons
 *   → apply-windows-pe → apply-banner → migrate-config → [upstream bun build]
 *
 * CLI flags：
 *   --skip-fetch    跳过上游拉取
 *   --brand-only    仅执行品牌替换（不构建）
 *   --verify        构建后运行验证
 *   --target=<os>   指定目标平台（win32|linux|darwin）
 */

import path from "node:path"
import { existsSync } from "node:fs"
import { loadProduction, upstreamDir, exec, log, projectRoot } from "./_utils"

const BUN = process.execPath

interface BuildFlags {
  skipFetch: boolean
  brandOnly: boolean
  verify: boolean
  target?: string
}

function parseFlags(): BuildFlags {
  const args = process.argv.slice(2)
  return {
    skipFetch: args.includes("--skip-fetch"),
    brandOnly: args.includes("--brand-only"),
    verify: args.includes("--verify"),
    target: args.find((a) => a.startsWith("--target="))?.split("=")[1],
  }
}

/** 执行子脚本 */
async function runScript(name: string): Promise<void> {
  const scriptPath = path.join(import.meta.dir, name)
  log("info", `=== 执行 ${name} ===`)
  const result = await exec([BUN, "run", scriptPath])

  // 将子脚本输出转发到当前 stdout/stderr
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)

  if (result.exitCode !== 0) {
    throw new Error(`${name} 失败 (exit ${result.exitCode})`)
  }
}

async function main() {
  const flags = parseFlags()
  const cfg = await loadProduction()
  const startTime = Date.now()

  log("info", `开始构建 ${cfg.productNameDisplay}...`)

  // 1. 上游拉取
  if (!flags.skipFetch) {
    await runScript("fetch-upstream.ts")
  } else {
    log("dim", "跳过上游拉取 (--skip-fetch)")
  }

  // 2. 品牌替换
  await runScript("apply-brand.ts")

  // 3. 路径注入
  await runScript("apply-paths.ts")

  // 4. 图标覆盖
  await runScript("apply-icons.ts")

  // 5. Windows PE 图标
  await runScript("apply-windows-pe.ts")

  // 6. Banner
  await runScript("apply-banner.ts")

  // 7. 迁移补丁
  await runScript("migrate-config.ts")

  if (flags.brandOnly) {
    log("success", "品牌处理完成 (--brand-only)")
    return
  }

  // 8. 调用上游构建
  log("info", "=== 执行上游构建 ===")
  const upDir = upstreamDir()

  // 安装上游依赖
  // ⚠️ --ignore-scripts 跳过 postinstall（fix-node-pty），避免 Windows copyfile ENOENT
  if (existsSync(path.join(upDir, "package.json"))) {
    log("info", "安装上游依赖...")
    const install = await exec([BUN, "install", "--ignore-scripts"], { cwd: upDir })
    if (install.stdout) process.stdout.write(install.stdout)
    if (install.exitCode !== 0) {
      // ⚠️ Windows 上 Bun 的 hardlink/copyfile 失败属于非致命警告
      const fatalLines = install.stderr
        .split("\n")
        .filter((l) => l.includes("error:") && !l.includes("copyfile") && !l.includes("failed to link"))
      if (fatalLines.length > 0) {
        throw new Error(`上游 bun install 失败:\n${fatalLines.join("\n")}`)
      }
      log("warn", `bun install 有警告（已忽略）: ${install.stderr.slice(0, 200)}`)
    }

    // fix-node-pty 单独运行（忽略失败，开发环境非必须）
    const pkgOpencodeDir = path.join(upDir, "packages/opencode")
    if (existsSync(path.join(pkgOpencodeDir, "package.json"))) {
      log("dim", "运行 fix-node-pty...")
      const fixPty = await exec([BUN, "run", "fix-node-pty"], { cwd: pkgOpencodeDir })
      if (fixPty.exitCode !== 0) {
        log("warn", `fix-node-pty 失败（非致命，跳过）: ${fixPty.stderr.slice(0, 100)}`)
      }
    }
  }

  // ⚠️ 实际构建在 packages/opencode/ 子包，根目录无 build 脚本
  const pkgOpencodeDir = path.join(upDir, "packages/opencode")
  const buildTarget = existsSync(path.join(pkgOpencodeDir, "package.json"))
    ? pkgOpencodeDir
    : upDir

  const buildArgs = [BUN, "run", "build"]
  if (flags.target) {
    buildArgs.push(`--target=${flags.target}`)
  }
  log("dim", `执行构建: ${buildArgs.join(" ")} (cwd: packages/opencode)`)
  const build = await exec(buildArgs, { cwd: buildTarget })
  if (build.stdout) process.stdout.write(build.stdout)
  if (build.stderr) process.stderr.write(build.stderr)
  if (build.exitCode !== 0) {
    throw new Error(`上游构建失败 (exit ${build.exitCode})`)
  }

  // 9. 验证
  if (flags.verify) {
    await runScript("verify.ts")
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  log("success", `构建完成 (${elapsed}s)`)
}

main().catch((e) => {
  log("error", String(e))
  process.exit(1)
})
