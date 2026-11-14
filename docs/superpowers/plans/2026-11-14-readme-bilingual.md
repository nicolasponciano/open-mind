# README Bilíngue e Notas de Atualização Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Facilitar a leitura do README em pt-BR e inglês e comunicar mudanças do projeto em linguagem voltada ao usuário.

**Architecture:** Manter `README.md` como versão principal em pt-BR e criar `README.en.md` com estrutura e conteúdo equivalentes. Manter `CHANGELOG.md` bilíngue, com entradas datadas e orientadas ao impacto para usuários; ambos os READMEs terão switcher de idioma, sumário e resumo das atualizações.

**Tech Stack:** Markdown; histórico existente do Git.

**Spec:** Decisões aprovadas na conversa: pt-BR padrão; sumário nos READMEs; changelog com versões pt-BR e inglês.

## Global Constraints

- Não declarar versão de release inexistente nem mudanças sem respaldo no histórico.
- Preservar os avisos técnicos e de segurança atuais, sem alterar seu significado.
- Manter os links relativos válidos a partir de cada arquivo.
- Ao atualizar um README, manter o outro alinhado.

## Review Focus

- Comandos, caminhos e limitações técnicas devem permanecer idênticos em significado nos dois idiomas.
- Links entre os READMEs e `CHANGELOG.md` devem funcionar.
- Entradas do changelog devem refletir apenas marcos verificáveis no histórico.
- Sumários devem apontar para cabeçalhos realmente existentes.
- O changelog inglês deve comunicar as mesmas mudanças e ações que a versão portuguesa.

---

### Task 1: Readmes bilíngues

**Files:**
- Modify: `README.md`
- Create: `README.en.md`

- [x] Adicionar no início de ambos os arquivos um switcher Português / English, mantendo `README.md` como padrão em pt-BR.
- [x] Incluir sumário de seções com links âncora válidos.
- [x] Acrescentar seção de notas de atualização com resumo breve e link para `CHANGELOG.md`.
- [x] Traduzir integralmente o conteúdo do README para inglês, preservando estrutura, código, nomes de ferramentas e referências relativas.
- [x] Conferir todas as âncoras e links relativos nos dois arquivos.

### Task 2: Changelog bilíngue

**Files:**
- Create: `CHANGELOG.md`

- [x] Registrar marcos datados verificados no Git: primeira publicação (12/11/2026), correção de autorização (13/11/2026) e scripts de bootstrap/setup e testes PowerShell (14/11/2026).
- [x] Para cada marco, separar as notas em português e inglês e explicar impacto para usuário, incluindo ação necessária ou “nenhuma”.
- [x] Não apresentar os marcos como releases versionados; sinalizar quando não há versão publicada.
- [x] Validar que links citados no changelog existem e que os dois READMEs apontam para ele.

### Task 3: Revisão final

**Files:**
- Verify: `README.md`, `README.en.md`, `CHANGELOG.md`

- [x] Comparar estrutura e informações técnicas dos dois READMEs, verificando que avisos de segurança e limitações não foram omitidos.
- [x] Verificar sumários, links de idioma e referências ao changelog.
- [x] Revisar o changelog contra `git log` para evitar afirmações sem suporte.
