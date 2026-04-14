/**
 * build.ts — 主编排脚本
 *
 * 串行执行：fetch-upstream → apply-brand → apply-paths → apply-icons
 *   → apply-windows-pe → apply-banner → migrate-config → apply-build-targets
 *   → [upstream bun build] → [复制产物到 dist/]
 *
 * CLI flags：
 *   --skip-fetch    跳过上游拉取
 *   --brand-only    仅执行品牌替换（不构建）
 *   --verify        构建后运行验证
 *   --verbose       输出所有阶段的详细日志
 */

import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { loadProduction, upstreamDir, exec, log, isVerbose, verboseLog, projectRoot } from "./_utils"

const BUN = process.execPath

interface BuildFlags {
  skipFetch: boolean
  brandOnly: boolean
  verify: boolean
  verbose: boolean
}

function parseFlags(): BuildFlags {
  const args = process.argv.slice(2)
  return {
    skipFetch: args.includes("--skip-fetch"),
    brandOnly: args.includes("--brand-only"),
    verify: args.includes("--verify"),
    verbose: args.includes("--verbose"),
  }
}

async function main() {
  const flags = parseFlags()
  const cfg = await loadProduction()
  const startTime = Date.now()

  // 将 verbose 标志透传给所有子脚本
  const verboseEnv: Record<string, string> = flags.verbose ? { WRAPPER_VERBOSE: "1" } : {}

  /** 执行子脚本，自动透传 verbose 环境变量 */
  async function runScript(name: string, extraEnv?: Record<string, string>): Promise<void> {
    const scriptPath = path.join(import.meta.dir, name)
    const stageStart = Date.now()
    log("info", `=== 执行 ${name} ===`)

    const result = await exec([BUN, "run", scriptPath], {
      env: { ...verboseEnv, ...extraEnv },
    })

    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)

    if (result.exitCode !== 0) {
      throw new Error(`${name} 失败 (exit ${result.exitCode})`)
    }

    if (flags.verbose) {
      const elapsed = ((Date.now() - stageStart) / 1000).toFixed(1)
      log("dim", `▶ ${name} 完成 (${elapsed}s)`)
    }
  }

  log("info", `开始构建 ${cfg.productNameDisplay}...`)
  if (flags.verbose) {
    log("dim", `verbose 模式已启用，所有阶段将输出详细日志`)
    if (cfg.buildTargets?.length) {
      log("dim", `构建目标 (${cfg.buildTargets.length} 个): ${cfg.buildTargets.map(t =>
        [t.os, t.arch, t.abi, t.avx2 === false ? "baseline" : undefined].filter(Boolean).join("-")
      ).join(", ")}`)
    }
  }

  // ─── 1. 上游拉取 ───────────────────────────────────────────
  if (!flags.skipFetch) {
    await runScript("fetch-upstream.ts")
  } else {
    log("dim", "跳过上游拉取 (--skip-fetch)")
  }

  // ─── 2. 品牌替换 ──────────────────────────────────────────
  await runScript("apply-brand.ts")

  // ─── 3. 路径注入 ──────────────────────────────────────────
  await runScript("apply-paths.ts")

  // ─── 4. 图标覆盖 ──────────────────────────────────────────
  await runScript("apply-icons.ts")

  // ─── 5. Windows PE 图标 ───────────────────────────────────
  await runScript("apply-windows-pe.ts")

  // ─── 6. Banner ───────────────────────────────────────────
  await runScript("apply-banner.ts")

  // ─── 7. 迁移补丁 ─────────────────────────────────────────
  await runScript("migrate-config.ts")

  // ─── 8. 构建目标注入 ──────────────────────────────────────
  await runScript("apply-build-targets.ts")

  if (flags.brandOnly) {
    log("success", "品牌处理完成 (--brand-only)")
    return
  }

  // ─── 9. 清理根目录 dist/ ─────────────────────────────────
  const distRoot = path.join(projectRoot(), "dist")
  log("info", "清理构建输出目录 dist/ ...")
  await fs.rm(distRoot, { recursive: true, force: true })
  verboseLog(`已删除: ${distRoot}`)

  // ─── 10. 调用上游构建 ────────────────────────────────────
  log("info", "=== 执行上游构建 ===")
  const upDir = upstreamDir()

  // 安装上游依赖
  if (existsSync(path.join(upDir, "package.json"))) {
    log("info", "安装上游依赖...")
    const install = await exec([BUN, "install", "--ignore-scripts"], { cwd: upDir })
    if (install.stdout) process.stdout.write(install.stdout)
    if (install.exitCode !== 0) {
      const fatalLines = install.stderr
        .split("\n")
        .filter((l) => l.includes("error:") && !l.includes("copyfile") && !l.includes("failed to link"))
      if (fatalLines.length > 0) {
        throw new Error(`上游 bun install 失败:\n${fatalLines.join("\n")}`)
      }
      log("warn", `bun install 有警告（已忽略）: ${install.stderr.slice(0, 200)}`)
    }

    // fix-node-pty 单独运行（忽略失败）
    const pkgOpencodeDir = path.join(upDir, "packages/opencode")
    if (existsSync(path.join(pkgOpencodeDir, "package.json"))) {
      log("dim", "运行 fix-node-pty...")
      const fixPty = await exec([BUN, "run", "fix-node-pty"], { cwd: pkgOpencodeDir })
      if (fixPty.exitCode !== 0) {
        log("warn", `fix-node-pty 失败（非致命，跳过）: ${fixPty.stderr.slice(0, 100)}`)
      }
    }
  }

  const pkgOpencodeDir = path.join(upDir, "packages/opencode")
  const buildTarget = existsSync(path.join(pkgOpencodeDir, "package.json"))
    ? pkgOpencodeDir
    : upDir

  // 将 buildTargets 序列化为 JSON 传给上游 build.ts
  const buildEnv: Record<string, string> = { ...verboseEnv }
  if (cfg.buildTargets?.length) {
    buildEnv.WRAPPER_BUILD_TARGETS_JSON = JSON.stringify(cfg.buildTargets)
    verboseLog(`WRAPPER_BUILD_TARGETS_JSON = ${buildEnv.WRAPPER_BUILD_TARGETS_JSON}`)
  }

  const buildArgs = [BUN, "run", "build"]
  log("dim", `执行构建: ${buildArgs.join(" ")} (cwd: packages/opencode)`)
  const buildStageStart = Date.now()

  // verbose 时实时流式输出，非 verbose 时缓冲后输出
  const build = await exec(buildArgs, {
    cwd: buildTarget,
    env: buildEnv,
    stream: flags.verbose,
  })
  if (!flags.verbose) {
    if (build.stdout) process.stdout.write(build.stdout)
    if (build.stderr) process.stderr.write(build.stderr)
  }
  if (build.exitCode !== 0) {
    throw new Error(`上游构建失败 (exit ${build.exitCode})`)
  }

  if (flags.verbose) {
    const elapsed = ((Date.now() - buildStageStart) / 1000).toFixed(1)
    log("dim", `▶ 上游构建完成 (${elapsed}s)`)
  }

  // ─── 11. 复制产物到项目根 dist/ ──────────────────────────
  const upstreamDist = path.join(buildTarget, "dist")
  if (existsSync(upstreamDist)) {
    log("info", `复制构建产物 → dist/ ...`)
    await copyDir(upstreamDist, distRoot, flags.verbose)
    log("success", `产物已复制到 dist/`)
  } else {
    log("warn", `上游 dist/ 不存在，跳过复制`)
  }

  // ─── 12. 验证 ────────────────────────────────────────────
  if (flags.verify) {
    await runScript("verify.ts")
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  log("success", `构建完成 (${elapsed}s)`)

  if (flags.verbose) {
    log("dim", "=== 构建总结 ===")
    log("dim", `产品名称: ${cfg.productNameDisplay}`)
    log("dim", `上游版本: ${cfg.upstreamRef}`)
    if (cfg.buildTargets?.length) {
      log("dim", `构建目标数: ${cfg.buildTargets.length}`)
    }
    log("dim", `总耗时: ${elapsed}s`)
    log("dim", `产物目录: dist/`)
    log("dim", "================")
  }
}

/** 递归复制目录 */
async function copyDir(src: string, dst: string, verbose: boolean): Promise<void> {
  await fs.mkdir(dst, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      await copyDir(srcPath, dstPath, verbose)
    } else {
      await fs.copyFile(srcPath, dstPath)
      if (verbose) verboseLog(`  复制: ${path.relative(dst, dstPath).replace(/\\/g, "/")}`)
    }
  }
}

main().catch((e) => {
  log("error", String(e))
  process.exit(1)
})

