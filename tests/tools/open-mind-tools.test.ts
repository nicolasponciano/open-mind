import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_SEARCH_LIMITS,
  createOpenMindTools,
  type OpenMindAuthorization,
  type OpenMindTool,
} from "../../src/tools/open-mind-tools.ts"

type Fixture = {
  vaultPath: string
  projectDirectory: string
  tools: Record<string, OpenMindTool>
  authorizations: OpenMindAuthorization[]
}

async function fixture(
  t: { after(callback: () => void | Promise<void>): void },
  options: {
    sessionDirectory?: string | (() => Promise<string>)
    writePolicy?: "disabled" | "best-effort"
    authorize?: (request: OpenMindAuthorization) => Promise<void>
  } = {},
): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), "open-mind-tools-test-"))
  const vaultPath = join(parent, "vault")
  const projectDirectory = join(parent, "project-alpha")
  await mkdir(join(vaultPath, "projetos"), { recursive: true })
  await mkdir(join(vaultPath, "referencias"), { recursive: true })
  await mkdir(join(vaultPath, "notas"), { recursive: true })
  await mkdir(projectDirectory)
  await writeFile(join(vaultPath, "00 - Open Mind.md"), "# Mapa genérico")
  await writeFile(join(vaultPath, "AGENTS.md"), "# Regras genéricas")
  await writeFile(join(vaultPath, "referencias", "alfa.md"), "# Alfa\n\nConteúdo sobre produtividade.\n")
  await writeFile(join(vaultPath, "referencias", "beta.md"), "# Beta\n\nOutro assunto qualquer.\n")
  await writeFile(
    join(vaultPath, "projetos", "projeto-alpha.md"),
    `# projeto-alpha\n\nCaminho: \`${projectDirectory}\`\n\nContexto do projeto.\n`,
  )
  t.after(() => rm(parent, { recursive: true, force: true }))

  const sessionDirectory = options.sessionDirectory ?? projectDirectory
  const authorizations: OpenMindAuthorization[] = []
  const tools = Object.fromEntries(
    createOpenMindTools({
      vaultRoot: vaultPath,
      getSessionDirectory: async () =>
        typeof sessionDirectory === "function" ? sessionDirectory() : sessionDirectory,
      writePolicy: options.writePolicy,
      authorize:
        options.authorize ??
        (async (request) => {
          authorizations.push(request)
        }),
    }).map((tool) => [tool.name, tool]),
  )
  return { vaultPath, projectDirectory, tools, authorizations }
}

async function call(tool: OpenMindTool, input: unknown) {
  return tool.execute(input, { sessionID: "session-test" })
}

function parse(toolResult: { content: string }) {
  return JSON.parse(toolResult.content) as Record<string, any>
}

test("expõe as quatro ferramentas de leitura e as duas de escrita com esquema JSON", async (t) => {
  const { tools } = await fixture(t)

  assert.deepEqual(Object.keys(tools).sort(), [
    "open_mind_create",
    "open_mind_project_context",
    "open_mind_read",
    "open_mind_search",
    "open_mind_status",
    "open_mind_update",
  ])
  for (const tool of Object.values(tools)) {
    assert.equal(tool.input.type, "object")
    assert.equal(tool.description.length > 20, true)
  }
  assert.deepEqual(tools.open_mind_status.input.required ?? [], [])
  assert.deepEqual(tools.open_mind_read.input.required, ["path"])
  assert.deepEqual(tools.open_mind_search.input.required, ["query"])
  assert.deepEqual(tools.open_mind_create.input.required, ["path", "content"])
  assert.deepEqual(tools.open_mind_update.input.required, ["path", "content", "expectedHash"])
})

test("status informa Vault, arquivos-base, projeto e limites sem caminhos absolutos", async (t) => {
  const { tools, vaultPath } = await fixture(t)
  const status = parse(await call(tools.open_mind_status, {}))

  assert.equal(status.vault.accessible, true)
  assert.equal(status.baseFiles.map, "available")
  assert.equal(status.baseFiles.agents, "available")
  assert.equal(status.project.status, "found")
  assert.equal(status.writes, "disabled")
  assert.equal(status.limits.maxReadBytes > 0, true)
  assert.equal(status.limits.search.maxResults, DEFAULT_SEARCH_LIMITS.maxResults)
  assert.doesNotMatch(JSON.stringify(status), new RegExp(vaultPath.replaceAll("\\", "\\\\"), "i"))
})

test("status marca arquivos-base ausentes sem falhar", async (t) => {
  const { tools, vaultPath } = await fixture(t)
  await rm(join(vaultPath, "AGENTS.md"))
  const status = parse(await call(tools.open_mind_status, {}))

  assert.equal(status.baseFiles.agents, "missing")
  assert.equal(status.vault.accessible, true)
})

test("status trata sessão indisponível sem usar diretório alternativo", async (t) => {
  const { tools } = await fixture(t, {
    sessionDirectory: async () => {
      throw new Error("session unavailable")
    },
  })
  const status = parse(await call(tools.open_mind_status, {}))

  assert.equal(status.project.status, "session_unavailable")
})

test("search encontra trechos curtos e relativos ao Vault", async (t) => {
  const { tools } = await fixture(t)
  const result = parse(await call(tools.open_mind_search, { query: "PRODUTIVIDADE" }))

  assert.equal(result.count, 1)
  assert.equal(result.results[0].path, "referencias/alfa.md")
  assert.equal(result.results[0].line, 3)
  assert.match(result.results[0].snippet, /produtividade/i)
  assert.equal(result.results[0].snippet.length <= DEFAULT_SEARCH_LIMITS.maxSnippetChars, true)
  assert.equal(result.incomplete, false)
})

test("search respeita escopo e retorna vazio sem correspondência", async (t) => {
  const { tools } = await fixture(t)
  const scoped = parse(await call(tools.open_mind_search, { query: "produtividade", scope: "referencias" }))
  const missing = parse(await call(tools.open_mind_search, { query: "inexistente" }))
  const outsideScope = parse(await call(tools.open_mind_search, { query: "Mapa", scope: "referencias" }))

  assert.equal(scoped.count, 1)
  assert.equal(missing.count, 0)
  assert.equal(outsideScope.count, 0)
})

test("search respeita limite de resultados e sinaliza resultado parcial", async (t) => {
  const { tools, vaultPath } = await fixture(t)
  for (let index = 0; index < 6; index++) {
    await writeFile(join(vaultPath, "referencias", `limite-${index}.md`), "termo repetido\n")
  }
  const result = parse(await call(tools.open_mind_search, { query: "termo", limit: 2 }))

  assert.equal(result.count, 2)
  assert.equal(result.limitReached, true)
  assert.equal(result.incomplete, true)
  assert.match(result.reasons.join(","), /results/)
})

test("search sinaliza truncamento por bytes por arquivo", async (t) => {
  const { tools, vaultPath } = await fixture(t)
  await writeFile(join(vaultPath, "referencias", "grande.md"), `${"x".repeat(80 * 1024)}produtividade\n`)
  const result = parse(await call(tools.open_mind_search, { query: "produtividade" }))

  assert.equal(result.incomplete, true)
  assert.match(result.reasons.join(","), /file_bytes/)
})

test("search rejeita consulta vazia e escopo fora do Vault", async (t) => {
  const { tools, projectDirectory } = await fixture(t)

  const empty = parse(await call(tools.open_mind_search, { query: "   " }))
  const traversal = parse(await call(tools.open_mind_search, { query: "x", scope: "../" }))
  const absolute = parse(await call(tools.open_mind_search, { query: "x", scope: projectDirectory }))

  assert.equal(empty.ok, false)
  assert.equal(empty.code, "INVALID_ARGUMENTS")
  assert.equal(traversal.code, "INVALID_PATH")
  assert.equal(absolute.code, "INVALID_PATH")
})

test("read retorna conteúdo e hash SHA-256 dos bytes gravados", async (t) => {
  const { tools, vaultPath } = await fixture(t)
  const expected = createHash("sha256").update(await readFile(join(vaultPath, "referencias", "alfa.md"))).digest("hex")
  const result = parse(await call(tools.open_mind_read, { path: "referencias/alfa.md" }))

  assert.equal(result.path, "referencias/alfa.md")
  assert.match(result.content, /produtividade/)
  assert.equal(result.sha256, expected)
  assert.equal(result.bytes, (await readFile(join(vaultPath, "referencias", "alfa.md"))).byteLength)
})

test("read rejeita traversal, absoluto, não Markdown e ausente sem vazar caminho", async (t) => {
  const { tools, projectDirectory, vaultPath } = await fixture(t)

  const traversal = parse(await call(tools.open_mind_read, { path: "../segredo.md" }))
  const absolute = parse(await call(tools.open_mind_read, { path: join(projectDirectory, "x.md") }))
  const wrongExtension = parse(await call(tools.open_mind_read, { path: "referencias/alfa.txt" }))
  const missing = parse(await call(tools.open_mind_read, { path: "referencias/ausente.md" }))

  assert.equal(traversal.code, "INVALID_PATH")
  assert.equal(absolute.code, "INVALID_PATH")
  assert.equal(wrongExtension.code, "NOT_MARKDOWN")
  assert.equal(missing.code, "NOT_FOUND")
  for (const result of [traversal, absolute, wrongExtension, missing]) {
    assert.doesNotMatch(JSON.stringify(result), new RegExp(vaultPath.replaceAll("\\", "\\\\"), "i"))
    assert.doesNotMatch(JSON.stringify(result), /Users\\\\/i)
  }
})

test("read aplica limite de tamanho", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "open-mind-tools-limit-"))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const vaultPath = join(parent, "vault")
  await mkdir(join(vaultPath, "projetos"), { recursive: true })
  await writeFile(join(vaultPath, "00 - Open Mind.md"), "# Mapa")
  await writeFile(join(vaultPath, "AGENTS.md"), "# Regras")
  await writeFile(join(vaultPath, "grande.md"), "x".repeat(2048))
  const tools = Object.fromEntries(
    createOpenMindTools({
      vaultRoot: vaultPath,
      getSessionDirectory: async () => undefined,
      readLimits: { maxReadBytes: 1024, maxWriteBytes: 1024, maxProjectMetadataBytes: 1024 },
    }).map((tool) => [tool.name, tool]),
  )

  const result = parse(await call(tools.open_mind_read, { path: "grande.md" }))
  assert.equal(result.ok, false)
  assert.equal(result.code, "LIMIT_EXCEEDED")
})

test("project_context resolve por sessionID e preserva os estados", async (t) => {
  const { tools, projectDirectory } = await fixture(t)
  const found = parse(await call(tools.open_mind_project_context, {}))

  assert.equal(found.status, "found")
  assert.equal(found.path, "projetos/projeto-alpha.md")
  assert.equal(found.projectDirectory, undefined)
  assert.doesNotMatch(JSON.stringify(found), new RegExp(projectDirectory.replaceAll("\\", "\\\\"), "i"))
})

test("project_context retorna ambiguous sem escolher nota", async (t) => {
  const { tools, vaultPath, projectDirectory } = await fixture(t)
  await writeFile(
    join(vaultPath, "projetos", "outro.md"),
    `# outro\n\nCaminho: \`${projectDirectory}\`\n`,
  )
  const result = parse(await call(tools.open_mind_project_context, {}))

  assert.equal(result.status, "ambiguous")
  assert.equal(result.path, undefined)
})

test("project_context retorna limit_reached para metadados truncados", async (t) => {
  const { tools, vaultPath, projectDirectory } = await fixture(t)
  await writeFile(
    join(vaultPath, "projetos", "truncado.md"),
    `# truncado\n\n${"x".repeat(17 * 1024)}\nCaminho: \`${projectDirectory}\`\n`,
  )
  const result = parse(await call(tools.open_mind_project_context, {}))

  assert.equal(result.status, "limit_reached")
})

test("project_context retorna not_found e session_unavailable explicitamente", async (t) => {
  const { tools } = await fixture(t, { sessionDirectory: join(tmpdir(), "open-mind-unknown-project") })
  const notFound = parse(await call(tools.open_mind_project_context, {}))

  const unavailableFixture = await fixture(t, {
    sessionDirectory: async () => {
      throw new Error("no session")
    },
  })
  const unavailable = parse(await call(unavailableFixture.tools.open_mind_project_context, {}))

  assert.equal(notFound.status, "not_found")
  assert.equal(unavailable.status, "session_unavailable")
})

test("escrita permanece desabilitada por padrão, sem autorização e sem arquivos", async (t) => {
  const { tools, vaultPath, authorizations } = await fixture(t)

  const created = parse(await call(tools.open_mind_create, { path: "notas/nova.md", content: "# Nova\n" }))
  const updated = parse(
    await call(tools.open_mind_update, {
      path: "referencias/alfa.md",
      content: "# alterado\n",
      expectedHash: "0".repeat(64),
    }),
  )

  assert.equal(created.code, "WRITES_DISABLED")
  assert.equal(updated.code, "WRITES_DISABLED")
  assert.equal(authorizations.length, 0)
  await assert.rejects(readFile(join(vaultPath, "notas", "nova.md")), /ENOENT/)
  assert.match(await readFile(join(vaultPath, "referencias", "alfa.md"), "utf8"), /produtividade/)
})

test("create autorizado grava dentro do Vault e retorna hash e bytes UTF-8", async (t) => {
  const { tools, vaultPath, authorizations } = await fixture(t, { writePolicy: "best-effort" })
  const content = "# Ação\n\nConteúdo com acentuação e emoji 🎯.\n"

  const result = parse(await call(tools.open_mind_create, { path: "notas/nova.md", content }))
  const written = await readFile(join(vaultPath, "notas", "nova.md"))

  assert.equal(result.ok, true)
  assert.equal(result.path, "notas/nova.md")
  assert.equal(result.sha256, createHash("sha256").update(written).digest("hex"))
  assert.equal(result.bytes, Buffer.byteLength(content, "utf8"))
  assert.equal(written.toString("utf8"), content)
  assert.deepEqual(authorizations, [
    { action: "open_mind_create", path: "notas/nova.md", sessionID: "session-test" },
  ])
})

test("create não sobrescreve arquivo existente nem pede autorização", async (t) => {
  const { tools, vaultPath, authorizations } = await fixture(t, { writePolicy: "best-effort" })

  const result = parse(await call(tools.open_mind_create, { path: "referencias/alfa.md", content: "sobrescrever" }))

  assert.equal(result.code, "ALREADY_EXISTS")
  assert.equal(authorizations.length, 0)
  assert.match(await readFile(join(vaultPath, "referencias", "alfa.md"), "utf8"), /produtividade/)
})

test("update autorizado exige hash atual e retorna o novo estado", async (t) => {
  const { tools, vaultPath, authorizations } = await fixture(t, { writePolicy: "best-effort" })
  const original = await readFile(join(vaultPath, "referencias", "alfa.md"))
  const expectedHash = createHash("sha256").update(original).digest("hex")
  const content = "# Alfa revisado\n\nTexto atualizado com acentuação.\n"

  const result = parse(
    await call(tools.open_mind_update, { path: "referencias/alfa.md", content, expectedHash }),
  )
  const written = await readFile(join(vaultPath, "referencias", "alfa.md"))

  assert.equal(result.ok, true)
  assert.equal(result.path, "referencias/alfa.md")
  assert.equal(result.sha256, createHash("sha256").update(written).digest("hex"))
  assert.equal(result.bytes, Buffer.byteLength(content, "utf8"))
  assert.equal(written.toString("utf8"), content)
  assert.equal(authorizations.length, 1)
  assert.equal(authorizations[0].action, "open_mind_update")
  assert.equal(authorizations[0].path, "referencias/alfa.md")

  const previous = parse(
    await call(tools.open_mind_update, { path: "referencias/alfa.md", content: "repetido", expectedHash }),
  )
  assert.equal(previous.code, "HASH_MISMATCH")
})

test("update rejeita hash inválido ou divergente sem alterar o conteúdo", async (t) => {
  const { tools, vaultPath, authorizations } = await fixture(t, { writePolicy: "best-effort" })
  const original = await readFile(join(vaultPath, "referencias", "alfa.md"), "utf8")

  const invalid = parse(
    await call(tools.open_mind_update, { path: "referencias/alfa.md", content: "x", expectedHash: "abc" }),
  )
  const divergent = parse(
    await call(tools.open_mind_update, {
      path: "referencias/alfa.md",
      content: "x",
      expectedHash: "a".repeat(64),
    }),
  )

  assert.equal(invalid.code, "INVALID_ARGUMENTS")
  assert.equal(divergent.code, "HASH_MISMATCH")
  assert.equal(authorizations.length, 0)
  assert.equal(await readFile(join(vaultPath, "referencias", "alfa.md"), "utf8"), original)
})

test("update detecta modificação externa depois da leitura", async (t) => {
  const { tools, vaultPath, authorizations } = await fixture(t, { writePolicy: "best-effort" })
  const read = parse(await call(tools.open_mind_read, { path: "referencias/alfa.md" }))
  await writeFile(join(vaultPath, "referencias", "alfa.md"), "# alteração externa\n")

  const result = parse(
    await call(tools.open_mind_update, {
      path: "referencias/alfa.md",
      content: "# minha alteração\n",
      expectedHash: read.sha256,
    }),
  )

  assert.equal(result.code, "HASH_MISMATCH")
  assert.equal(authorizations.length, 0)
  assert.equal(await readFile(join(vaultPath, "referencias", "alfa.md"), "utf8"), "# alteração externa\n")
})

test("negativa de autorização interrompe a escrita e não é convertida em sucesso", async (t) => {
  const { tools, vaultPath } = await fixture(t, {
    writePolicy: "best-effort",
    authorize: async () => {
      throw new Error("permission rejected")
    },
  })

  await assert.rejects(call(tools.open_mind_create, { path: "notas/negada.md", content: "x" }), /permission rejected/)
  await assert.rejects(
    call(tools.open_mind_update, {
      path: "referencias/alfa.md",
      content: "x",
      expectedHash: createHash("sha256")
        .update(await readFile(join(vaultPath, "referencias", "alfa.md")))
        .digest("hex"),
    }),
    /permission rejected/,
  )
  await assert.rejects(readFile(join(vaultPath, "notas", "negada.md")), /ENOENT/)
  assert.match(await readFile(join(vaultPath, "referencias", "alfa.md"), "utf8"), /produtividade/)
})

test("escrita habilitada sem autorizador falha fechada", async (t) => {
  const { vaultPath } = await fixture(t)
  const tools = Object.fromEntries(
    createOpenMindTools({
      vaultRoot: vaultPath,
      getSessionDirectory: async () => undefined,
      writePolicy: "best-effort",
    }).map((tool) => [tool.name, tool]),
  )

  const hash = createHash("sha256")
    .update(await readFile(join(vaultPath, "referencias", "alfa.md")))
    .digest("hex")
  const created = parse(await call(tools.open_mind_create, { path: "notas/x.md", content: "x" }))
  const updated = parse(
    await call(tools.open_mind_update, { path: "referencias/alfa.md", content: "y", expectedHash: hash }),
  )

  assert.equal(created.code, "AUTHORIZATION_UNAVAILABLE")
  assert.equal(updated.code, "AUTHORIZATION_UNAVAILABLE")
  await assert.rejects(readFile(join(vaultPath, "notas", "x.md")), /ENOENT/)
  assert.match(await readFile(join(vaultPath, "referencias", "alfa.md"), "utf8"), /produtividade/)
})

test("escrita rejeita caminhos inválidos, externos e extensão não Markdown sem autorizar", async (t) => {
  const { tools, vaultPath, projectDirectory, authorizations } = await fixture(t, { writePolicy: "best-effort" })

  const cases = [
    ["../fora.md", "INVALID_PATH"],
    [join(projectDirectory, "fora.md"), "INVALID_PATH"],
    ["referencias/alfa.txt", "NOT_MARKDOWN"],
  ] as const
  for (const [path, code] of cases) {
    const result = parse(await call(tools.open_mind_create, { path, content: "x" }))
    assert.equal(result.code, code, path)
  }

  assert.equal(authorizations.length, 0)
  assert.doesNotMatch(JSON.stringify(authorizations), new RegExp(vaultPath.replaceAll("\\", "\\\\"), "i"))
})

test("create recusa junction para fora do Vault sem autorizar", async (t) => {
  const { tools, vaultPath, authorizations } = await fixture(t, { writePolicy: "best-effort" })
  const outside = join(vaultPath, "..", "oms-fora-do-vault")
  await mkdir(outside, { recursive: true })
  try {
    await symlink(outside, join(vaultPath, "link-externo"), "junction")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
      return t.skip("junction indisponível nesta plataforma; contenção permanece coberta em open-mind-files.test.ts")
    }
    throw error
  }

  const result = parse(await call(tools.open_mind_create, { path: "link-externo/fora.md", content: "x" }))

  assert.equal(result.code, "OUTSIDE_VAULT")
  assert.equal(authorizations.length, 0)
  await assert.rejects(readFile(join(outside, "fora.md")), /ENOENT/)
})

test("escrita aplica limite em bytes UTF-8 e falha fechada", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "open-mind-tools-write-limit-"))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const vaultPath = join(parent, "vault")
  await mkdir(join(vaultPath, "notas"), { recursive: true })
  await writeFile(join(vaultPath, "00 - Open Mind.md"), "# Mapa")
  await writeFile(join(vaultPath, "AGENTS.md"), "# Regras")

  const authorizations: OpenMindAuthorization[] = []
  const tools = Object.fromEntries(
    createOpenMindTools({
      vaultRoot: vaultPath,
      getSessionDirectory: async () => undefined,
      readLimits: { maxReadBytes: 1024, maxWriteBytes: 32, maxProjectMetadataBytes: 1024 },
      writePolicy: "best-effort",
      authorize: async (request) => {
        authorizations.push(request)
      },
    }).map((tool) => [tool.name, tool]),
  )

  const multibyte = parse(await call(tools.open_mind_create, { path: "notas/emoji.md", content: "🎯".repeat(9) }))
  const ascii = parse(await call(tools.open_mind_create, { path: "notas/ascii.md", content: "x".repeat(33) }))

  assert.equal(multibyte.code, "LIMIT_EXCEEDED")
  assert.equal(ascii.code, "LIMIT_EXCEEDED")
  assert.equal(authorizations.length, 0)
  await assert.rejects(readFile(join(vaultPath, "notas", "emoji.md")), /ENOENT/)
})

test("status reflete a política habilitada sem habilitar escrita por argumentos", async (t) => {
  const { tools } = await fixture(t, { writePolicy: "best-effort" })
  const status = parse(await call(tools.open_mind_status, {}))

  assert.equal(status.writes, "best-effort")
})

test("ferramentas de leitura continuam funcionando com escrita habilitada", async (t) => {
  const { tools } = await fixture(t, { writePolicy: "best-effort" })
  const read = parse(await call(tools.open_mind_read, { path: "referencias/alfa.md" }))
  const search = parse(await call(tools.open_mind_search, { query: "produtividade" }))

  assert.equal(read.path, "referencias/alfa.md")
  assert.match(read.content, /produtividade/)
  assert.equal(search.count, 1)
})
