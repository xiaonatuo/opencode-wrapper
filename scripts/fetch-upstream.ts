/**
 * fetch-upstream.ts — 上游源码拉取（幂等）
 *
 * - 检查 .wrapper-stamp（ref + patchHash）判断是否需要重新拉取
 * - git clone --depth 1 + 可选 patches 应用
 */

import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import crypto from "node:crypto"
import { loadProduction, upstreamDir, exec, log, projectRoot } from "./_utils"

interface Stamp {
  ref: string
  timestamp: string
  patchHash: string
}

/** 计算 patches/ 目录所有 .patch 文件的综合摘要 */
async function computePatchHash(): Promise<string> {
  const patchDir = path.join(projectRoot(), "patches")
  if (!existsSync(patchDir)) return ""

  const entries = await fs.readdir(patchDir)
  const patches = entries.filter((f) => f.endsWith(".patch")).sort()
  if (patches.length === 0) return ""

  const hash = crypto.createHash("sha256")
  for (const p of patches) {
    const content = await Bun.file(path.join(patchDir, p)).text()
    hash.update(content)
  }
  return hash.digest("hex")
}

/** 判断 upstreamRef 是否为 40 位 hex SHA */
function isSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref)
}

async function main() {
  const cfg = await loadProduction()
  const dir = upstreamDir()
  const stampPath = path.join(dir, ".wrapper-stamp")

  const patchHash = await computePatchHash()

  // 检查 stamp 幂等
  if (existsSync(stampPath)) {
    try {
      const stamp: Stamp = JSON.parse(await Bun.file(stampPath).text())
      if (stamp.ref === cfg.upstreamRef && stamp.patchHash === patchHash) {
        log("success", `upstream 已是 ${cfg.upstreamRef}，无需拉取`)
        return
      }
      log("info", `stamp 不匹配（ref: ${stamp.ref} → ${cfg.upstreamRef}, patchHash: ${stamp.patchHash !== patchHash ? "changed" : "same"}）`)
    } catch {
      log("warn", ".wrapper-stamp 解析失败，重新拉取")
    }
  }

  // 清除旧目录
  if (existsSync(dir)) {
    log("info", "删除旧 upstream/ 目录...")
    // ⚠️ maxRetries 解决 Windows 文件锁
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }

  // clone
  if (isSha(cfg.upstreamRef)) {
    // SHA → clone 默认分支再 checkout
    log("info", `克隆 ${cfg.upstreamRepo} (SHA: ${cfg.upstreamRef.slice(0, 8)})...`)
    const clone = await exec(["git", "clone", "--depth", "1", cfg.upstreamRepo, dir])
    if (clone.exitCode !== 0) {
      throw new Error(`git clone 失败: ${clone.stderr}`)
    }
    const fetch = await exec(["git", "fetch", "--depth", "1", "origin", cfg.upstreamRef], { cwd: dir })
    if (fetch.exitCode !== 0) {
      throw new Error(`git fetch SHA 失败: ${fetch.stderr}`)
    }
    const checkout = await exec(["git", "checkout", cfg.upstreamRef], { cwd: dir })
    if (checkout.exitCode !== 0) {
      throw new Error(`git checkout 失败: ${checkout.stderr}`)
    }
  } else {
    // 分支/tag → --branch
    log("info", `克隆 ${cfg.upstreamRepo} (ref: ${cfg.upstreamRef})...`)
    const clone = await exec([
      "git", "clone", "--depth", "1", "--branch", cfg.upstreamRef,
      cfg.upstreamRepo, dir,
    ])
    if (clone.exitCode !== 0) {
      throw new Error(`git clone 失败: ${clone.stderr}`)
    }
  }

  // 应用 patches
  const patchDir = path.join(projectRoot(), "patches")
  if (existsSync(patchDir)) {
    const entries = await fs.readdir(patchDir)
    const patches = entries.filter((f) => f.endsWith(".patch")).sort()
    for (const p of patches) {
      log("info", `应用补丁: ${p}`)
      const apply = await exec(
        ["git", "apply", "--whitespace=fix", path.join(patchDir, p)],
        { cwd: dir },
      )
      if (apply.exitCode !== 0) {
        throw new Error(`补丁应用失败 (${p}): ${apply.stderr}`)
      }
    }
  }

  // 写入 stamp
  const stamp: Stamp = {
    ref: cfg.upstreamRef,
    timestamp: new Date().toISOString(),
    patchHash,
  }
  await Bun.write(stampPath, JSON.stringify(stamp, null, 2))
  log("success", `upstream 已更新至 ${cfg.upstreamRef}`)
}

main().catch((e) => {
  log("error", String(e))
  process.exit(1)
})
