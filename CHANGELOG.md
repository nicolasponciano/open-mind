# Notas de atualização / Changelog

O projeto ainda não tem releases versionadas nem pacote publicado no npm. As datas abaixo correspondem ao histórico do repositório, não a versões de lançamento.

This project has no versioned releases or npm package yet. The dates below follow the repository history and do not represent release versions.

## 14/11/2026

### Português

- **Adicionado:** scripts de bootstrap e preparação do Vault, além de testes PowerShell. Eles validam o ambiente e ajudam a preparar a reconexão ao Vault já recuperado. Não recuperam notas nem configuram backup ou sincronização.
- **O que fazer:** nada se você usa apenas o plugin. Para validar ou reconstruir o ambiente, siga [`docs/bootstrap.md`](docs/bootstrap.md).

### English

- **Added:** bootstrap and vault setup scripts, plus PowerShell tests. They validate the environment and help prepare reconnection to an already restored vault. They do not recover notes or configure backup or synchronization.
- **What to do:** nothing if you only use the plugin. To validate or rebuild the environment, follow [`docs/bootstrap.md`](docs/bootstrap.md).

## 13/11/2026

### Português

- **Corrigido:** as ferramentas de escrita agora incluem o agente e os identificadores da chamada da ferramenta no pedido de autorização, quando o OpenCode os fornece.
- **O que fazer:** nenhuma mudança de configuração. A escrita continua desabilitada por padrão e exige autorização para cada operação.

### English

- **Fixed:** write tools now include the agent and tool-call identifiers in authorization requests when OpenCode provides them.
- **What to do:** no configuration changes. Writing remains disabled by default and requires authorization for each operation.

## 12/11/2026

### Português

- **Publicado:** o código-fonte do Open Mind foi disponibilizado no GitHub. A instalação é feita a partir de um clone local; não há pacote npm.
- **O que fazer:** para começar, siga [Configuração a partir de um clone local](README.md#configuracao-a-partir-de-um-clone-local).

### English

- **Published:** the Open Mind source code became available on GitHub. Installation uses a local clone; there is no npm package.
- **What to do:** to get started, follow [Setup from a local clone](README.en.md#setup-from-a-local-clone).
