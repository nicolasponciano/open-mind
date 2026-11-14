# Constitution do Open Mind

Regras para evolução do Open-mind-system. Revisáveis quando a arquitetura mudar.

## Stack e convenções
- Manter TypeScript direto para o plugin OpenCode e PowerShell para automação Windows.
- Documentação e mensagens operacionais em português do Brasil; nomes de código seguem convenções existentes.
- Evoluir Core, Adapter e Tools sem substituir funcionalidades já existentes.

## Proibições
- Não versionar credenciais, arquivos `.env`, nem conteúdo privado do vault.
- Não escrever fora do vault nem contornar a autorização do OpenCode e as verificações de hash do Core.
- Não apagar, sobrescrever ou sincronizar notas automaticamente; não assumir que exista backup acessível.
- Não alterar vault ou configuração global sem aprovação explícita.

## Qualidade
- Automatizações de filesystem devem oferecer `-WhatIf`, validar destinos e ser idempotentes.
- Toda nova ação persistente ou de bootstrap deve ter testes em diretórios temporários.
- Mudança de escopo atualiza esta spec antes do código; cada tarefa só é concluída após verificação aplicável.

## Fluxo
- Preservar mudanças existentes e trabalhar apenas na branch `feature/second-brain-integration`.
- Não fazer push, merge, rebase ou commit sem pedido explícito.
