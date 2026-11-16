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
- `main` é a branch principal e estável; o trabalho acontece em branch própria.
- Nova funcionalidade usa `feature/<descricao-curta>`; correção usa `fix/<descricao-curta>`.
- A branch reflete o trabalho atual; não usar nomes fixos de funcionalidades antigas.
- Preservar mudanças locais existentes ao trocar de branch ou iniciar o trabalho.
- Não fazer push, merge, rebase ou commit sem pedido explícito.
