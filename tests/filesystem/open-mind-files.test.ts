import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, watch, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  DEFAULT_VAULT_LIMITS,
  MAX_VAULT_LIMITS,
  VaultFileError,
  createVaultFileSystem,
} from "../../src/filesystem/vault-files.ts"

async function fixture(t: { after(callback: () => void | Promise<void>): void }) {
  const parent = await mkdtemp(join(tmpdir(), "open-mind-files-test-"))
  const vaultPath = join(parent, "vault")
  const outsidePath = join(parent, "outside")
  await mkdir(join(vaultPath, "projetos"), { recursive: true })
  await mkdir(outsidePath)
  t.after(() => rm(parent, { recursive: true, force: true }))
  return { vaultPath, outsidePath, vault: await createVaultFileSystem(vaultPath) }
}

async function assertVaultError(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof VaultFileError)
    assert.equal(error.code, code)
    assert.doesNotMatch(error.message, /[A-Z]:\\|Users\\|open-mind-files-test-/i)
    return true
  })
}

test("resolve normaliza separadores mistos sem sair do Vault", async (t) => {
  const { vault } = await fixture(t)

  assert.equal(await vault.resolveMarkdownPath("projetos\\alpha/nota.md"), "projetos/alpha/nota.md")
  assert.equal(await vault.resolveMarkdownPath("projetos/./alpha\\nota.md"), "projetos/alpha/nota.md")
})

test("rejeita raiz do Vault relativa ou que não seja diretório", async (t) => {
  const { vaultPath } = await fixture(t)
  await writeFile(join(vaultPath, "arquivo.md"), "conteúdo")

  await assertVaultError(createVaultFileSystem("vault-relativo"), "INVALID_VAULT_ROOT")
  await assertVaultError(createVaultFileSystem(join(vaultPath, "arquivo.md")), "INVALID_VAULT_ROOT")
})

test("rejeita traversal, caminho absoluto e arquivos que não sejam Markdown", async (t) => {
  const { vault, outsidePath } = await fixture(t)

  await assertVaultError(vault.resolveMarkdownPath("../outside/nota.md"), "INVALID_PATH")
  await assertVaultError(vault.resolveMarkdownPath("..\\outside\\nota.md"), "INVALID_PATH")
  await assertVaultError(vault.resolveMarkdownPath(resolve(outsidePath, "nota.md")), "INVALID_PATH")
  await assertVaultError(vault.resolveMarkdownPath("C:\\outside\\nota.md"), "INVALID_PATH")
  await assertVaultError(vault.resolveMarkdownPath("notas/segredo.txt"), "NOT_MARKDOWN")
})

test("confina leitura e existência ao Vault", async (t) => {
  const { vaultPath, vault, outsidePath } = await fixture(t)
  await writeFile(join(vaultPath, "nota.md"), "conteúdo")
  await writeFile(join(outsidePath, "fora.md"), "fora")

  assert.equal(await vault.existsMarkdown("nota.md"), true)
  assert.equal(await vault.existsMarkdown("ausente.md"), false)
  assert.equal(await vault.readMarkdown("nota.md"), "conteúdo")
  await assertVaultError(vault.readMarkdown(resolve(outsidePath, "fora.md")), "INVALID_PATH")
})

test("lê arquivo vazio e rejeita tamanho excedido ou diretório como arquivo", async (t) => {
  const { vaultPath, vault } = await fixture(t)
  await writeFile(join(vaultPath, "vazio.md"), "")
  await writeFile(join(vaultPath, "grande.md"), "123456")
  await mkdir(join(vaultPath, "pasta.md"))
  const smallVault = await createVaultFileSystem(vaultPath, {
    maxReadBytes: 5,
    maxWriteBytes: 5,
    maxProjectMetadataBytes: 5,
  })

  assert.equal(await vault.readMarkdown("vazio.md"), "")
  await assertVaultError(smallVault.readMarkdown("grande.md"), "LIMIT_EXCEEDED")
  await assertVaultError(vault.readMarkdown("pasta.md"), "NOT_FILE")
})

test("lista apenas Markdown no diretório solicitado sem recursão implícita", async (t) => {
  const { vaultPath, vault } = await fixture(t)
  await writeFile(join(vaultPath, "top.md"), "top")
  await writeFile(join(vaultPath, "ignore.txt"), "txt")
  await mkdir(join(vaultPath, "nested"))
  await writeFile(join(vaultPath, "nested", "deep.md"), "deep")

  assert.deepEqual(await vault.listMarkdown(""), ["top.md"])
  assert.deepEqual(await vault.listMarkdown("", { recursive: true }), ["nested/deep.md", "top.md"])
})

test("lista é limitada e diretórios externos não são listados", async (t) => {
  const { vaultPath, vault, outsidePath } = await fixture(t)
  await writeFile(join(vaultPath, "a.md"), "a")
  await writeFile(join(vaultPath, "b.md"), "b")
  const limited = await createVaultFileSystem(vaultPath, { maxListEntries: 1 })

  await assertVaultError(limited.listMarkdown(""), "LIMIT_EXCEEDED")
  await assertVaultError(limited.listMarkdown("", { maxEntries: 2 }), "LIMIT_EXCEEDED")
  await assertVaultError(vault.listMarkdown(resolve(outsidePath)), "INVALID_PATH")
})

test("não permite configurar limites acima do teto de segurança", async (t) => {
  const { vaultPath } = await fixture(t)

  await assertVaultError(
    createVaultFileSystem(vaultPath, { maxReadBytes: MAX_VAULT_LIMITS.maxReadBytes + 1 }),
    "LIMIT_EXCEEDED",
  )
})

test("permite symlink para dentro do Vault e bloqueia link para fora", async (t) => {
  const { vaultPath, vault, outsidePath } = await fixture(t)
  await writeFile(join(vaultPath, "interno.md"), "interno")
  await writeFile(join(outsidePath, "externo.md"), "externo")
  try {
    await symlink(join(vaultPath, "interno.md"), join(vaultPath, "atalho.md"), "file")
    await symlink(join(outsidePath, "externo.md"), join(vaultPath, "escape.md"), "file")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return t.skip("symlink indisponível nesta plataforma")
    throw error
  }

  assert.equal(await vault.readMarkdown("atalho.md"), "interno")
  await assertVaultError(vault.readMarkdown("escape.md"), "OUTSIDE_VAULT")
})

test("bloqueia escape por diretório simbólico e aceita diretório interno", async (t) => {
  const { vaultPath, vault, outsidePath } = await fixture(t)
  await mkdir(join(vaultPath, "interno"))
  await writeFile(join(vaultPath, "interno", "nota.md"), "interno")
  await writeFile(join(outsidePath, "nota.md"), "externo")
  try {
    await symlink(join(vaultPath, "interno"), join(vaultPath, "link-interno"), "junction")
    await symlink(outsidePath, join(vaultPath, "link-externo"), "junction")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return t.skip("symlink indisponível nesta plataforma")
    throw error
  }

  assert.equal(await vault.readMarkdown("link-interno/nota.md"), "interno")
  await assertVaultError(vault.readMarkdown("link-externo/nota.md"), "OUTSIDE_VAULT")
  await assertVaultError(vault.listMarkdown("link-externo"), "OUTSIDE_VAULT")
  const bestEffort = await createVaultFileSystem(vaultPath, { writePolicy: "best-effort" })
  await assertVaultError(bestEffort.createMarkdown("link-externo/nova.md", "não gravar fora"), "OUTSIDE_VAULT")
})

test("revalida caminhos após alteração para symlink externo", async (t) => {
  const { vaultPath, vault, outsidePath } = await fixture(t)
  await writeFile(join(vaultPath, "alvo.md"), "interno")
  await writeFile(join(outsidePath, "alvo.md"), "externo")
  await vault.resolveMarkdownPath("alvo.md")
  await rm(join(vaultPath, "alvo.md"))
  try {
    await symlink(join(outsidePath, "alvo.md"), join(vaultPath, "alvo.md"), "file")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return t.skip("symlink indisponível nesta plataforma")
    throw error
  }

  await assertVaultError(vault.readMarkdown("alvo.md"), "OUTSIDE_VAULT")
})

test("cria sem sobrescrever, atualiza por hash e preserva integridade", async (t) => {
  const { vaultPath, vault } = await fixture(t)
  const bestEffort = await createVaultFileSystem(vaultPath, { writePolicy: "best-effort" })
  const created = await bestEffort.createMarkdown("nota.md", "primeiro conteúdo")

  assert.equal(await readFile(join(vaultPath, "nota.md"), "utf8"), "primeiro conteúdo")
  await assertVaultError(bestEffort.createMarkdown("nota.md", "sobrescrever"), "ALREADY_EXISTS")

  const updated = await bestEffort.updateMarkdown("nota.md", "conteúdo atualizado", created.sha256)
  assert.equal(await readFile(join(vaultPath, "nota.md"), "utf8"), "conteúdo atualizado")
  assert.notEqual(updated.sha256, created.sha256)
  await assertVaultError(bestEffort.updateMarkdown("nota.md", "perder alteração", created.sha256), "HASH_MISMATCH")
  assert.equal(await readFile(join(vaultPath, "nota.md"), "utf8"), "conteúdo atualizado")
})

test("criações concorrentes não sobrescrevem e removem o temporário perdedor", async (t) => {
  const { vaultPath, vault } = await fixture(t)
  const bestEffort = await createVaultFileSystem(vaultPath, { writePolicy: "best-effort" })
  const results = await Promise.allSettled([
    bestEffort.createMarkdown("concorrente.md", "conteúdo A"),
    bestEffort.createMarkdown("concorrente.md", "conteúdo B"),
  ])

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  )
  const content = await readFile(join(vaultPath, "concorrente.md"), "utf8")
  assert.ok(content === "conteúdo A" || content === "conteúdo B")
  assert.equal((await readdir(vaultPath)).some((name) => name.includes("open-mind-tmp")), false)
})

test("atualizações concorrentes com o mesmo hash não perdem a segunda alteração", async (t) => {
  const { vaultPath, vault } = await fixture(t)
  const bestEffort = await createVaultFileSystem(vaultPath, { writePolicy: "best-effort" })
  const original = await bestEffort.createMarkdown("concorrente-update.md", "original")
  const updates = await Promise.allSettled([
    bestEffort.updateMarkdown("concorrente-update.md", "alteração A", original.sha256),
    bestEffort.updateMarkdown("concorrente-update.md", "alteração B", original.sha256),
  ])

  assert.equal(updates.filter((result) => result.status === "fulfilled").length, 1)
  const rejected = updates.find((result) => result.status === "rejected")
  assert.ok(rejected?.status === "rejected" && rejected.reason instanceof VaultFileError)
  assert.equal(rejected.reason.code, "HASH_MISMATCH")
  const content = await readFile(join(vaultPath, "concorrente-update.md"), "utf8")
  assert.ok(content === "alteração A" || content === "alteração B")
})

test("leitores observam o arquivo antigo ou o novo, nunca uma gravação parcial", async (t) => {
  const { vaultPath } = await fixture(t)
  const vault = await createVaultFileSystem(vaultPath, { writePolicy: "best-effort" })
  const oldContent = "A".repeat(400_000)
  const newContent = "B".repeat(400_000)
  const created = await vault.createMarkdown("atomic.md", oldContent)
  const reader = async () => {
    const snapshots: string[] = []
    for (let index = 0; index < 8; index++) snapshots.push(await vault.readMarkdown("atomic.md"))
    return snapshots
  }

  const [, snapshots] = await Promise.all([
    vault.updateMarkdown("atomic.md", newContent, created.sha256),
    reader(),
  ])

  assert.ok(snapshots.every((content) => content === oldContent || content === newContent))
})

test("limita bytes escritos e atualizações exigem hash válido", async (t) => {
  const { vaultPath, vault } = await fixture(t)
  const limited = await createVaultFileSystem(vaultPath, {
    maxWriteBytes: 4,
    writePolicy: "best-effort",
  })

  await assertVaultError(limited.createMarkdown("grande.md", "12345"), "LIMIT_EXCEEDED")
  const bestEffort = await createVaultFileSystem(vaultPath, { writePolicy: "best-effort" })
  await assertVaultError(bestEffort.updateMarkdown("ausente.md", "novo", "0".repeat(64)), "NOT_FOUND")
  assert.equal((await readdir(vaultPath)).some((name) => name.includes("open-mind-tmp")), false)
  assert.equal(DEFAULT_VAULT_LIMITS.maxReadBytes > 0, true)
})

test("recusa criação e atualização sem opt-in antes de alterar o Vault", async (t) => {
  const { vaultPath, vault } = await fixture(t)
  await writeFile(join(vaultPath, "existente.md"), "original")
  const hash = "0".repeat(64)

  await assertVaultError(vault.createMarkdown("novo.md", "conteúdo"), "WRITES_DISABLED")
  await assertVaultError(vault.updateMarkdown("existente.md", "alterado", hash), "WRITES_DISABLED")
  assert.equal((await readdir(vaultPath)).includes("novo.md"), false)
  assert.equal(await readFile(join(vaultPath, "existente.md"), "utf8"), "original")
  assert.equal((await readdir(vaultPath)).some((name) => name.includes("open-mind-tmp")), false)
})

test("best-effort exige hash SHA-256 válido para atualização", async (t) => {
  const { vaultPath } = await fixture(t)
  const bestEffort = await createVaultFileSystem(vaultPath, { writePolicy: "best-effort" })
  await writeFile(join(vaultPath, "nota.md"), "original")

  await assertVaultError(bestEffort.updateMarkdown("nota.md", "alterado", "hash-inválido"), "HASH_MISMATCH")
  assert.equal(await readFile(join(vaultPath, "nota.md"), "utf8"), "original")
})

test("best-effort recusa pai redirecionado para fora antes de criar temporário", async (t) => {
  const { vaultPath, outsidePath } = await fixture(t)
  const bestEffort = await createVaultFileSystem(vaultPath, { writePolicy: "best-effort" })
  try {
    await symlink(outsidePath, join(vaultPath, "parent-escape"), "junction")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
      return t.skip("junction indisponível nesta plataforma; recusa padrão permanece coberta")
    }
    throw error
  }

  await assertVaultError(bestEffort.createMarkdown("parent-escape/fora.md", "não gravar"), "OUTSIDE_VAULT")
  assert.deepEqual(await readdir(outsidePath), [])
  assert.equal((await readdir(vaultPath)).some((name) => name.includes("open-mind-tmp")), false)
})

test("detecta troca do diretório pai após criar o temporário e limpa o temporário", async (t) => {
  const { vaultPath } = await fixture(t)
  const bestEffort = await createVaultFileSystem(vaultPath, { writePolicy: "best-effort" })
  const originalParent = join(vaultPath, "projetos")
  const movedParent = join(vaultPath, "projetos-moved")
  const watcher = watch(originalParent)
  let raceBlockedByPlatform = false
  t.after(async () => {
    await watcher.return?.()
  })

  const swapParent = (async () => {
    for await (const event of watcher) {
      if (!String(event.filename ?? "").includes(".open-mind-")) continue
      await watcher.return?.()
      try {
        await rename(originalParent, movedParent)
        await symlink(movedParent, originalParent, "junction")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          raceBlockedByPlatform = true
          return
        }
        throw error
      }
      return
    }
  })()

  const writeResult = bestEffort
    .createMarkdown("projetos/race.md", "conteúdo".repeat(20_000))
    .then((value) => ({ status: "fulfilled" as const, value }), (reason: unknown) => ({ status: "rejected" as const, reason }))
  await swapParent
  const result = await writeResult
  if (raceBlockedByPlatform) {
    return t.skip("Windows não permite renomear o diretório enquanto o arquivo temporário está aberto; corrida fica pendente")
  }
  assert.equal(result.status, "rejected")
  if (result.status === "rejected") {
    assert.ok(result.reason instanceof VaultFileError)
    assert.equal(result.reason.code, "PATH_CHANGED")
  }
  assert.equal((await readdir(originalParent)).includes("race.md"), false)
  assert.equal((await readdir(movedParent)).some((name) => name.includes("open-mind-tmp")), false)
})

test("detecta alteração externa observável durante a preparação da atualização", async (t) => {
  const { vaultPath } = await fixture(t)
  const bestEffort = await createVaultFileSystem(vaultPath, { writePolicy: "best-effort" })
  const filePath = join(vaultPath, "external-edit.md")
  const created = await bestEffort.createMarkdown("external-edit.md", "original")
  const watcher = watch(vaultPath)
  t.after(async () => {
    await watcher.return?.()
  })

  const externalEdit = (async () => {
    for await (const event of watcher) {
      if (!String(event.filename ?? "").includes(".open-mind-")) continue
      await writeFile(filePath, "alteração externa")
      return
    }
  })()

  await assertVaultError(
    bestEffort.updateMarkdown("external-edit.md", "novo conteúdo".repeat(20_000), created.sha256),
    "HASH_MISMATCH",
  )
  await externalEdit
  assert.equal(await readFile(filePath, "utf8"), "alteração externa")
  assert.equal((await readdir(vaultPath)).some((name) => name.includes("open-mind-tmp")), false)
})

test("limita leitura de prefixo usado para metadados", async (t) => {
  const { vaultPath, vault } = await fixture(t)
  await writeFile(join(vaultPath, "metadata.md"), "caminho: /projeto\n" + "x".repeat(100))

  const prefix = await vault.readMarkdownPrefix("metadata.md", 16)

  assert.equal(prefix.content.length, 16)
  assert.equal(prefix.truncated, true)
})

test("readMarkdownDocument retorna hash dos bytes e tamanho exato", async (t) => {
  const { vaultPath, vault } = await fixture(t)
  const content = "# Nota com acentuação\n\nconteúdo"
  await writeFile(join(vaultPath, "hash.md"), content, "utf8")
  const document = await vault.readMarkdownDocument("hash.md")

  assert.equal(document.content, content)
  assert.equal(document.bytes, Buffer.byteLength(content, "utf8"))
  assert.equal(document.sha256, createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex"))
})

test("scanMarkdown devolve resultados parciais e sinaliza truncamento", async (t) => {
  const { vaultPath, vault } = await fixture(t)
  await mkdir(join(vaultPath, "scan"))
  for (let index = 0; index < 5; index++) {
    await writeFile(join(vaultPath, "scan", `scan-${index}.md`), "conteúdo")
  }

  const full = await vault.scanMarkdown("scan", { maxEntries: 10 })
  const partial = await vault.scanMarkdown("scan", { maxEntries: 2 })

  assert.equal(full.paths.length, 5)
  assert.equal(full.truncated, false)
  assert.equal(partial.paths.length, 2)
  assert.equal(partial.truncated, true)
  assert.deepEqual(partial.reasons, ["entries"])
})
