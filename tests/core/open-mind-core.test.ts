import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionContextLoader, loadOpenMindContext } from "../../src/core/open-mind-core.ts"

async function makeVault(t: { after(callback: () => void | Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "open-mind-session-test-"))
  await mkdir(join(root, "projetos"), { recursive: true })
  await writeFile(join(root, "00 - Open Mind.md"), "# Mapa genérico")
  await writeFile(join(root, "AGENTS.md"), "# Regras genéricas")
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function addProjectNote(vault: string, name: string, projectDirectory: string, body = name) {
  await writeFile(
    join(vault, "projetos", `${name}.md`),
    `# ${name}\n\nCaminho: \`${projectDirectory}\`\n\n${body}`,
  )
}

test("usa o diretório da sessão correspondente para projetos distintos", async (t) => {
  const vault = await makeVault(t)
  const alphaDirectory = join(tmpdir(), "oms-project-alpha")
  const betaDirectory = join(tmpdir(), "oms-project-beta")
  await addProjectNote(vault, "alpha", alphaDirectory, "Contexto Alpha")
  await addProjectNote(vault, "beta", betaDirectory, "Contexto Beta")
  const directories = new Map([
    ["session-alpha", alphaDirectory],
    ["session-beta", betaDirectory],
  ])
  const load = createSessionContextLoader<string>(
    async (sessionID) => directories.get(sessionID),
    (projectDirectory) => loadOpenMindContext({ vaultRoot: vault, projectRoot: projectDirectory }),
  )

  const alpha = await load("session-alpha")
  const beta = await load("session-beta")

  assert.equal(alpha?.projectStatus, "found")
  assert.match(alpha?.text ?? "", /Contexto Alpha/)
  assert.equal(beta?.projectStatus, "found")
  assert.match(beta?.text ?? "", /Contexto Beta/)
  assert.doesNotMatch(alpha?.text ?? "", /Contexto Beta/)
})

test("não usa fallback e tenta novamente quando a sessão está indisponível", async (t) => {
  const vault = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-project-retry-session")
  await addProjectNote(vault, "retry-session", projectDirectory)
  let available = false
  const load = createSessionContextLoader<string>(
    async () => {
      if (!available) throw new Error("session unavailable")
      return projectDirectory
    },
    (directory) => loadOpenMindContext({ vaultRoot: vault, projectRoot: directory }),
  )

  const unavailable = await load("session-retry")
  available = true
  const retried = await load("session-retry")

  assert.equal(unavailable?.projectStatus, "session_unavailable")
  assert.equal(retried?.projectStatus, "found")
  assert.match(retried?.text ?? "", /retry-session/)
})

test("retorna estado explícito quando não há nota de projeto", async (t) => {
  const vault = await makeVault(t)
  const context = await loadOpenMindContext({
    vaultRoot: vault,
    projectRoot: join(tmpdir(), "oms-project-without-note"),
  })

  assert.equal(context.projectStatus, "not_found")
  assert.match(context.text, /Nenhuma nota de projeto correspondente foi encontrada/)
})

test("preserva prioridade da nota com caminho sobre correspondência de índice", async (t) => {
  const vault = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-project-priority")
  await writeFile(
    join(vault, "projetos", "00 - Projetos.md"),
    `# Projetos\n\n[[projeto-prioritario]]: \`${projectDirectory}\``,
  )
  await addProjectNote(vault, "projeto-prioritario", projectDirectory, "Nota detalhada")

  const context = await loadOpenMindContext({ vaultRoot: vault, projectRoot: projectDirectory })

  assert.equal(context.projectStatus, "found")
  assert.match(context.text, /Nota detalhada/)
  assert.doesNotMatch(context.text, /00 - Projetos\.md/)
})

test("usa referência exata do índice para nota sem metadado de caminho", async (t) => {
  const vault = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-project-index-fallback")
  await writeFile(
    join(vault, "projetos", "00 - Projetos.md"),
    `# Projetos\n\n- [[projeto-legado]]: \`${projectDirectory}\``,
  )
  await writeFile(join(vault, "projetos", "projeto-legado.md"), "# Projeto legado\n\nContexto legado.")

  const context = await loadOpenMindContext({ vaultRoot: vault, projectRoot: projectDirectory })

  assert.equal(context.projectStatus, "found")
  assert.match(context.text, /Contexto legado/)
})

test("não associa uma linha com vários wikilinks a um único caminho", async (t) => {
  const vault = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-project-multi-link")
  await writeFile(
    join(vault, "projetos", "00 - Projetos.md"),
    `# Projetos\n\n[[projeto-um]] [[projeto-dois]]: \`${projectDirectory}\``,
  )
  await writeFile(join(vault, "projetos", "projeto-um.md"), "# Projeto um\nNota um")

  const context = await loadOpenMindContext({ vaultRoot: vault, projectRoot: projectDirectory })

  assert.equal(context.projectStatus, "ambiguous")
  assert.doesNotMatch(context.text, /Nota um/)
})

test("compara caminhos segundo a sensibilidade a case observável no filesystem", async (t) => {
  const vault = await makeVault(t)
  const probeRoot = await mkdtemp(join(tmpdir(), "open-mind-case-test-"))
  t.after(() => rm(probeRoot, { recursive: true, force: true }))
  const projectDirectory = join(probeRoot, "CaseProject")
  const caseVariant = join(probeRoot, "caseproject")
  await mkdir(projectDirectory)

  let caseSensitive = true
  try {
    await mkdir(caseVariant)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    caseSensitive = false
  }

  const first = await stat(projectDirectory)
  const second = await stat(caseVariant)
  const sameDirectory = first.dev === second.dev && first.ino !== 0 && first.ino === second.ino
  assert.equal(sameDirectory, !caseSensitive)

  await addProjectNote(vault, "case-upper", projectDirectory, "Contexto maiúsculo")
  await addProjectNote(vault, "case-lower", caseVariant, "Contexto minúsculo")
  const context = await loadOpenMindContext({ vaultRoot: vault, projectRoot: projectDirectory })

  assert.equal(context.projectStatus, caseSensitive ? "found" : "ambiguous")
  if (caseSensitive) assert.match(context.text, /Contexto maiúsculo/)
})

test("metadados truncados produzem estado inconclusivo, não not_found", async (t) => {
  const vault = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-project-truncated")
  await writeFile(
    join(vault, "projetos", "nota-truncada.md"),
    `# Nota\n\n${"x".repeat(17 * 1024)}\n\nCaminho: \`${projectDirectory}\`\n`,
  )

  const context = await loadOpenMindContext({ vaultRoot: vault, projectRoot: projectDirectory })

  assert.equal(context.projectStatus, "limit_reached")
  assert.match(context.text, /metadados truncados/)
})

test("preserva identificação legada por caminho completo sem substring", async (t) => {
  const vault = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-project-legacy-exact")
  await writeFile(
    join(vault, "projetos", "projeto-legado.md"),
    `# Projeto legado\n\n\`${projectDirectory}\`\n\nContexto legado exato.`,
  )

  const context = await loadOpenMindContext({ vaultRoot: vault, projectRoot: projectDirectory })

  assert.equal(context.projectStatus, "found")
  assert.match(context.text, /Contexto legado exato/)
})

test("não escolhe arbitrariamente entre múltiplas notas correspondentes", async (t) => {
  const vault = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-project-ambiguous")
  await addProjectNote(vault, "ambiguous-one", projectDirectory, "Conteúdo um")
  await addProjectNote(vault, "ambiguous-two", projectDirectory, "Conteúdo dois")

  const context = await loadOpenMindContext({ vaultRoot: vault, projectRoot: projectDirectory })

  assert.equal(context.projectStatus, "ambiguous")
  assert.doesNotMatch(context.text, /Conteúdo um|Conteúdo dois/)
})

test("mantém cache independente por sessão e carrega contexto-base", async (t) => {
  const vault = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-project-cache")
  await addProjectNote(vault, "cache-project", projectDirectory)
  const calls: string[] = []
  const load = createSessionContextLoader<string>(
    async (sessionID) => {
      calls.push(sessionID)
      return projectDirectory
    },
    (directory) => loadOpenMindContext({ vaultRoot: vault, projectRoot: directory }),
  )

  const first = await load("session-one")
  const repeat = await load("session-one")
  const second = await load("session-two")

  assert.match(first?.text ?? "", /# Mapa genérico/)
  assert.match(first?.text ?? "", /# Regras genéricas/)
  assert.equal(repeat, undefined)
  assert.equal(second?.projectStatus, "found")
  assert.deepEqual(calls, ["session-one", "session-two"])
})

test("não marca sessão como carregada quando ocorre falha de leitura", async (t) => {
  const vault = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-project-load-retry")
  const indexPath = join(vault, "00 - Open Mind.md")
  await rm(indexPath)
  await mkdir(indexPath)
  const load = createSessionContextLoader<string>(
    async () => projectDirectory,
    (directory) => loadOpenMindContext({ vaultRoot: vault, projectRoot: directory }),
  )

  await assert.rejects(load("session-load-retry"))
  await rm(indexPath, { recursive: true })
  await writeFile(indexPath, "# Mapa recuperado")
  const retried = await load("session-load-retry")

  assert.equal(retried?.projectStatus, "not_found")
  assert.match(retried?.text ?? "", /# Mapa recuperado/)
})

test("seleciona somente o caminho de projeto exato quando nomes são semelhantes", async (t) => {
  const vault = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-project-exact")
  await addProjectNote(vault, "prefix-collision", `${projectDirectory}-extra`, "Não é este projeto")
  await addProjectNote(vault, "exact-match", projectDirectory, "Projeto correto")

  const context = await loadOpenMindContext({ vaultRoot: vault, projectRoot: projectDirectory })

  assert.equal(context.projectStatus, "found")
  assert.match(context.text, /Projeto correto/)
  assert.doesNotMatch(context.text, /Não é este projeto/)
})

test("não seleciona nota apenas porque o caminho aparece como substring do texto", async (t) => {
  const vault = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-project-fragile")
  await writeFile(
    join(vault, "projetos", "mencao.md"),
    `# Outra nota\n\nO caminho ${projectDirectory} aparece apenas como referência no corpo.`,
  )

  const context = await loadOpenMindContext({ vaultRoot: vault, projectRoot: projectDirectory })

  assert.equal(context.projectStatus, "not_found")
  assert.doesNotMatch(context.text, /aparece apenas como referência/)
})

test("retorna estado explícito quando o limite de arquivos analisados é atingido", async (t) => {
  const vault = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-project-after-limit")
  for (let index = 0; index < 130; index++) {
    await writeFile(
      join(vault, "projetos", `projeto-${String(index).padStart(3, "0")}.md`),
      index === 129 ? `Caminho: \`${projectDirectory}\`\nAlvo tardio` : `# Projeto ${index}`,
    )
  }

  const context = await loadOpenMindContext({ vaultRoot: vault, projectRoot: projectDirectory })

  assert.equal(context.projectStatus, "limit_reached")
  assert.doesNotMatch(context.text, /Alvo tardio/)
})
