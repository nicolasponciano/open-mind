# Open Mind

Open Mind (`open-mind`) é um plugin para OpenCode V2 que fornece contexto de um Vault do Obsidian em Markdown e ferramentas para consultar esse conteúdo. O código-fonte está publicado em [github.com/nicolasponciano/open-mind](https://github.com/nicolasponciano/open-mind). Não há distribuição pelo npm.

## Arquitetura

`OpenCode V2 → plugin Open Mind → Core/ferramentas → Vault Markdown`

O plugin lê o Vault configurado; o Core monta contexto e associa notas de projeto; as ferramentas expõem status, busca, leitura e, quando habilitada, escrita. O acesso ao filesystem é confinado à raiz do Vault e usa caminhos relativos nas operações das ferramentas.

## Requisitos e compatibilidade testada

- Node.js `v24.20.0` para executar os testes (`--experimental-strip-types`).
- OpenCode `v2.2.5` para o carregamento real do pacote TypeScript.
- `@opencode/plugin` (`2.2.7`) é dependência de desenvolvimento, usada apenas para checagem de tipos. O pacote distribuído não o instala nem o importa em runtime; o carregamento foi verificado com OpenCode `v2.2.5` sem essa dependência.

O teste de carregamento foi feito com uma instalação local isolada do tarball pelo OpenCode `v2.2.5`. A compatibilidade com outras versões do OpenCode e outros sistemas operacionais não foi verificada.

## Formato de distribuição

A distribuição preserva os arquivos TypeScript diretamente: o carregador do OpenCode `v2.2.5` aceitou `open-mind.ts` como entrypoint do plugin. Isso evita build, cópia de arquivos gerados e configuração de source maps. As importações internas usam extensões `.ts`, coerentes com o carregador testado.

Gerar JavaScript com o `tsc` atual não é uma troca direta: o `tsconfig.json` é `noEmit` e permite importações `.ts`; a emissão exigiria uma configuração separada e uma etapa para ajustar as extensões dos imports. Um bundler seria mais uma ferramenta e uma superfície de manutenção. Portanto, TypeScript direto é a alternativa mínima. O código-fonte está no GitHub; não há publicação do pacote no npm.

`@opencode/plugin` é dependência de desenvolvimento (`devDependencies`). O entrypoint `open-mind.ts` usa `import type` e `satisfies Plugin.Plugin` apenas para validação estática; essas importações são apagadas na execução, e o objeto exportado segue o formato aceito pelo loader V2. Por isso `dependencies` está vazio. `typescript` e `@types/node` também permanecem em `devDependencies`.

Na auditoria de 12/11/2026, em instalação isolada do tarball, `npm audit --omit=dev` reportou 0 vulnerabilidades. Não há `glob` nem `minimatch` instalados. Para comparação, a distribuição anterior, com `@opencode/plugin` em `dependencies`, reportava 24 vulnerabilidades moderadas transitivas (incluindo `glob` e `minimatch`). Esse resultado cobre apenas o pacote distribuído: não significa que o OpenCode inteiro esteja livre de vulnerabilidades.

## Configuração a partir de um clone local

Para reconstruir e validar o ambiente após uma formatação, consulte [`docs/bootstrap.md`](docs/bootstrap.md). O bootstrap não recupera dados do vault nem altera a configuração global do OpenCode.

O manifesto usa o nome local `open-mind`, mantém a identificação de desenvolvimento `0.0.0-local` e `private: true` para impedir publicação acidental no npm. Não há pacote publicado no npm. Clone o repositório público e configure o caminho local do clone no OpenCode. O carregamento do pacote TypeScript foi validado por meio de um tarball local, em instalação isolada no Windows com OpenCode `v2.2.5`.

1. Clone o repositório público. Não instale um pacote do npm: não há publicação no npm nem dependências externas de runtime.

   ```sh
   git clone https://github.com/nicolasponciano/open-mind.git
   ```

2. No `opencode.jsonc` do projeto em que deseja usar o plugin, mescle uma entrada em `plugins`. Preserve todas as outras propriedades e entradas. Aponte `package` para o diretório do clone e informe o caminho absoluto do seu próprio Vault:

   ```jsonc
   {
     "plugins": [
       // Mantenha aqui as entradas que já existiam.
       {
          "package": "<caminho-absoluto-para-o-clone>/open-mind",
         "options": {
           "vaultPath": "<caminho-absoluto-para-seu-Vault>",
           "writePolicy": "disabled"
         }
       }
     ]
   }
   ```

   Em JSON, escape barras invertidas em caminhos Windows (`\\`) ou use `/` quando aceito pelo Windows. Em Linux e macOS, use o caminho absoluto existente no sistema. A configuração deve ser JSONC válida; adapte o exemplo ao arquivo existente, sem sobrescrevê-lo.

3. Reinicie o OpenCode e confira `open_mind_status` antes de usar outras ferramentas. Não habilite escrita como parte da instalação.

Para desativar o plugin, remova somente a entrada do Open Mind da lista `plugins`; mantenha os outros plugins. O clone pode ser removido separadamente quando não for mais necessário. Não apague a configuração inteira nem diretórios compartilhados.

O fluxo de carregamento foi validado apenas no Windows com OpenCode `v2.2.5`. Instalação e carregamento em Linux/macOS ainda não foram testados.

## Vault e template

O Vault é um diretório existente com notas Markdown. Arquivos e pastas-base não são pré-requisitos para busca e leitura de notas: essas operações trabalham com caminhos relativos ao Vault. O arquivo `00 - Open Mind.md` e `AGENTS.md` são lidos como contexto inicial quando existem; se ausentes, o plugin informa que não foram encontrados. A identificação de projetos procura notas dentro de `projetos/`.

Use [`examples/vault-template/`](examples/vault-template/) como exemplo fictício: copie-o para um diretório de teste ou adapte sua estrutura ao seu Vault. Os wikilinks ilustram navegação no Obsidian. A nota de projeto usa `Caminho:` para associar o caminho do projeto no computador ao diretório da sessão OpenCode. Substitua o caminho ilustrativo pelo caminho absoluto que corresponda à sessão local. Não é necessário adotar as pastas `notas/` ou `projetos/` para as operações comuns de leitura e busca.

## Configuração do plugin

O plugin recebe opções por `ctx.options` no setup:

- `vaultPath`: obrigatório; string não vazia, caminho absoluto para um diretório existente.
- `writePolicy`: opcional; `disabled` ou `best-effort`. Se omitido, o valor efetivo é `disabled`.

Não há descoberta automática de Vault nem fallback para diretórios do computador. Configuração inválida interrompe a inicialização; os erros não selecionam outro Vault e não incluem o caminho absoluto.

Consulte [`examples/opencode-config.md`](examples/opencode-config.md) para exemplos JSONC. Eles usam um caminho local ilustrativo para o clone, não um pacote publicado. Ao editar uma configuração existente, mescle a entrada em `plugins` e mantenha as demais propriedades e plugins; não substitua o arquivo inteiro.

### Estado da distribuição

O código-fonte está publicado no GitHub; ainda não há versão de release nem pacote publicado no npm. Não copie configurações privadas nem use os arquivos locais de `.integration-test/`: são fixtures de desenvolvimento, estão excluídos do repositório e não constituem instruções de instalação para usuários.

## Ferramentas

O plugin registra seis ferramentas:

- `open_mind_status`: informa acessibilidade do Vault, estado dos arquivos-base, associação de projeto, política de escrita e limites, sem retornar conteúdo de notas nem caminhos absolutos.
- `open_mind_search`: busca texto literal em arquivos Markdown e retorna trechos curtos e caminhos relativos.
- `open_mind_read`: lê uma nota Markdown indicada por caminho relativo e retorna conteúdo, bytes e SHA-256.
- `open_mind_project_context`: resolve a nota associada à sessão atual sem modificações.
- `open_mind_create`: cria uma nova nota Markdown; nunca sobrescreve um arquivo existente.
- `open_mind_update`: substitui o conteúdo de uma nota existente somente se o SHA-256 ainda corresponder ao esperado.

As duas ferramentas de escrita permanecem registradas mesmo com escrita desabilitada; nesse estado, respondem `WRITES_DISABLED` e não alteram arquivos.

## Associação de projetos por sessão

Para cada sessão, o plugin consulta o diretório daquela sessão no OpenCode, não o diretório global da aplicação. A busca de correspondência examina notas Markdown em `projetos/` e compara o caminho completo do diretório da sessão com o campo `Caminho:`. A comparação normaliza separadores e considera a identidade do filesystem quando relevante; não é uma busca por substring. Uma nota correspondente é carregada como contexto.

Sem diretório de sessão, sem correspondência, com mais de uma correspondência ou ao alcançar limites, o Core informa o estado e não escolhe arbitrariamente uma nota. O template usa um caminho fictício; troque-o por um caminho que exista e corresponda ao projeto aberto no OpenCode.

## Limites padrão

- Leitura de uma nota: até 1 MiB.
- Busca: até 128 arquivos, profundidade 3, prefixo de 64 KiB por arquivo, consulta de até 200 caracteres, até 10 resultados e trechos de até 240 caracteres.
- Metadados de projetos: até 128 notas, profundidade 4 e 16 KiB por nota.

Os limites de busca podem ser ajustados internamente até os tetos do Core; a configuração pública do plugin nesta versão não oferece overrides para eles. A busca pode sinalizar resultados incompletos quando um limite é atingido.

## Segurança da escrita

Escrita é **desabilitada por padrão**. `best-effort` é opt-in local explícito e, sozinho, não dispensa a autorização `ctx.permission.assert` exigida para cada ação, com sessão, ação e caminho relativo. Sem autorizador, a operação falha fechada.

`best-effort` não oferece compare-and-swap entre processos nem garantia contra troca adversarial do diretório pai. Atualizações exigem o hash da versão lida e falham em conflito, mas outro processo ainda pode escrever concorrentemente. Mantenha `disabled` quando outro processo ou sincronizador puder alterar o Vault, salvo se aceitar conscientemente esses riscos. O conteúdo escrito substitui a nota inteira; revise e autorize cada escrita.

## Desenvolvimento e testes

Com dependências já instaladas no ambiente de desenvolvimento:

```sh
npm test
npm run typecheck
npm run check
```

Os testes criam Vaults fictícios em diretórios temporários e limpam as fixtures ao final. Não precisam do Vault pessoal nem da configuração global do OpenCode. `npm run check` executa testes e typecheck.

## Limitações conhecidas

- O tarball local foi instalado e carregado somente em ambiente Windows isolado; instalação por registro/npm e validação em Linux/macOS permanecem pendentes.
- A versão do runtime OpenCode testada (`2.2.5`) difere da dependência de desenvolvimento `@opencode/plugin` (`2.2.7`). A diferença afeta apenas a checagem de tipos, não o pacote distribuído.
- O Node.js `v24.20.0` não permite strip de TypeScript diretamente dentro de `node_modules`; a validação de carregamento é feita pelo OpenCode V2, não por importação direta do pacote pelo Node.
- Três testes são ignorados no ambiente Windows quando recursos de symlink/junction ou renomeação exigidos pelo cenário não estão disponíveis; a saída do test runner informa o motivo. Eles não são contabilizados como aprovados.
- `best-effort` não é uma transação distribuída e não elimina corridas com processos externos.
