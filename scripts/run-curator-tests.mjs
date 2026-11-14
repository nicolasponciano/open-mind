import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const testsDir = join(root, "tests", "curator")

const candidates = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"]
const python = candidates.find((candidate) => {
  const probe = spawnSync(candidate, ["-c", "import sys; sys.exit(0)"], { stdio: "ignore" })
  return probe.status === 0
})

if (!python) {
  console.log("SKIP: Python nao encontrado; testes do curador nao executados neste ambiente.")
  process.exit(0)
}

const result = spawnSync(python, ["-m", "unittest", "discover", "-s", testsDir, "-p", "test_*.py", "-v"], {
  cwd: root,
  stdio: "inherit",
})

if (result.error) {
  console.error(`FAIL: nao foi possivel executar ${python}: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
