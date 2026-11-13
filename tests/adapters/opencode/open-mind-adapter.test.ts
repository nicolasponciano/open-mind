import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setupOpenMind } from "../../../src/adapters/opencode/adapter.ts"

async function makeVault(t: { after(callback: () => void | Promise<void>): void }) {
  const vaultPath = await mkdtemp(join(tmpdir(), "open-mind-adapter-test-"))
  await mkdir(join(vaultPath, "projetos"))
  await mkdir(join(vaultPath, "notas"))
  await writeFile(join(vaultPath, "00 - Open Mind.md"), "# Mapa de teste")
  await writeFile(join(vaultPath, "AGENTS.md"), "# Regras de teste")
  t.after(() => rm(vaultPath, { recursive: true, force: true }))
  return vaultPath
}

function makeContext(
  options: Record<string, unknown>,
  projectDirectory: string,
  locationDirectory = join(tmpdir(), "oms-adapter-global-location"),
) {
  const registered: Array<(event: { sessionID: string; system: unknown[] }) => Promise<void>> = []
  const permission = {
    calls: [] as Array<Record<string, unknown>>,
    reject: undefined as Error | undefined,
    async assert(input: Record<string, unknown>) {
      permission.calls.push(input)
      if (permission.reject) throw permission.reject
    },
  }
  const tools: Array<{
    name: string
    description: string
    input: Record<string, unknown>
    execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string; metadata: Record<string, unknown> }>
  }> = []
  return {
    ctx: {
      options,
      location: { directory: locationDirectory, project: { directory: locationDirectory, canonical: locationDirectory } },
      permission,
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          assert.equal(sessionID, "session-test")
          return { location: { directory: projectDirectory } }
        },
        hook: async (_name: string, callback: (event: { sessionID: string; system: unknown[] }) => Promise<void>) => {
          registered.push(callback)
          return { dispose: async () => {} }
        },
      },
      tool: {
        transform: async (callback: (editor: unknown) => void) => {
          callback({
            list: () => tools,
            get: (id: string) => tools.find((tool) => tool.name === id),
            namespace: () => {},
            add: (tool: (typeof tools)[number]) => tools.push(tool),
            update: () => {},
            remove: () => {},
          })
          return { dispose: async () => {} }
        },
      },
    },
    registered,
    tools,
    permission,
  }
}

test("inicializa e registra o hook com vaultPath absoluto válido", async (t) => {
  const vaultPath = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-adapter-valid-project")
  const { ctx, registered } = makeContext({ vaultPath }, projectDirectory)

  await setupOpenMind(ctx as never)

  assert.equal(registered.length, 1)
  const system: unknown[] = []
  await registered[0]({ sessionID: "session-test", system })
  assert.equal(system.length, 1)
  assert.match((system[0] as { text: string }).text, /# Mapa de teste/)
  assert.match((system[0] as { text: string }).text, /# Regras de teste/)
})

test("diagnostica vaultPath ausente sem registrar o hook", async () => {
  const { ctx, registered } = makeContext({}, tmpdir())

  await assert.rejects(setupOpenMind(ctx as never), /vaultPath.*opções do plugin/i)
  assert.equal(registered.length, 0)
})

test("rejeita vaultPath vazio ou que não seja texto sem registrar o hook", async () => {
  for (const vaultPath of ["", "  ", 42, null]) {
    const { ctx, registered } = makeContext({ vaultPath }, tmpdir())

    await assert.rejects(setupOpenMind(ctx as never), /vaultPath.*opções do plugin/i)
    assert.equal(registered.length, 0)
  }
})

test("diagnostica vaultPath relativo sem registrar o hook", async () => {
  const { ctx, registered } = makeContext({ vaultPath: ".\\meu-vault" }, tmpdir())

  await assert.rejects(setupOpenMind(ctx as never), /vaultPath.*absoluto/i)
  assert.equal(registered.length, 0)
})

test("diagnostica diretório inexistente sem registrar o hook", async () => {
  const missingPath = join(tmpdir(), "open-mind-vault-does-not-exist")
  const { ctx, registered } = makeContext({ vaultPath: missingPath }, tmpdir())

  await assert.rejects(setupOpenMind(ctx as never), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /vaultPath.*diretório existente/i)
    assert.doesNotMatch(error.message, new RegExp(missingPath.replaceAll("\\", "\\\\"), "i"))
    return true
  })
  assert.equal(registered.length, 0)
})

test("rejeita vaultPath que aponta para arquivo sem expor o caminho", async (t) => {
  const vaultPath = await makeVault(t)
  const filePath = join(vaultPath, "AGENTS.md")
  const { ctx, registered } = makeContext({ vaultPath: filePath }, tmpdir())

  await assert.rejects(setupOpenMind(ctx as never), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /vaultPath.*diretório existente/i)
    assert.doesNotMatch(error.message, new RegExp(filePath.replaceAll("\\", "\\\\"), "i"))
    return true
  })
  assert.equal(registered.length, 0)
})

test("registra as quatro ferramentas de leitura e as duas de escrita", async (t) => {
  const vaultPath = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-adapter-tools-project")
  const { ctx, tools } = makeContext({ vaultPath }, projectDirectory)
  await writeFile(join(vaultPath, "nota.md"), "# Nota\n\nconteúdo de teste")

  await setupOpenMind(ctx as never)

  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "open_mind_create",
      "open_mind_project_context",
      "open_mind_read",
      "open_mind_search",
      "open_mind_status",
      "open_mind_update",
    ],
  )

  const read = tools.find((tool) => tool.name === "open_mind_read")
  assert.ok(read)
  const result = await read.execute({ path: "nota.md" }, { sessionID: "session-test" })
  const parsed = JSON.parse(result.content)
  assert.equal(parsed.path, "nota.md")
  assert.match(parsed.content, /conteúdo de teste/)
  assert.match(parsed.sha256, /^[a-f0-9]{64}$/)
})

test("project_context usa o diretório da sessão, não ctx.location", async (t) => {
  const vaultPath = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-adapter-session-project")
  await mkdir(projectDirectory, { recursive: true })
  await writeFile(
    join(vaultPath, "projetos", "sessao.md"),
    `# sessao\n\nCaminho: \`${projectDirectory}\`\n`,
  )
  const { ctx, tools } = makeContext({ vaultPath }, projectDirectory)
  await setupOpenMind(ctx as never)

  const projectContext = tools.find((tool) => tool.name === "open_mind_project_context")
  assert.ok(projectContext)
  const parsed = JSON.parse((await projectContext.execute({}, { sessionID: "session-test" })).content)
  assert.equal(parsed.status, "found")
  assert.equal(parsed.path, "projetos/sessao.md")
  assert.doesNotMatch(JSON.stringify(parsed), new RegExp(projectDirectory.replaceAll("\\", "\\\\"), "i"))
})

test("sem writePolicy, escrita retorna WRITES_DISABLED sem pedir permissão", async (t) => {
  const vaultPath = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-adapter-disabled-project")
  const { ctx, tools, permission } = makeContext({ vaultPath }, projectDirectory)
  await setupOpenMind(ctx as never)

  const create = tools.find((tool) => tool.name === "open_mind_create")
  assert.ok(create)
  const parsed = JSON.parse((await create.execute({ path: "nota.md", content: "# x" }, { sessionID: "session-test" })).content)

  assert.equal(parsed.code, "WRITES_DISABLED")
  assert.equal(permission.calls.length, 0)
  await assert.rejects(readFile(join(vaultPath, "nota.md")), /ENOENT/)
})

test("writePolicy best-effort autoriza antes de criar com sessão, ação e recurso exatos", async (t) => {
  const vaultPath = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-adapter-write-project")
  const { ctx, tools, permission } = makeContext({ vaultPath, writePolicy: "best-effort" }, projectDirectory)
  await setupOpenMind(ctx as never)

  const create = tools.find((tool) => tool.name === "open_mind_create")
  assert.ok(create)
  const parsed = JSON.parse(
    (await create.execute({ path: "notas/nova.md", content: "# Nova\n" }, { sessionID: "session-test" })).content,
  )

  assert.equal(parsed.ok, true)
  assert.equal(parsed.path, "notas/nova.md")
  assert.deepEqual(permission.calls, [
    { sessionID: "session-test", action: "open_mind_create", resources: ["notas/nova.md"] },
  ])
  assert.equal(await readFile(join(vaultPath, "notas", "nova.md"), "utf8"), "# Nova\n")
})

test("update autorizado usa ação própria e preserva conteúdo em conflito de hash", async (t) => {
  const vaultPath = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-adapter-update-project")
  await writeFile(join(vaultPath, "nota.md"), "# Original\n")
  const { ctx, tools, permission } = makeContext({ vaultPath, writePolicy: "best-effort" }, projectDirectory)
  await setupOpenMind(ctx as never)

  const read = tools.find((tool) => tool.name === "open_mind_read")
  const update = tools.find((tool) => tool.name === "open_mind_update")
  assert.ok(read && update)
  const current = JSON.parse((await read.execute({ path: "nota.md" }, { sessionID: "session-test" })).content)
  const updated = JSON.parse(
    (
      await update.execute(
        { path: "nota.md", content: "# Revisado\n", expectedHash: current.sha256 },
        { sessionID: "session-test" },
      )
    ).content,
  )
  const conflict = JSON.parse(
    (
      await update.execute(
        { path: "nota.md", content: "# Conflito\n", expectedHash: current.sha256 },
        { sessionID: "session-test" },
      )
    ).content,
  )

  assert.equal(updated.ok, true)
  assert.equal(permission.calls.length, 1)
  assert.equal(permission.calls[0].action, "open_mind_update")
  assert.equal((permission.calls[0].resources as string[] | undefined)?.[0], "nota.md")
  assert.equal(conflict.code, "HASH_MISMATCH")
  assert.equal(permission.calls.length, 1)
  assert.equal(await readFile(join(vaultPath, "nota.md"), "utf8"), "# Revisado\n")
})

test("negativa de permissão interrompe a escrita e não cria o arquivo", async (t) => {
  const vaultPath = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-adapter-deny-project")
  const { ctx, tools, permission } = makeContext({ vaultPath, writePolicy: "best-effort" }, projectDirectory)
  permission.reject = new Error("denied by user")
  await setupOpenMind(ctx as never)

  const create = tools.find((tool) => tool.name === "open_mind_create")
  assert.ok(create)
  await assert.rejects(
    create.execute({ path: "negada.md", content: "x" }, { sessionID: "session-test" }),
    /denied by user/,
  )
  assert.equal(permission.calls.length, 1)
  await assert.rejects(readFile(join(vaultPath, "negada.md")), /ENOENT/)
})

test("writePolicy inválida falha na inicialização sem registrar ferramentas", async (t) => {
  const vaultPath = await makeVault(t)
  const { ctx, tools } = makeContext({ vaultPath, writePolicy: "enabled" }, tmpdir())

  await assert.rejects(setupOpenMind(ctx as never), /writePolicy/i)
  assert.equal(tools.length, 0)
})

test("writePolicy de tipo inválido falha sem registrar ferramentas nem expor o Vault", async (t) => {
  const vaultPath = await makeVault(t)

  for (const writePolicy of [42, null]) {
    const { ctx, tools } = makeContext({ vaultPath, writePolicy }, tmpdir())

    await assert.rejects(setupOpenMind(ctx as never), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /writePolicy/i)
      assert.doesNotMatch(error.message, new RegExp(vaultPath.replaceAll("\\", "\\\\"), "i"))
      return true
    })
    assert.equal(tools.length, 0)
  }
})

test("status expõe a política efetiva", async (t) => {
  const vaultPath = await makeVault(t)
  const projectDirectory = join(tmpdir(), "oms-adapter-status-project")
  const enabled = makeContext({ vaultPath, writePolicy: "best-effort" }, projectDirectory)
  await setupOpenMind(enabled.ctx as never)
  const status = enabled.tools.find((tool) => tool.name === "open_mind_status")
  assert.ok(status)
  const parsed = JSON.parse((await status.execute({}, { sessionID: "session-test" })).content)

  assert.equal(parsed.writes, "best-effort")
  assert.doesNotMatch(JSON.stringify(parsed), new RegExp(vaultPath.replaceAll("\\", "\\\\"), "i"))
})
