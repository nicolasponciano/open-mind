import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { link, lstat, open, opendir, realpath, rename, stat, unlink } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, sep, win32 } from "node:path"

export const DEFAULT_VAULT_LIMITS = {
  maxReadBytes: 1024 * 1024,
  maxWriteBytes: 1024 * 1024,
  maxListEntries: 512,
  maxProjectFiles: 128,
  maxProjectMetadataBytes: 16 * 1024,
} as const

export const MAX_VAULT_LIMITS = {
  maxReadBytes: 16 * 1024 * 1024,
  maxWriteBytes: 16 * 1024 * 1024,
  maxListEntries: 4096,
  maxProjectFiles: 512,
  maxProjectMetadataBytes: 64 * 1024,
} as const

export type VaultFileErrorCode =
  | "INVALID_VAULT_ROOT"
  | "INVALID_PATH"
  | "NOT_MARKDOWN"
  | "OUTSIDE_VAULT"
  | "NOT_FOUND"
  | "NOT_FILE"
  | "NOT_DIRECTORY"
  | "ALREADY_EXISTS"
  | "HASH_MISMATCH"
  | "WRITES_DISABLED"
  | "LIMIT_EXCEEDED"
  | "PATH_CHANGED"
  | "IO_ERROR"

export class VaultFileError extends Error {
  readonly code: VaultFileErrorCode

  constructor(code: VaultFileErrorCode, message: string) {
    super(`Open Mind: ${message}`)
    this.name = "VaultFileError"
    this.code = code
  }
}

/**
 * `best-effort` is an explicit local opt-in, not a cross-process CAS or a guarantee
 * against an adversarial parent-directory swap. Keep disabled where external writers may run.
 */
export type VaultWritePolicy = "disabled" | "best-effort"
export type VaultFileSystemOptions = Partial<Record<keyof typeof DEFAULT_VAULT_LIMITS, number>> & {
  writePolicy?: VaultWritePolicy
}

export type VaultFileSystem = {
  resolveMarkdownPath(path: string): Promise<string>
  existsMarkdown(path: string): Promise<boolean>
  readMarkdown(path: string, maxBytes?: number): Promise<string>
  readMarkdownPrefix(path: string, maxBytes: number): Promise<{ content: string; truncated: boolean }>
  /** Hash and byte count come from the same read used to decode `content`. */
  readMarkdownDocument(path: string, maxBytes?: number): Promise<{ content: string; sha256: string; bytes: number }>
  listMarkdown(
    directory?: string,
    options?: { recursive?: boolean; maxDepth?: number; maxEntries?: number },
  ): Promise<string[]>
  /** Like `listMarkdown`, but keeps partial results instead of failing at a limit. */
  scanMarkdown(
    directory?: string,
    options?: { maxDepth?: number; maxEntries?: number },
  ): Promise<{ paths: string[]; truncated: boolean; reasons: Array<"entries" | "depth"> }>
  createMarkdown(path: string, content: string): Promise<{ path: string; sha256: string }>
  updateMarkdown(path: string, content: string, expectedHash: string): Promise<{ path: string; sha256: string }>
}

type FileIdentity = { dev: number; ino: number }
type OpenMarkdown = { handle: Awaited<ReturnType<typeof open>>; identity: FileIdentity }
const updateLocks = new Map<string, Promise<void>>()

function fail(code: VaultFileErrorCode, message: string): never {
  throw new VaultFileError(code, message)
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined
}

function mapIoError(error: unknown): never {
  if (error instanceof VaultFileError) throw error
  switch (errorCode(error)) {
    case "ENOENT":
      return fail("NOT_FOUND", "arquivo ou diretório não encontrado dentro do Vault.")
    case "EEXIST":
      return fail("ALREADY_EXISTS", "o arquivo já existe; nenhuma sobrescrita foi feita.")
    case "EISDIR":
    case "ENOTDIR":
      return fail("NOT_FILE", "o caminho não aponta para um arquivo Markdown regular.")
    default:
      return fail("IO_ERROR", "não foi possível concluir a operação no Vault.")
  }
}

function isInside(root: string, candidate: string) {
  const rel = relative(root, candidate)
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
}

function pathParts(path: string, allowEmpty = false) {
  if (typeof path !== "string" || path.includes("\0")) fail("INVALID_PATH", "caminho relativo inválido.")

  const portable = path.replaceAll("\\", "/")
  if (
    portable.startsWith("/") ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    /^[a-zA-Z]:/.test(path)
  ) {
    fail("INVALID_PATH", "use um caminho relativo à raiz do Vault.")
  }

  const parts = portable.split("/").filter((part) => part !== "" && part !== ".")
  if (parts.some((part) => part === "..")) fail("INVALID_PATH", "path traversal não é permitido.")
  if (!parts.length && !allowEmpty) fail("INVALID_PATH", "informe um caminho relativo dentro do Vault.")
  return parts
}

function relativePosix(root: string, target: string) {
  return relative(root, target).split(sep).join("/")
}

function hasMarkdownExtension(path: string) {
  return extname(path).toLowerCase() === ".md"
}

function sameIdentity(left: FileIdentity, right: FileIdentity) {
  return left.dev === right.dev && left.ino !== 0 && left.ino === right.ino
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex")
}

function validateLimit(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) fail("LIMIT_EXCEEDED", `${label} precisa ser um inteiro positivo.`)
}

export async function canonicalizeVaultRoot(vaultRoot: string) {
  if (typeof vaultRoot !== "string" || (!isAbsolute(vaultRoot) && !win32.isAbsolute(vaultRoot))) {
    fail("INVALID_VAULT_ROOT", "a raiz do Vault precisa ser um caminho absoluto.")
  }

  try {
    const root = await realpath(vaultRoot)
    if (!(await stat(root)).isDirectory()) fail("INVALID_VAULT_ROOT", "a raiz configurada do Vault não é um diretório.")
    return root
  } catch (error) {
    if (error instanceof VaultFileError) throw error
    fail("INVALID_VAULT_ROOT", "a raiz configurada do Vault não existe ou está inacessível.")
  }
}

export async function createVaultFileSystem(
  vaultRoot: string,
  options: VaultFileSystemOptions = {},
): Promise<VaultFileSystem> {
  const root = await canonicalizeVaultRoot(vaultRoot)

  const { writePolicy = "disabled", ...limitOptions } = options
  const limits = { ...DEFAULT_VAULT_LIMITS, ...limitOptions }
  validateLimit(limits.maxReadBytes, "maxReadBytes")
  validateLimit(limits.maxWriteBytes, "maxWriteBytes")
  validateLimit(limits.maxListEntries, "maxListEntries")
  validateLimit(limits.maxProjectFiles, "maxProjectFiles")
  validateLimit(limits.maxProjectMetadataBytes, "maxProjectMetadataBytes")
  if (
    limits.maxReadBytes > MAX_VAULT_LIMITS.maxReadBytes ||
    limits.maxWriteBytes > MAX_VAULT_LIMITS.maxWriteBytes ||
    limits.maxListEntries > MAX_VAULT_LIMITS.maxListEntries ||
    limits.maxProjectFiles > MAX_VAULT_LIMITS.maxProjectFiles ||
    limits.maxProjectMetadataBytes > MAX_VAULT_LIMITS.maxProjectMetadataBytes
  ) {
    fail("LIMIT_EXCEEDED", "um limite configurado excede o máximo permitido pelo Core.")
  }
  if (limits.maxWriteBytes > limits.maxReadBytes || limits.maxProjectMetadataBytes > limits.maxReadBytes) {
    fail("LIMIT_EXCEEDED", "limites de escrita e metadados não podem exceder maxReadBytes.")
  }
  async function withUpdateLock<T>(path: string, action: () => Promise<T>): Promise<T> {
    const previous = updateLocks.get(path) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    updateLocks.set(path, current)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (updateLocks.get(path) === current) updateLocks.delete(path)
    }
  }

  function absoluteFromRelative(path: string) {
    return join(root, ...path.split("/"))
  }

  async function resolveExisting(path: string, expectedKind: "file" | "directory") {
    const parts = pathParts(path, expectedKind === "directory")
    if (expectedKind === "file" && !hasMarkdownExtension(parts.at(-1) ?? "")) {
      fail("NOT_MARKDOWN", "somente arquivos com extensão .md são permitidos.")
    }

    const lexicalPath = join(root, ...parts)
    try {
      const before = await lstat(lexicalPath)
      const canonicalPath = await realpath(lexicalPath)
      if (!isInside(root, canonicalPath)) fail("OUTSIDE_VAULT", "o caminho resolve para fora da raiz do Vault.")
      const after = await lstat(lexicalPath)
      if (before.ino !== 0 && after.ino !== 0 && !sameIdentity(before, after)) {
        fail("PATH_CHANGED", "o caminho mudou durante a validação; tente novamente.")
      }

      const info = await stat(canonicalPath)
      if (expectedKind === "file" && !info.isFile()) fail("NOT_FILE", "o caminho não aponta para um arquivo Markdown regular.")
      if (expectedKind === "directory" && !info.isDirectory()) fail("NOT_DIRECTORY", "o caminho não aponta para um diretório do Vault.")
      if (expectedKind === "file" && !hasMarkdownExtension(canonicalPath)) {
        fail("NOT_MARKDOWN", "o destino do link não é um arquivo Markdown.")
      }
      return relativePosix(root, canonicalPath)
    } catch (error) {
      mapIoError(error)
    }
  }

  async function resolveParentForCreate(path: string) {
    const parts = pathParts(path)
    if (!hasMarkdownExtension(parts.at(-1) ?? "")) fail("NOT_MARKDOWN", "somente arquivos com extensão .md são permitidos.")
    const lexicalPath = join(root, ...parts)

    try {
      const existing = await lstat(lexicalPath)
      const canonical = await realpath(lexicalPath)
      if (!isInside(root, canonical)) fail("OUTSIDE_VAULT", "o caminho resolve para fora da raiz do Vault.")
      if (existing.isSymbolicLink()) {
        const info = await stat(canonical)
        if (info.isFile() && hasMarkdownExtension(canonical)) {
          fail("ALREADY_EXISTS", "o arquivo já existe; nenhuma sobrescrita foi feita.")
        }
      }
      fail("ALREADY_EXISTS", "o arquivo já existe; nenhuma sobrescrita foi feita.")
    } catch (error) {
      if (!(errorCode(error) === "ENOENT")) mapIoError(error)
    }

    const parent = dirname(lexicalPath)
    let canonicalParent: string
    try {
      canonicalParent = await realpath(parent)
      if (!isInside(root, canonicalParent)) fail("OUTSIDE_VAULT", "o diretório de destino resolve para fora do Vault.")
      if (!(await stat(canonicalParent)).isDirectory()) fail("NOT_DIRECTORY", "o diretório de destino não é válido.")
    } catch (error) {
      mapIoError(error)
    }

    const parentInfo = await stat(canonicalParent)
    return {
      path: relativePosix(root, join(canonicalParent, basename(lexicalPath))),
      parent: canonicalParent,
      parentIdentity: { dev: parentInfo.dev, ino: parentInfo.ino },
    }
  }

  async function resolveForFuture(path: string) {
    const parts = pathParts(path)
    if (!hasMarkdownExtension(parts.at(-1) ?? "")) fail("NOT_MARKDOWN", "somente caminhos com extensão .md são permitidos.")
    let remaining = [...parts]
    let current = root

    while (remaining.length) {
      const candidate = join(current, remaining[0])
      try {
        const canonical = await realpath(candidate)
        if (!isInside(root, canonical)) fail("OUTSIDE_VAULT", "o caminho resolve para fora da raiz do Vault.")
        current = canonical
        remaining.shift()
      } catch (error) {
        if (errorCode(error) !== "ENOENT") mapIoError(error)
        return [...relativePosix(root, current).split("/").filter(Boolean), ...remaining].join("/")
      }
    }

    return relativePosix(root, current)
  }

  async function ensureParentUnchanged(
    path: string,
    expectedParent: string,
    expectedIdentity: FileIdentity,
  ) {
    const parent = dirname(absoluteFromRelative(path))
    try {
      const currentParent = await realpath(parent)
      if (!isInside(root, currentParent)) fail("OUTSIDE_VAULT", "o diretório de destino resolve para fora do Vault.")
      if (currentParent !== expectedParent) fail("PATH_CHANGED", "o diretório de destino mudou durante a operação.")
      const info = await stat(currentParent)
      if (expectedIdentity.ino !== 0 && !sameIdentity(expectedIdentity, info)) {
        fail("PATH_CHANGED", "a identidade do diretório de destino mudou durante a operação.")
      }
    } catch (error) {
      mapIoError(error)
    }
  }

  async function openSecureFile(path: string): Promise<OpenMarkdown> {
    const canonicalRelative = await resolveExisting(path, "file")
    const absolutePath = absoluteFromRelative(canonicalRelative)
    let handle: Awaited<ReturnType<typeof open>> | undefined

    try {
      const before = await lstat(absolutePath)
      if (before.isSymbolicLink() || !before.isFile()) fail("PATH_CHANGED", "o arquivo mudou durante a validação.")
      const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)
      handle = await open(absolutePath, constants.O_RDONLY | noFollow)
      const opened = await handle.stat()
      if (!opened.isFile()) fail("NOT_FILE", "o caminho não aponta para um arquivo Markdown regular.")

      const finalPath = await realpath(absolutePath)
      if (!isInside(root, finalPath)) fail("OUTSIDE_VAULT", "o caminho resolve para fora da raiz do Vault.")
      const finalInfo = await stat(finalPath)
      if (opened.ino !== 0 && finalInfo.ino !== 0 && !sameIdentity(opened, finalInfo)) {
        fail("PATH_CHANGED", "o arquivo mudou durante a abertura; tente novamente.")
      }
      return { handle, identity: { dev: opened.dev, ino: opened.ino } }
    } catch (error) {
      if (handle) await handle.close().catch(() => {})
      mapIoError(error)
    }
  }

  async function readHandle(handle: Awaited<ReturnType<typeof open>>, maxBytes: number) {
    validateLimit(maxBytes, "maxBytes")
    if (maxBytes > limits.maxReadBytes) fail("LIMIT_EXCEEDED", "o limite solicitado excede o limite máximo de leitura.")
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let total = 0

    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null)
      if (bytesRead === 0) break
      total += bytesRead
    }

    if (total > maxBytes) fail("LIMIT_EXCEEDED", "o arquivo excede o limite máximo de leitura.")
    return buffer.subarray(0, total)
  }

  async function removeTemp(tempPath: string, expectedParent: string, expectedIdentity: FileIdentity) {
    try {
      const currentParent = await realpath(dirname(tempPath))
      if (!isInside(root, currentParent)) return
      const info = await stat(currentParent)
      const samePath = currentParent === expectedParent
      const sameDirectory = expectedIdentity.ino !== 0 && sameIdentity(expectedIdentity, info)
      if (!samePath && !sameDirectory) return
      await unlink(tempPath)
    } catch {
      // Cleanup is best-effort; never follow a parent that changed outside the Vault.
    }
  }

  async function writeTemp(parent: string, bytes: Buffer, parentIdentity: FileIdentity) {
    const tempPath = join(parent, `.open-mind-${randomUUID()}.open-mind-tmp`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(tempPath, "wx", 0o600)
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      handle = undefined
      return tempPath
    } catch (error) {
      if (handle) await handle.close().catch(() => {})
      await removeTemp(tempPath, parent, parentIdentity)
      mapIoError(error)
    }
  }

  function contentBuffer(content: string) {
    if (typeof content !== "string") fail("INVALID_PATH", "o conteúdo precisa ser texto Markdown.")
    const bytes = Buffer.from(content, "utf8")
    if (bytes.byteLength > limits.maxWriteBytes) fail("LIMIT_EXCEEDED", "o conteúdo excede o limite máximo de escrita.")
    return bytes
  }

  async function readExistingBytes(path: string) {
    const opened = await openSecureFile(path)
    try {
      if ((await opened.handle.stat()).size > limits.maxReadBytes) {
        fail("LIMIT_EXCEEDED", "o arquivo excede o limite máximo de leitura.")
      }
      return { bytes: await readHandle(opened.handle, limits.maxReadBytes), identity: opened.identity }
    } catch (error) {
      mapIoError(error)
    } finally {
      await opened.handle.close()
    }
  }

  async function walkMarkdown(
    directory: string,
    options: { recursive: boolean; maxDepth: number; maxEntries: number; partial: boolean },
  ) {
    const { recursive, maxDepth, maxEntries, partial } = options
    const rootRelative = directory ? await resolveExisting(directory, "directory") : ""
    const rootAbsolute = rootRelative ? absoluteFromRelative(rootRelative) : root
    const result: string[] = []
    const seenDirectories = new Set<string>()
    const reasons = new Set<"entries" | "depth">()
    let visitedEntries = 0
    let stopped = false

    const walk = async (currentRelative: string, depth: number): Promise<void> => {
      if (stopped) return
      let canonicalDirectory: string
      try {
        canonicalDirectory = await realpath(currentRelative ? absoluteFromRelative(currentRelative) : rootAbsolute)
        if (!isInside(root, canonicalDirectory)) fail("OUTSIDE_VAULT", "o diretório resolve para fora da raiz do Vault.")
      } catch (error) {
        mapIoError(error)
      }
      if (seenDirectories.has(canonicalDirectory)) return
      seenDirectories.add(canonicalDirectory)

      let dir: Awaited<ReturnType<typeof opendir>> | undefined
      try {
        dir = await opendir(canonicalDirectory)
        const afterOpen = await realpath(canonicalDirectory)
        if (!isInside(root, afterOpen)) fail("OUTSIDE_VAULT", "o diretório resolve para fora da raiz do Vault.")
        if (afterOpen !== canonicalDirectory) fail("PATH_CHANGED", "o diretório mudou durante a listagem.")
        for await (const entry of dir) {
          if (stopped) break
          visitedEntries++
          if (visitedEntries > maxEntries) {
            if (!partial) fail("LIMIT_EXCEEDED", "o diretório excede o limite de entradas analisadas.")
            reasons.add("entries")
            stopped = true
            break
          }
          const childRelative = [currentRelative, entry.name].filter(Boolean).join("/")
          if (entry.isDirectory()) {
            if (!recursive) continue
            if (depth >= maxDepth) {
              if (!partial) fail("LIMIT_EXCEEDED", "a busca excedeu a profundidade máxima de diretórios.")
              reasons.add("depth")
              continue
            }
            await walk(childRelative, depth + 1)
            continue
          }
          if (!entry.name.toLowerCase().endsWith(".md")) continue
          if (entry.isFile()) {
            result.push(await resolveExisting(childRelative, "file"))
            continue
          }
          if (entry.isSymbolicLink()) {
            try {
              const target = await resolveExisting(childRelative, "file")
              result.push(target)
            } catch (error) {
              if (error instanceof VaultFileError && error.code === "NOT_FILE") continue
              throw error
            }
          }
        }
      } catch (error) {
        mapIoError(error)
      } finally {
        await dir?.close().catch(() => {})
      }
    }

    await walk(rootRelative, 0)
    return {
      paths: [...new Set(result)].sort((a, b) => a.localeCompare(b)),
      truncated: reasons.size > 0,
      reasons: [...reasons],
    }
  }

  return {
    async resolveMarkdownPath(path) {
      const parts = pathParts(path)
      if (!hasMarkdownExtension(parts.at(-1) ?? "")) fail("NOT_MARKDOWN", "somente caminhos com extensão .md são permitidos.")
      try {
        return await resolveExisting(path, "file")
      } catch (error) {
        if (!(error instanceof VaultFileError) || error.code !== "NOT_FOUND") throw error
        return resolveForFuture(path)
      }
    },

    async existsMarkdown(path) {
      try {
        const opened = await openSecureFile(path)
        await opened.handle.close()
        return true
      } catch (error) {
        if (error instanceof VaultFileError && error.code === "NOT_FOUND") return false
        throw error
      }
    },

    async readMarkdown(path, maxBytes = limits.maxReadBytes) {
      const opened = await openSecureFile(path)
      try {
        const bytes = await readHandle(opened.handle, maxBytes)
        return bytes.toString("utf8")
      } catch (error) {
        mapIoError(error)
      } finally {
        await opened.handle.close()
      }
    },

    async readMarkdownPrefix(path, maxBytes) {
      const opened = await openSecureFile(path)
      try {
        validateLimit(maxBytes, "maxBytes")
        if (maxBytes > limits.maxReadBytes) fail("LIMIT_EXCEEDED", "o limite solicitado excede o limite máximo de leitura.")
        const buffer = Buffer.allocUnsafe(maxBytes + 1)
        let total = 0
        while (total < buffer.length) {
          const { bytesRead } = await opened.handle.read(buffer, total, buffer.length - total, null)
          if (bytesRead === 0) break
          total += bytesRead
        }
        return {
          content: buffer.subarray(0, Math.min(total, maxBytes)).toString("utf8"),
          truncated: total > maxBytes,
        }
      } catch (error) {
        mapIoError(error)
      } finally {
        await opened.handle.close()
      }
    },

    async readMarkdownDocument(path, maxBytes = limits.maxReadBytes) {
      const opened = await openSecureFile(path)
      try {
        const bytes = await readHandle(opened.handle, maxBytes)
        return { content: bytes.toString("utf8"), sha256: sha256(bytes), bytes: bytes.byteLength }
      } catch (error) {
        mapIoError(error)
      } finally {
        await opened.handle.close()
      }
    },

    async listMarkdown(directory = "", listOptions = {}) {
      const { recursive = false, maxDepth = 4, maxEntries = limits.maxListEntries } = listOptions
      validateLimit(maxEntries, "maxEntries")
      if (maxEntries > limits.maxListEntries) fail("LIMIT_EXCEEDED", "maxEntries excede o limite da instância do Vault.")
      if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 16) {
        fail("LIMIT_EXCEEDED", "maxDepth precisa estar entre 0 e 16.")
      }

      const scan = await walkMarkdown(directory, { recursive, maxDepth, maxEntries, partial: false })
      return scan.paths
    },

    async scanMarkdown(directory = "", scanOptions = {}) {
      const { maxDepth = 4, maxEntries = limits.maxListEntries } = scanOptions
      validateLimit(maxEntries, "maxEntries")
      if (maxEntries > limits.maxListEntries) fail("LIMIT_EXCEEDED", "maxEntries excede o limite da instância do Vault.")
      if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 16) {
        fail("LIMIT_EXCEEDED", "maxDepth precisa estar entre 0 e 16.")
      }

      return walkMarkdown(directory, { recursive: true, maxDepth, maxEntries, partial: true })
    },

    async createMarkdown(path, content) {
      if (writePolicy !== "best-effort") {
        fail("WRITES_DISABLED", "escritas estão desabilitadas; habilite explicitamente a política best-effort nesta instância.")
      }
      const bytes = contentBuffer(content)
      const destination = await resolveParentForCreate(path)
      const absolutePath = absoluteFromRelative(destination.path)
      let tempPath: string | undefined
      try {
        await ensureParentUnchanged(destination.path, destination.parent, destination.parentIdentity)
        tempPath = await writeTemp(destination.parent, bytes, destination.parentIdentity)
        await ensureParentUnchanged(destination.path, destination.parent, destination.parentIdentity)
        await link(tempPath, absolutePath)
        // Detecta mudanças observáveis; não reverte nem torna atômica uma troca concorrente do pai.
        await ensureParentUnchanged(destination.path, destination.parent, destination.parentIdentity)
        return { path: destination.path, sha256: sha256(bytes) }
      } catch (error) {
        mapIoError(error)
      } finally {
        if (tempPath) await removeTemp(tempPath, destination.parent, destination.parentIdentity)
      }
    },

    async updateMarkdown(path, content, expectedHash) {
      if (writePolicy !== "best-effort") {
        fail("WRITES_DISABLED", "escritas estão desabilitadas; habilite explicitamente a política best-effort nesta instância.")
      }
      if (!/^[a-f0-9]{64}$/i.test(expectedHash)) fail("HASH_MISMATCH", "expectedHash precisa ser um SHA-256 válido.")
      const bytes = contentBuffer(content)
      const canonicalPath = await resolveExisting(path, "file")
      const absolutePath = absoluteFromRelative(canonicalPath)
      return withUpdateLock(absolutePath, async () => {
        const original = await readExistingBytes(canonicalPath)
        if (sha256(original.bytes) !== expectedHash.toLowerCase()) {
          fail("HASH_MISMATCH", "o arquivo mudou desde a leitura; atualize o contexto antes de gravar.")
        }

        const parent = dirname(absolutePath)
        const parentInfo = await stat(parent)
        const parentIdentity = { dev: parentInfo.dev, ino: parentInfo.ino }
        let tempPath: string | undefined
        try {
          await ensureParentUnchanged(canonicalPath, parent, parentIdentity)
          tempPath = await writeTemp(parent, bytes, parentIdentity)
          await ensureParentUnchanged(canonicalPath, parent, parentIdentity)
          const latest = await readExistingBytes(canonicalPath)
          if (sha256(latest.bytes) !== expectedHash.toLowerCase()) {
            fail("HASH_MISMATCH", "o arquivo mudou durante a atualização; nenhuma gravação foi feita.")
          }
          if (
            original.identity.ino !== 0 &&
            latest.identity.ino !== 0 &&
            !sameIdentity(original.identity, latest.identity)
          ) {
            fail("PATH_CHANGED", "o arquivo foi substituído durante a atualização; nenhuma gravação foi feita.")
          }
          const current = await resolveExisting(canonicalPath, "file")
          if (current !== canonicalPath) fail("PATH_CHANGED", "o caminho mudou durante a atualização.")
          await ensureParentUnchanged(canonicalPath, parent, parentIdentity)
          await rename(tempPath, absolutePath)
          tempPath = undefined
          // Observação posterior detecta alguns redirecionamentos, mas não impede uma escrita já ocorrida.
          await ensureParentUnchanged(canonicalPath, parent, parentIdentity)

          const result = await readExistingBytes(canonicalPath)
          const actualHash = sha256(result.bytes)
          if (actualHash !== sha256(bytes)) fail("PATH_CHANGED", "a verificação final da gravação não corresponde ao conteúdo enviado.")
          return { path: canonicalPath, sha256: actualHash }
        } catch (error) {
          mapIoError(error)
        } finally {
          if (tempPath) await removeTemp(tempPath, parent, parentIdentity)
        }
      })
    },
  }
}
