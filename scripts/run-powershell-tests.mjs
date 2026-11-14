import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const testFile = join(root, "tests", "powershell", "bootstrap.tests.ps1")

const candidates = process.platform === "win32" ? ["pwsh", "powershell"] : ["pwsh", "powershell"]
const shell = candidates.find((candidate) => {
  const probe = spawnSync(candidate, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" })
  return probe.status === 0
})

if (!shell) {
  console.log("SKIP: PowerShell não encontrado; testes de bootstrap não executados neste ambiente.")
  process.exit(0)
}

const result = spawnSync(shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", testFile], {
  cwd: root,
  stdio: "inherit",
})

if (result.error) {
  console.error(`FAIL: não foi possível executar ${shell}: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
