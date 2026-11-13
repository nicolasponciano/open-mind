import {
  DEFAULT_VAULT_LIMITS,
  VaultFileError,
  createVaultFileSystem,
  type VaultFileSystem,
  type VaultFileSystemOptions,
  type VaultFileErrorCode,
  type VaultWritePolicy,
} from "../filesystem/vault-files.ts"
import { resolveProjectContext } from "../core/open-mind-core.ts"

export const DEFAULT_SEARCH_LIMITS = {
  maxResults: 10,
  maxFiles: 128,
  maxDepth: 3,
  maxFileBytes: 64 * 1024,
  maxSnippetChars: 240,
  maxQueryChars: 200,
} as const

export const MAX_SEARCH_LIMITS = {
  maxResults: 25,
  maxFiles: 512,
  maxDepth: 8,
  maxFileBytes: 256 * 1024,
  maxSnippetChars: 400,
  maxQueryChars: 500,
} as const

export type JsonSchemaObject = { [key: string]: unknown }
export type OpenMindToolContext = {
  sessionID: string
  /** Agente efetivo da chamada, repassado pelo host quando disponível. */
  agent?: string
  /** Identificadores da chamada de ferramenta, repassados pelo host quando disponíveis. */
  messageID?: string
  callID?: string
}
export type OpenMindToolResult = { content: string; metadata: Record<string, unknown> }
export type OpenMindWriteAction = "open_mind_create" | "open_mind_update"
export type OpenMindAuthorization = {
  action: OpenMindWriteAction
  /** Caminho relativo canônico dentro do Vault. */
  path: string
  sessionID: string
  /** Presente somente quando o host forneceu o agente efetivo. */
  agent?: string
  /** Presente somente quando messageID e callID estão disponíveis. */
  source?: { messageID: string; callID: string }
}
export type OpenMindAuthorize = (request: OpenMindAuthorization) => Promise<void>

export type OpenMindTool = {
  name: string
  description: string
  input: JsonSchemaObject
  execute: (input: unknown, context: OpenMindToolContext) => Promise<OpenMindToolResult>
}

export type OpenMindToolsOptions = {
  vaultRoot: string
  /** Resolves the session project directory. Must never fall back to the global location. */
  getSessionDirectory: (sessionID: string) => Promise<string | undefined>
  readLimits?: Pick<VaultFileSystemOptions, "maxReadBytes" | "maxWriteBytes" | "maxProjectMetadataBytes">
  searchLimits?: Partial<typeof DEFAULT_SEARCH_LIMITS>
  /** Local opt-in. Defaults to "disabled"; tool arguments can never change it. */
  writePolicy?: VaultWritePolicy
  /** Required for writes when the policy is "best-effort". Rejections must propagate. */
  authorize?: OpenMindAuthorize
}

type SearchReason = "results" | "entries" | "depth" | "file_bytes"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireString(input: Record<string, unknown>, name: string, maxLength: number) {
  const value = input[name]
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidArguments(`${name} precisa ser um texto não vazio.`)
  }
  if (value.length > maxLength) {
    throw new InvalidArguments(`${name} excede o limite de ${maxLength} caracteres.`)
  }
  return value
}

function optionalString(input: Record<string, unknown>, name: string, maxLength: number) {
  const value = input[name]
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new InvalidArguments(`${name} precisa ser texto.`)
  if (value.length > maxLength) throw new InvalidArguments(`${name} excede o limite de ${maxLength} caracteres.`)
  return value
}

function optionalLimit(input: Record<string, unknown>, name: string, maximum: number) {
  const value = input[name]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new InvalidArguments(`${name} precisa ser um inteiro entre 1 e ${maximum}.`)
  }
  return value
}

function requireMarkdownContent(input: Record<string, unknown>, name: string, maxBytes: number) {
  const value = input[name]
  if (typeof value !== "string") throw new InvalidArguments(`${name} precisa ser texto Markdown.`)
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new VaultFileError("LIMIT_EXCEEDED", `${name} excede o limite máximo de escrita em bytes UTF-8.`)
  }
  return value
}

function contextText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function throwVault(code: VaultFileErrorCode, message: string): never {
  throw new VaultFileError(code, message)
}

class InvalidArguments extends Error {}

function ok(payload: Record<string, unknown>, metadata: Record<string, unknown> = {}) {
  return {
    content: JSON.stringify({ ok: true, ...payload }),
    metadata: { ok: true, ...metadata },
  }
}

function fail(code: string, message: string) {
  return {
    content: JSON.stringify({ ok: false, code, error: message }),
    metadata: { ok: false, code },
  }
}

/** Maps layer errors to stable codes; messages never include absolute paths. */
function errorResult(error: unknown): OpenMindToolResult {
  if (error instanceof InvalidArguments) return fail("INVALID_ARGUMENTS", error.message)
  if (error instanceof VaultFileError) {
    // VaultFileError messages are written by the layer and contain no absolute path.
    return fail(error.code, error.message.replace(/^Open Mind:\s*/, ""))
  }
  return fail("IO_ERROR", "não foi possível concluir a operação no Vault.")
}

function snippetFor(line: string, needle: string, maxChars: number) {
  const collapsed = line.replace(/\s+/g, " ").trim()
  if (collapsed.length <= maxChars) return collapsed
  const index = Math.max(0, collapsed.toLowerCase().indexOf(needle))
  const start = Math.max(0, Math.min(index - 40, collapsed.length - maxChars))
  const slice = collapsed.slice(start, start + maxChars)
  return `${start > 0 ? "…" : ""}${slice}${start + maxChars < collapsed.length ? "…" : ""}`
}

function parseSearchLimits(overrides: Partial<typeof DEFAULT_SEARCH_LIMITS> = {}) {
  const limits = { ...DEFAULT_SEARCH_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    const cap = MAX_SEARCH_LIMITS[name as keyof typeof MAX_SEARCH_LIMITS]
    if (!Number.isSafeInteger(value) || value < 1 || value > cap) {
      throw new VaultFileError("LIMIT_EXCEEDED", `limite de busca inválido: ${name}.`)
    }
  }
  return limits
}

export function createOpenMindTools(options: OpenMindToolsOptions): OpenMindTool[] {
  const searchLimits = parseSearchLimits(options.searchLimits)
  const configuredLimits = { ...DEFAULT_VAULT_LIMITS, ...options.readLimits }
  const writePolicy = options.writePolicy ?? "disabled"
  if (writePolicy !== "disabled" && writePolicy !== "best-effort") {
    throw new VaultFileError("WRITES_DISABLED", 'writePolicy inválida; use "best-effort" para habilitar escrita.')
  }
  let vaultPromise: Promise<VaultFileSystem> | undefined

  function getVault() {
    vaultPromise ??= createVaultFileSystem(options.vaultRoot, { ...options.readLimits, writePolicy })
    return vaultPromise
  }

  /**
   * Runs the configured authorization before any mutation. A rejection propagates to the host
   * (it must end the step, not turn into tool output). Missing authorizer fails closed.
   */
  async function authorizeWrite(
    action: OpenMindWriteAction,
    path: string,
    context: OpenMindToolContext,
  ): Promise<OpenMindToolResult | undefined> {
    if (!options.authorize) {
      return fail("AUTHORIZATION_UNAVAILABLE", "autorização de escrita indisponível; nenhuma alteração foi feita.")
    }
    const agent = contextText(context.agent)
    const messageID = contextText(context.messageID)
    const callID = contextText(context.callID)
    await options.authorize({
      action,
      path,
      sessionID: context.sessionID,
      ...(agent ? { agent } : {}),
      ...(messageID && callID ? { source: { messageID, callID } } : {}),
    })
    return undefined
  }

  async function sessionDirectory(sessionID: string) {
    try {
      const directory = await options.getSessionDirectory(sessionID)
      return typeof directory === "string" && directory.trim() ? directory : undefined
    } catch {
      return undefined
    }
  }

  async function baseFileStatus(vault: VaultFileSystem, path: string) {
    try {
      return (await vault.existsMarkdown(path)) ? "available" : "missing"
    } catch (error) {
      if (error instanceof VaultFileError && error.code === "NOT_FOUND") return "missing"
      if (error instanceof VaultFileError && (error.code === "NOT_FILE" || error.code === "NOT_MARKDOWN")) return "invalid"
      return "unavailable"
    }
  }

  const statusTool: OpenMindTool = {
    name: "open_mind_status",
    description:
      "Mostra o estado operacional do Open Mind: Vault acessível, arquivos-base, contexto do projeto da sessão e limites. Não retorna conteúdo de notas nem caminhos absolutos.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
    async execute(_input, context) {
      try {
        const vault = await getVault()
        const map = await baseFileStatus(vault, "00 - Open Mind.md")
        const agents = await baseFileStatus(vault, "AGENTS.md")
        const projectRoot = await sessionDirectory(context.sessionID)
        const resolution = await resolveProjectContext(vault, projectRoot)

        return ok(
          {
            vault: { configured: true, accessible: true },
            baseFiles: { map, agents },
            project: { status: resolution.status },
            writes: writePolicy,
            limits: {
              maxReadBytes: configuredLimits.maxReadBytes,
              maxWriteBytes: configuredLimits.maxWriteBytes,
              maxListEntries: configuredLimits.maxListEntries,
              maxProjectFiles: configuredLimits.maxProjectFiles,
              maxProjectMetadataBytes: configuredLimits.maxProjectMetadataBytes,
              search: { ...searchLimits },
            },
          },
          { projectStatus: resolution.status },
        )
      } catch (error) {
        if (error instanceof VaultFileError && error.code === "INVALID_VAULT_ROOT") {
          return ok({
            vault: { configured: true, accessible: false },
            baseFiles: { map: "unavailable", agents: "unavailable" },
            project: { status: "unavailable" },
            writes: writePolicy,
            limits: {
              maxReadBytes: configuredLimits.maxReadBytes,
              maxWriteBytes: configuredLimits.maxWriteBytes,
              maxListEntries: configuredLimits.maxListEntries,
              maxProjectFiles: configuredLimits.maxProjectFiles,
              maxProjectMetadataBytes: configuredLimits.maxProjectMetadataBytes,
              search: { ...searchLimits },
            },
          })
        }
        return errorResult(error)
      }
    },
  }

  const searchTool: OpenMindTool = {
    name: "open_mind_search",
    description:
      "Busca texto em notas Markdown do Vault, opcionalmente dentro de um diretório. Retorna trechos curtos, caminhos relativos e sinaliza quando o resultado está incompleto por limites.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, description: "Texto literal a procurar." },
        scope: { type: "string", description: "Diretório relativo ao Vault. Padrão: raiz." },
        limit: { type: "integer", minimum: 1, maximum: searchLimits.maxResults },
      },
      required: ["query"],
    },
    async execute(rawInput) {
      try {
        if (!isRecord(rawInput)) throw new InvalidArguments("argumentos inválidos.")
        const query = requireString(rawInput, "query", searchLimits.maxQueryChars).trim()
        const scope = optionalString(rawInput, "scope", 300)?.trim() ?? ""
        const maxResults = optionalLimit(rawInput, "limit", searchLimits.maxResults) ?? searchLimits.maxResults
        const needle = query.toLowerCase()
        const vault = await getVault()
        const scan = await vault.scanMarkdown(scope, {
          maxDepth: searchLimits.maxDepth,
          maxEntries: searchLimits.maxFiles,
        })

        const results: Array<{ path: string; line: number; snippet: string }> = []
        const reasons = new Set<SearchReason>(scan.reasons)
        let scannedFiles = 0
        let limitReached = false

        for (const path of scan.paths) {
          if (results.length > maxResults) break
          scannedFiles++
          const { content, truncated } = await vault.readMarkdownPrefix(path, searchLimits.maxFileBytes)
          if (truncated) reasons.add("file_bytes")

          const lines = content.split(/\r?\n/)
          for (let index = 0; index < lines.length; index++) {
            if (!lines[index].toLowerCase().includes(needle)) continue
            results.push({
              path,
              line: index + 1,
              snippet: snippetFor(lines[index], needle, searchLimits.maxSnippetChars),
            })
            if (results.length > maxResults) break
          }
        }

        if (results.length > maxResults) {
          results.length = maxResults
          limitReached = true
          reasons.add("results")
        }

        return ok(
          {
            query,
            scope: scope || ".",
            count: results.length,
            results,
            scannedFiles,
            limitReached,
            incomplete: reasons.size > 0,
            reasons: [...reasons],
          },
          { count: results.length, incomplete: reasons.size > 0 },
        )
      } catch (error) {
        return errorResult(error)
      }
    },
  }

  const readTool: OpenMindTool = {
    name: "open_mind_read",
    description:
      "Lê uma nota Markdown específica do Vault. Retorna conteúdo, tamanho e SHA-256 para uso futuro em atualizações. Aceita apenas caminhos relativos terminados em .md.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1, description: "Caminho relativo ao Vault, terminando em .md." },
      },
      required: ["path"],
    },
    async execute(rawInput) {
      try {
        if (!isRecord(rawInput)) throw new InvalidArguments("argumentos inválidos.")
        const path = requireString(rawInput, "path", 1024)
        const vault = await getVault()
        const document = await vault.readMarkdownDocument(path)
        return ok(
          { path, content: document.content, sha256: document.sha256, bytes: document.bytes },
          { path, bytes: document.bytes },
        )
      } catch (error) {
        return errorResult(error)
      }
    },
  }

  const createTool: OpenMindTool = {
    name: "open_mind_create",
    description:
      "Cria uma nota Markdown nova dentro do Vault. Só funciona com writePolicy best-effort e autorização explícita do usuário. Nunca sobrescreve arquivo existente. Retorna caminho relativo, SHA-256 e bytes gravados.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1, description: "Caminho relativo ao Vault, terminando em .md." },
        content: { type: "string", description: "Conteúdo Markdown completo da nota." },
      },
      required: ["path", "content"],
    },
    async execute(rawInput, context) {
      if (writePolicy !== "best-effort") {
        return fail("WRITES_DISABLED", "escritas estão desabilitadas; habilite writePolicy localmente para usar esta ferramenta.")
      }

      let content: string
      let path: string
      let bytes: number
      try {
        if (!isRecord(rawInput)) throw new InvalidArguments("argumentos inválidos.")
        const requestedPath = requireString(rawInput, "path", 1024)
        content = requireMarkdownContent(rawInput, "content", configuredLimits.maxWriteBytes)
        bytes = Buffer.byteLength(content, "utf8")
        const vault = await getVault()
        path = await vault.resolveMarkdownPath(requestedPath)
        if (await vault.existsMarkdown(path)) {
          throwVault("ALREADY_EXISTS", "o arquivo já existe; nenhuma sobrescrita foi feita.")
        }
      } catch (error) {
        return errorResult(error)
      }

      const denied = await authorizeWrite("open_mind_create", path, context)
      if (denied) return denied

      try {
        const vault = await getVault()
        const result = await vault.createMarkdown(path, content)
        return ok({ path: result.path, sha256: result.sha256, bytes }, { path: result.path, bytes })
      } catch (error) {
        return errorResult(error)
      }
    },
  }

  const updateTool: OpenMindTool = {
    name: "open_mind_update",
    description:
      "Substitui integralmente uma nota Markdown existente, somente com writePolicy best-effort e autorização explícita. Exige expectedHash compatível com a versão lida; conflitos interrompem a operação, sem retry automático. Retorna caminho relativo, novo SHA-256 e bytes gravados.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1, description: "Caminho relativo ao Vault, terminando em .md." },
        content: { type: "string", description: "Novo conteúdo Markdown completo da nota." },
        expectedHash: {
          type: "string",
          minLength: 64,
          maxLength: 64,
          description: "SHA-256 da versão lida com open_mind_read.",
        },
      },
      required: ["path", "content", "expectedHash"],
    },
    async execute(rawInput, context) {
      if (writePolicy !== "best-effort") {
        return fail("WRITES_DISABLED", "escritas estão desabilitadas; habilite writePolicy localmente para usar esta ferramenta.")
      }

      let content: string
      let path: string
      let expectedHash: string
      try {
        if (!isRecord(rawInput)) throw new InvalidArguments("argumentos inválidos.")
        const requestedPath = requireString(rawInput, "path", 1024)
        content = requireMarkdownContent(rawInput, "content", configuredLimits.maxWriteBytes)
        const rawHash = requireString(rawInput, "expectedHash", 64)
        if (!/^[a-f0-9]{64}$/i.test(rawHash)) {
          throw new InvalidArguments("expectedHash precisa ser um SHA-256 válido.")
        }
        expectedHash = rawHash.toLowerCase()

        const vault = await getVault()
        path = await vault.resolveMarkdownPath(requestedPath)
        const document = await vault.readMarkdownDocument(path)
        if (document.sha256 !== expectedHash) {
          throwVault("HASH_MISMATCH", "o arquivo mudou desde a leitura; atualize o contexto antes de gravar.")
        }
      } catch (error) {
        return errorResult(error)
      }

      const denied = await authorizeWrite("open_mind_update", path, context)
      if (denied) return denied

      try {
        const vault = await getVault()
        const result = await vault.updateMarkdown(path, content, expectedHash)
        const bytes = Buffer.byteLength(content, "utf8")
        return ok({ path: result.path, sha256: result.sha256, bytes }, { path: result.path, bytes })
      } catch (error) {
        return errorResult(error)
      }
    },
  }

  const projectContextTool: OpenMindTool = {
    name: "open_mind_project_context",
    description:
      "Identifica a nota de projeto correspondente ao diretório da sessão atual. Não escolhe nota quando há ambiguidade e não modifica arquivos.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
    async execute(_input, context) {
      try {
        const vault = await getVault()
        const projectRoot = await sessionDirectory(context.sessionID)
        const resolution = await resolveProjectContext(vault, projectRoot)
        if (resolution.status !== "found") {
          return ok({ status: resolution.status }, { status: resolution.status })
        }
        return ok(
          {
            status: resolution.status,
            path: resolution.note.path,
            title: resolution.note.title,
          },
          { status: resolution.status, path: resolution.note.path },
        )
      } catch (error) {
        return errorResult(error)
      }
    },
  }

  return [statusTool, searchTool, readTool, createTool, updateTool, projectContextTool]
}
