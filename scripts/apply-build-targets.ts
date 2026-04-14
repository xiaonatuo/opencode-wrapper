/**
 * apply-build-targets.ts — 上游构建目标注入
 *
 * 在上游 packages/opencode/script/build.ts 中注入一段代码，
 * 使其在运行时读取 WRAPPER_BUILD_TARGETS_JSON 环境变量来筛选构建目标。
 * 若环境变量未设置，则保留上游原有的 --single / allTargets 逻辑。
 *
 * ⚠️ 幂等：检测到注入标记时跳过，防止重复注入
 */

import path from "node:path"
import { existsSync } from "node:fs"
import { upstreamDir, log, isVerbose, verboseLog } from "./_utils"

const INJECTION_MARKER = "// ===== opencode-wrapper buildTargets 注入 ====="
const INJECTION_END    = "// ===== buildTargets 注入结束 ====="

/**
 * 原始目标选择块（紧接在 allTargets 数组之后，不含品牌字符串，
 * 所以 apply-brand.ts 运行前后内容相同）
 */
const OLD_TARGETS_BLOCK =
`const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true
    })
  : allTargets`

const NEW_TARGETS_BLOCK =
`${INJECTION_MARKER}
const __wrapperTargetsJson = process.env.WRAPPER_BUILD_TARGETS_JSON
const targets = __wrapperTargetsJson
  ? (JSON.parse(__wrapperTargetsJson) as typeof allTargets)
  : singleFlag
    ? allTargets.filter((item) => {
        if (item.os !== process.platform || item.arch !== process.arch) {
          return false
        }

        // When building for the current platform, prefer a single native binary by default.
        // Baseline binaries require additional Bun artifacts and can be flaky to download.
        if (item.avx2 === false) {
          return baselineFlag
        }

        // also skip abi-specific builds for the same reason
        if (item.abi !== undefined) {
          return false
        }

        return true
      })
    : allTargets
${INJECTION_END}`

async function main() {
  const targetFile = path.join(upstreamDir(), "packages/opencode/script/build.ts")

  if (!existsSync(targetFile)) {
    log("warn", "上游 script/build.ts 不存在，跳过构建目标注入")
    return
  }

  const rawContent = await Bun.file(targetFile).text()

  // 统一转换为 LF 进行匹配和替换，最后恢复原始换行风格
  const hasCRLF = rawContent.includes("\r\n")
  const content = hasCRLF ? rawContent.replace(/\r\n/g, "\n") : rawContent

  // 幂等检查
  if (content.includes(INJECTION_MARKER)) {
    verboseLog("构建目标注入已存在，跳过（幂等）")
    log("success", "构建目标注入：已就绪（幂等跳过）")
    return
  }

  if (!content.includes(OLD_TARGETS_BLOCK)) {
    log("warn", [
      "未找到上游目标选择块，跳过注入。",
      "（可能上游版本已更新，请手动检查 script/build.ts）",
    ].join(" "))
    return
  }

  const patchedLF = content.replace(OLD_TARGETS_BLOCK, NEW_TARGETS_BLOCK)
  const newContent = hasCRLF ? patchedLF.replace(/\n/g, "\r\n") : patchedLF
  await Bun.write(targetFile, newContent)

  if (isVerbose()) {
    log("dim", "=== 注入内容（构建目标覆盖）===")
    log("dim", NEW_TARGETS_BLOCK)
    log("dim", "=== 注入内容结束 ===")
  }

  log("success", "构建目标注入完成：上游 script/build.ts 已支持 WRAPPER_BUILD_TARGETS_JSON 覆盖")
}

main().catch((e) => {
  log("error", String(e))
  process.exit(1)
})
