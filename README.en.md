[Português](README.md) · **English**

# Open Mind

Open Mind (`open-mind`) is an OpenCode V2 plugin that provides context from an Obsidian Markdown vault and tools to query its contents. The source code is published at [github.com/nicolasponciano/open-mind](https://github.com/nicolasponciano/open-mind). The project is not distributed through npm.

## Contents

- [Architecture](#architecture)
- [Requirements and tested compatibility](#requirements-and-tested-compatibility)
- [Distribution format](#distribution-format)
- [Setup from a local clone](#setup-from-a-local-clone)
- [Vault and template](#vault-and-template)
- [Plugin configuration](#plugin-configuration)
- [Tools](#tools)
- [Session-based project matching](#session-based-project-matching)
- [Default limits](#default-limits)
- [Write security](#write-security)
- [Development and tests](#development-and-tests)
- [Release notes](#release-notes)
- [Known limitations](#known-limitations)

## Architecture

`OpenCode V2 → Open Mind plugin → Core/tools → Markdown vault`

The plugin reads the configured vault. The Core assembles context and matches project notes. The tools provide status, search, read, and, when enabled, write operations. Filesystem access is confined to the vault root, and tool operations use relative paths.

## Requirements and tested compatibility

- Node.js `v24.20.0` to run the tests (`--experimental-strip-types`).
- OpenCode `v2.2.5` for actual loading of the TypeScript package.
- `@opencode/plugin` (`2.2.7`) is a development dependency used only for type checking. The distributed package neither installs nor imports it at runtime. Loading was verified with OpenCode `v2.2.5` without this dependency.

The loading test used a local tarball installed in isolation through OpenCode `v2.2.5`. Compatibility with other OpenCode versions and operating systems has not been verified.

## Distribution format

The distribution keeps the TypeScript files as-is: the OpenCode `v2.2.5` loader accepted `open-mind.ts` as the plugin entry point. This avoids a build step, copying generated files, and source map configuration. Internal imports use `.ts` extensions, as required by the tested loader.

Generating JavaScript with the current `tsc` setup is not a direct replacement: `tsconfig.json` uses `noEmit` and allows `.ts` imports. Emitting JavaScript would require a separate configuration and a step to adjust import extensions. A bundler would add another tool and maintenance surface. Direct TypeScript is the smallest option. The source code is on GitHub; the package is not published on npm.

`@opencode/plugin` is a development dependency (`devDependencies`). The `open-mind.ts` entry point uses `import type` and `satisfies Plugin.Plugin` only for static validation. These imports are erased at runtime, and the exported object follows the format accepted by the V2 loader. That is why `dependencies` is empty. `typescript` and `@types/node` also remain in `devDependencies`.

In a 2026-11-12 audit of an isolated tarball installation, `npm audit --omit=dev` reported 0 vulnerabilities. Neither `glob` nor `minimatch` is installed. By comparison, the earlier distribution, with `@opencode/plugin` in `dependencies`, reported 24 moderate transitive vulnerabilities, including `glob` and `minimatch`. This result covers only the distributed package; it does not mean the entire OpenCode installation is free of vulnerabilities.

## Setup from a local clone

To rebuild and validate the environment after reformatting a computer, see [`docs/bootstrap.md`](docs/bootstrap.md). The bootstrap does not recover vault data or change the global OpenCode configuration.

The manifest uses the local name `open-mind`, keeps the development identifier `0.0.0-local`, and sets `private: true` to prevent accidental npm publishing. There is no package published on npm. Clone the public repository and configure the local clone path in OpenCode. Loading the TypeScript package was verified using a local tarball, installed in isolation on Windows with OpenCode `v2.2.5`.

1. Clone the public repository. Do not install an npm package: none is published, and there are no external runtime dependencies.

   ```sh
   git clone https://github.com/nicolasponciano/open-mind.git
   ```

2. In the `opencode.jsonc` file for the project where you want to use the plugin, merge an entry into `plugins`. Preserve all existing properties and entries. Set `package` to the clone directory and provide the absolute path to your own vault:

   ```jsonc
   {
     "plugins": [
       // Keep your existing entries here.
       {
          "package": "<absolute-path-to-clone>/open-mind",
         "options": {
           "vaultPath": "<absolute-path-to-your-vault>",
           "writePolicy": "disabled"
         }
       }
     ]
   }
   ```

   In JSON, escape backslashes in Windows paths (`\\`) or use `/` if accepted by Windows. On Linux and macOS, use an absolute path that exists on the system. The configuration must be valid JSONC. Adapt the example to your existing file; do not overwrite it.

3. Restart OpenCode and check `open_mind_status` before using other tools. Do not enable writing as part of installation.

To disable the plugin, remove only the Open Mind entry from the `plugins` list and keep the other plugins. You can remove the clone separately when it is no longer needed. Do not delete the entire configuration or shared directories.

The loading flow has only been verified on Windows with OpenCode `v2.2.5`. Installation and loading on Linux/macOS have not been tested.

## Vault and template

The vault is an existing directory containing Markdown notes. Base files and folders are not required for searching or reading notes: those operations use paths relative to the vault. If they exist, `00 - Open Mind.md` and `AGENTS.md` are read as initial context; if absent, the plugin reports that they were not found. Project matching looks for notes inside `projetos/`.

Use [`examples/vault-template/`](examples/vault-template/) as a fictional example: copy it to a test directory or adapt its structure to your vault. The wikilinks illustrate Obsidian navigation. The project note uses `Caminho:` to match the project path on disk with the OpenCode session directory. Replace the example path with the absolute path that matches your local session. You do not need to use the `notas/` or `projetos/` folders for ordinary read and search operations.

## Plugin configuration

The plugin receives options through `ctx.options` during setup:

- `vaultPath`: required; a non-empty string with an absolute path to an existing directory.
- `writePolicy`: optional; `disabled` or `best-effort`. If omitted, the effective value is `disabled`.

The plugin does not automatically discover a vault or fall back to other directories on the computer. Invalid configuration stops initialization. Errors do not select another vault and do not include the absolute path.

See [`examples/opencode-config.md`](examples/opencode-config.md) for JSONC examples. They use a fictional local clone path, not a published package. When editing an existing configuration, merge the entry into `plugins` and keep the other properties and plugins; do not replace the whole file.

### Distribution status

The source code is published on GitHub; there is no release version or npm package yet. Do not copy private configuration or use local files from `.integration-test/`: they are development fixtures, excluded from the repository, and are not installation instructions for users.

## Tools

The plugin registers six tools:

- `open_mind_status`: reports vault accessibility, base-file status, project matching, write policy, and limits without returning note contents or absolute paths.
- `open_mind_search`: searches Markdown files for literal text and returns short excerpts and relative paths.
- `open_mind_read`: reads a Markdown note at a relative path and returns its contents, byte size, and SHA-256.
- `open_mind_project_context`: resolves the note associated with the current session without making changes.
- `open_mind_create`: creates a new Markdown note and never overwrites an existing file.
- `open_mind_update`: replaces the contents of an existing note only if its SHA-256 still matches the expected value.

Both write tools remain registered when writing is disabled. In that state, they return `WRITES_DISABLED` and do not change files.

## Session-based project matching

For each session, the plugin checks that session's directory in OpenCode, not the application's global directory. It searches Markdown notes under `projetos/` and compares the full session directory path with the `Caminho:` field. The comparison normalizes separators and accounts for filesystem identity where relevant; it is not a substring search. A matching note is loaded as context.

If there is no session directory, no match, multiple matches, or a limit is reached, the Core reports the state and does not choose a note arbitrarily. The template uses a fictional path; replace it with an existing path that matches the project open in OpenCode.

## Default limits

- Reading one note: up to 1 MiB.
- Search: up to 128 files, depth 3, a 64 KiB prefix per file, a query up to 200 characters, up to 10 results, and excerpts up to 240 characters.
- Project metadata: up to 128 notes, depth 4, and 16 KiB per note.

Search limits can be adjusted internally up to the Core's ceilings. The public plugin configuration in this version does not expose overrides for them. Search may report incomplete results when a limit is reached.

## Write security

Writing is **disabled by default**. `best-effort` is an explicit local opt-in and does not replace the `ctx.permission.assert` authorization required for every action, with its session, action, and relative path. Without an authorizer, the operation fails closed.

`best-effort` does not provide compare-and-swap across processes or protection against an adversarial change to the parent directory. Updates require the hash of the version read and fail on conflicts, but another process can still write concurrently. Keep `disabled` when another process or sync tool may change the vault unless you consciously accept these risks. A write replaces the entire note; review and authorize every write.

## Development and tests

With development dependencies already installed:

```sh
npm test
npm run typecheck
npm run check
```

The tests create fictional vaults in temporary directories and clean up the fixtures when done. They do not need your personal vault or global OpenCode configuration. `npm run check` runs tests and type checking.

## Release notes

The project does not have versioned releases yet. The [changelog](CHANGELOG.md) lists changes by date in Portuguese and English.

- **2026-11-14:** Added scripts to validate and prepare the environment and vault. If you only use the plugin, no changes are needed. To rebuild the environment, follow [`docs/bootstrap.md`](docs/bootstrap.md).
- **2026-11-13:** Write tools now send more context with each authorization request. No configuration changes are needed.
- **2026-11-12:** The source code was first published on GitHub. Installation uses a local clone, as described above.

## Known limitations

- The local tarball was installed and loaded only in an isolated Windows environment. Installation from a registry/npm and validation on Linux/macOS are still pending.
- The tested OpenCode runtime version (`2.2.5`) differs from the development dependency `@opencode/plugin` (`2.2.7`). This affects type checking only, not the distributed package.
- Node.js `v24.20.0` does not support stripping TypeScript directly inside `node_modules`; loading is validated by OpenCode V2, not by importing the package directly through Node.
- Three tests are skipped on Windows when the scenario requires unavailable symlink/junction or rename features. The test runner reports the reason. They are not counted as passing.
- `best-effort` is not a distributed transaction and does not eliminate races with external processes.
