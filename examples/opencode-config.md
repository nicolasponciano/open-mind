# Exemplo de configuração do plugin

Os trechos abaixo usam a sintaxe JSONC do OpenCode `v2.2.5`, a única versão em que o carregamento foi testado. O código-fonte está publicado em [github.com/nicolasponciano/open-mind](https://github.com/nicolasponciano/open-mind). Clone o repositório com `git clone https://github.com/nicolasponciano/open-mind.git` e substitua o caminho ilustrativo de `package` pelo caminho absoluto do clone. Não há pacote publicado no npm.

Mescle o objeto do plugin na propriedade `plugins` da sua configuração atual. Preserve as demais propriedades e entradas existentes; não substitua o arquivo inteiro. O caminho em `vaultPath` deve ser absoluto e apontar para um diretório já existente.

## Windows

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    // Preserve aqui as entradas de plugins já existentes.
    {
      "package": "C:/caminho/para/o/clone/open-mind",
      "options": {
        "vaultPath": "D:\\Vaults\\MeuVault",
        "writePolicy": "disabled"
      }
    }
  ]
}
```

## Linux

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    // Preserve aqui as entradas de plugins já existentes.
    {
      "package": "/caminho/para/o/clone/open-mind",
      "options": {
        "vaultPath": "/srv/obsidian/VaultExemplo",
        "writePolicy": "disabled"
      }
    }
  ]
}
```

## macOS

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    // Preserve aqui as entradas de plugins já existentes.
    {
      "package": "/caminho/para/o/clone/open-mind",
      "options": {
        "vaultPath": "/Volumes/DiscoDeExemplo/VaultExemplo",
        "writePolicy": "disabled"
      }
    }
  ]
}
```

`writePolicy` aceita `disabled` ou `best-effort`. Se omitido, vale `disabled`; `best-effort` é um opt-in explícito e não oferece CAS entre processos. A configuração é lida de `ctx.options` durante o setup do plugin.

## Compatibilidade observada

O carregamento real do pacote TypeScript foi validado em OpenCode `v2.2.5` no Windows. `@opencode/plugin@2.2.7` é usado somente como dependência de desenvolvimento para checagem de tipos; não é instalado como dependência de runtime pelo pacote distribuído. Outras versões e sistemas operacionais não foram testados.
