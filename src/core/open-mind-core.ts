import { stat } from "node:fs/promises"
import {
  DEFAULT_VAULT_LIMITS,
  VaultFileError,
  createVaultFileSystem,
  type VaultFileSystem,
} from "../filesystem/vault-files.ts"

export type ProjectContextStatus = "found" | "not_found" | "ambiguous" | "limit_reached" | "session_unavailable"

export type OpenMindContext = {
  text: string
  projectStatus: ProjectContextStatus
}

type ContextOptions = {
  vaultRoot: string
  projectRoot?: string
}

type ProjectNote = { path: string; title: string }
const MAX_PROJECT_FILES = DEFAULT_VAULT_LIMITS.maxProjectFiles
const MAX_PROJECT_METADATA_BYTES = DEFAULT_VAULT_LIMITS.maxProjectMetadataBytes

function normalizeProjectPath(value: string) {
  return value
    .trim()
    .replace(/^([`"'])(.*)\1$/, "$2")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
}

function pathMetadata(content: string) {
  return [...content.matchAll(/^\s*caminho\s*:\s*(.*?)\s*$/gim)]
    .map((match) => normalizeProjectPath(match[1]))
    .filter(Boolean)
}

async function sameFilesystemPath(left: string, right: string) {
  const normalizedLeft = normalizeProjectPath(left)
  const normalizedRight = normalizeProjectPath(right)
  if (normalizedLeft === normalizedRight) return true
  if (normalizedLeft.toLowerCase() !== normalizedRight.toLowerCase()) return false

  try {
    const [leftInfo, rightInfo] = await Promise.all([stat(left), stat(right)])
    return leftInfo.dev === rightInfo.dev && leftInfo.ino !== 0 && leftInfo.ino === rightInfo.ino
  } catch {
    return false
  }
}

async function pathMetadataMatches(content: string, target: string) {
  for (const candidate of pathMetadata(content)) {
    if (await sameFilesystemPath(candidate, target)) return true
  }
  return false
}

async function linkedPathReferences(content: string, target: string) {
  const references: string[] = []
  let ambiguous = false
  for (const line of content.split(/\r?\n/)) {
    const links = [...line.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)]
    if (!links.length) continue
    const codePaths = [...line.matchAll(/`([^`]+)`/g)].map((match) => normalizeProjectPath(match[1]))
    const matchingPaths: string[] = []
    for (const codePath of codePaths) {
      if (await sameFilesystemPath(codePath, target)) matchingPaths.push(codePath)
    }
    if (matchingPaths.length) {
      if (links.length !== 1 || codePaths.length !== 1) {
        ambiguous = true
        continue
      }
      references.push(links[0][1].trim().split("/").at(-1) ?? links[0][1].trim())
    }
  }
  return { references, ambiguous }
}

async function hasExactLegacyPath(content: string, target: string) {
  for (const line of content.split(/\r?\n/)) {
    if (line.includes("[[")) continue
    const exactLine = line.trim().replace(/^[-*]\s+/, "")
    if (await sameFilesystemPath(exactLine, target)) return true
    for (const match of line.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'/g)) {
      if (await sameFilesystemPath(match[1] ?? match[2] ?? match[3], target)) return true
    }
  }
  return false
}

function projectTitle(metadata: string, path: string) {
  const heading = metadata.match(/^\s*#\s+(.+?)\s*#*\s*$/m)?.[1]
  return heading?.trim() || path.split("/").at(-1)?.replace(/\.md$/i, "") || ""
}

export type ProjectResolution =
  | { status: "found"; note: ProjectNote }
  | { status: "not_found" | "ambiguous" | "limit_reached" | "session_unavailable" }

/**
 * Resolves the project note for a session directory without loading its content.
 * Shared by context injection, the status tool and the project-context tool.
 */
export async function resolveProjectContext(
  vault: VaultFileSystem,
  projectRoot: string | undefined,
): Promise<ProjectResolution> {
  if (!projectRoot) return { status: "session_unavailable" }
  return findProjectNote(vault, projectRoot)
}

async function findProjectNote(vault: VaultFileSystem, projectRoot: string): Promise<
  | { status: "found"; note: ProjectNote }
  | { status: "not_found" | "ambiguous" | "limit_reached" }
> {
  const target = normalizeProjectPath(projectRoot)
  let paths: string[]

  try {
    paths = await vault.listMarkdown("projetos", {
      recursive: true,
      maxDepth: 4,
      maxEntries: MAX_PROJECT_FILES,
    })
  } catch (error) {
    if (error instanceof VaultFileError && error.code === "NOT_FOUND") return { status: "not_found" }
    if (error instanceof VaultFileError && error.code === "LIMIT_EXCEEDED") return { status: "limit_reached" }
    throw error
  }

  const notes: ProjectNote[] = []
  const explicit: ProjectNote[] = []
  const exactLegacy: ProjectNote[] = []
  const pathLinks: string[] = []
  let ambiguousIndexReference = false
  let truncatedMetadata = false
  for (const path of paths) {
    const { content, truncated } = await vault.readMarkdownPrefix(path, MAX_PROJECT_METADATA_BYTES)
    truncatedMetadata ||= truncated
    const note = { path, title: projectTitle(content, path) }
    notes.push(note)
    if (await pathMetadataMatches(content, target)) explicit.push(note)
    else if (await hasExactLegacyPath(content, target)) exactLegacy.push(note)
    const links = await linkedPathReferences(content, target)
    pathLinks.push(...links.references)
    ambiguousIndexReference ||= links.ambiguous
  }

  // Uma nota truncada pode conter outro Caminho:/índice correspondente; não afirmar unicidade.
  if (truncatedMetadata) return { status: "limit_reached" }
  if (explicit.length > 1) return { status: "ambiguous" }
  if (explicit.length === 1) return { status: "found", note: explicit[0] }
  if (ambiguousIndexReference) return { status: "ambiguous" }

  const linkedNotes = notes.filter((note) =>
    pathLinks.some((slug) => {
      const normalizedSlug = slug.trim().toLowerCase()
      const filename = note.path.split("/").at(-1)?.replace(/\.md$/i, "").toLowerCase()
      return normalizedSlug === filename || normalizedSlug === note.title.toLowerCase()
    }),
  )
  const legacy = [...new Map([...exactLegacy, ...linkedNotes].map((note) => [note.path, note])).values()]
  if (legacy.length > 1) return { status: "ambiguous" }
  if (legacy.length === 1) return { status: "found", note: legacy[0] }
  return { status: "not_found" }
}

export async function loadOpenMindContext({ vaultRoot, projectRoot }: ContextOptions): Promise<OpenMindContext> {
  const vault = await createVaultFileSystem(vaultRoot)
  const baseFiles = [
    ["Mapa do Open Mind", "00 - Open Mind.md"],
    ["Constituição do Segundo Cérebro", "AGENTS.md"],
  ] as const
  const sections: string[] = []

  for (const [label, file] of baseFiles) {
    try {
      sections.push(`## ${label}\n\n${await vault.readMarkdown(file)}`)
    } catch (error) {
      if (!(error instanceof VaultFileError) || error.code !== "NOT_FOUND") throw error
      sections.push(`## ${label}\n\nArquivo não encontrado.`)
    }
  }

  let projectStatus: ProjectContextStatus
  if (!projectRoot) {
    projectStatus = "session_unavailable"
    sections.push("## Nota do projeto\n\nContexto da sessão indisponível; nenhuma nota de projeto foi selecionada.")
  } else {
    const result = await findProjectNote(vault, projectRoot)
    projectStatus = result.status

    if (result.status === "found") {
      sections.push(`## Nota do projeto (${result.note.path})\n\n${await vault.readMarkdown(result.note.path)}`)
    } else if (result.status === "ambiguous") {
      sections.push("## Nota do projeto\n\nCorrespondência ambígua; nenhuma nota de projeto foi carregada.")
    } else if (result.status === "limit_reached") {
      sections.push("## Nota do projeto\n\nBusca inconclusiva por limite de arquivos ou metadados truncados; nenhuma nota foi selecionada.")
    } else {
      sections.push("## Nota do projeto\n\nNenhuma nota de projeto correspondente foi encontrada.")
    }
  }

  return {
    projectStatus,
    text: [
      "[Open Mind carregado automaticamente. Use estas notas como contexto de referência.]",
      ...sections,
      "[Fim do contexto inicial do Open Mind.]",
    ].join("\n\n"),
  }
}

export function createSessionContextLoader<SessionID extends string>(
  getProjectRoot: (sessionID: SessionID) => Promise<string | undefined>,
  load: (projectRoot: string | undefined) => Promise<OpenMindContext>,
) {
  const loadedSessions = new Set<SessionID>()
  const loadingSessions = new Set<SessionID>()

  return async (sessionID: SessionID): Promise<OpenMindContext | undefined> => {
    if (loadedSessions.has(sessionID) || loadingSessions.has(sessionID)) return undefined
    loadingSessions.add(sessionID)

    try {
      let projectRoot: string | undefined
      try {
        projectRoot = await getProjectRoot(sessionID)
      } catch {
        projectRoot = undefined
      }

      const context = await load(projectRoot)
      if (context.projectStatus !== "session_unavailable") loadedSessions.add(sessionID)
      return context
    } finally {
      loadingSessions.delete(sessionID)
    }
  }
}
