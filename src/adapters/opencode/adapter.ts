import type { Plugin } from "@opencode/plugin"
import { isAbsolute } from "node:path"
import { VaultFileError, canonicalizeVaultRoot } from "../../filesystem/vault-files.ts"
import { createSessionContextLoader, loadOpenMindContext } from "../../core/open-mind-core.ts"
import { createOpenMindTools } from "../../tools/open-mind-tools.ts"

function configurationError(detail: string) {
  return new Error(`Open Mind: ${detail}`)
}

async function resolveVaultRoot(options: Plugin.Context["options"]) {
  const configuredPath = options.vaultPath
  if (typeof configuredPath !== "string" || !configuredPath.trim()) {
    throw configurationError(
      'vaultPath ausente nas opções do plugin (plugins[].options.vaultPath). Informe o caminho absoluto do Vault no opencode.jsonc.',
    )
  }

  if (!isAbsolute(configuredPath)) {
    throw configurationError('opção vaultPath inválida: informe um caminho absoluto do Vault.')
  }

  try {
    return await canonicalizeVaultRoot(configuredPath)
  } catch (error) {
    if (error instanceof VaultFileError) {
      throw configurationError('opção vaultPath inválida ou inacessível: informe um diretório existente.')
    }
    throw configurationError('opção vaultPath inválida ou inacessível: informe um diretório existente.')
  }
}

async function resolveWritePolicy(options: Plugin.Context["options"]) {
  const configured = options.writePolicy
  if (configured === undefined) return "disabled" as const
  if (configured === "disabled") return "disabled" as const
  if (configured === "best-effort") return "best-effort" as const
  throw configurationError(
    'opção writePolicy inválida: use ausência do campo (padrão "disabled") ou o opt-in explícito "best-effort".',
  )
}

export async function setupOpenMind(ctx: Plugin.Context) {
  const vaultRoot = await resolveVaultRoot(ctx.options)
  const writePolicy = await resolveWritePolicy(ctx.options)
  type SessionID = Parameters<typeof ctx.session.get>[0]["sessionID"]
  const loadForSession = createSessionContextLoader<SessionID>(
    async (sessionID) => (await ctx.session.get({ sessionID })).location.directory,
    (projectRoot) => loadOpenMindContext({ vaultRoot, projectRoot }),
  )

  await ctx.session.hook("context", async (event) => {
    const context = await loadForSession(event.sessionID)
    if (context) event.system.push({ type: "text", text: context.text })
  })

  const tools = createOpenMindTools({
    vaultRoot,
    writePolicy,
    getSessionDirectory: async (sessionID) => (await ctx.session.get({ sessionID })).location.directory,
    authorize: async ({ action, path, sessionID, agent, source }) => {
      type AssertRequest = Parameters<typeof ctx.permission.assert>[0]
      await ctx.permission.assert({
        // O host entrega o sessionID já tipado; a camada de tools o mantém como string.
        sessionID: sessionID as AssertRequest["sessionID"],
        action,
        resources: [path],
        ...(agent ? { agent: agent as NonNullable<AssertRequest["agent"]> } : {}),
        ...(source ? { source: { type: "tool" as const, messageID: source.messageID, id: source.callID } } : {}),
      })
    },
  })

  // Write tools stay registered even when disabled: they fail closed with WRITES_DISABLED.
  await ctx.tool.transform((editor) => {
    for (const tool of tools) {
      editor.add({
        name: tool.name,
        description: tool.description,
        input: tool.input,
        async execute(input, context) {
          const result = await tool.execute(input, {
            sessionID: context.sessionID,
            agent: context.agent,
            messageID: context.messageID,
            callID: context.id,
          })
          return { content: result.content, metadata: result.metadata }
        },
      })
    }
  })
}
