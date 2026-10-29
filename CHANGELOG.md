# Change Log

All notable changes to the "vscode-cc-model-switch" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.3.0]

### Added
- **Copy Sessions From Another Profile**: copies sessions of the open workspace from another profile into the active one. Sessions are compared by content, never by modification time; a session the active profile has further along is never overwritten, a replaced file is kept as `<id>.jsonl.bak`.

### Changed
- The Open VSX publish workflow uses trusted publishing (`ovsx publish --trusted-publishing`) instead of the `OVSX_PAT` secret.

## [0.2.0]

### Changed
- Presets are written into the `claudeCode.environmentVariables` setting of the Claude Code extension instead of `~/.claude/settings.json`. Terminal sessions are no longer affected; `settings.json` is only read.

### Added
- Profiles: **Switch Claude Code Profile** sets `CLAUDE_CONFIG_DIR` to `~/.claude` or a `~/.claude-<name>` folder.
- OpenRouter presets (DeepSeek, Grok, GPT, GPT Luna, Qwen).
- `tokenId` preset option; presets with the same `tokenId` share one stored token.
- A credential variable set to `""` in a preset is written as empty.
- Warning when the `env` section of `settings.json` overrides a switched variable.

### Removed
- Zhipu GLM, Kimi and MiniMax presets.

## [0.1.0]

### Added
- API tokens are stored per preset in VS Code SecretStorage (`Set API Token` command).
- `requiresToken` preset option (the default Anthropic preset works with Claude login).
- The status bar and the panel refresh when `settings.json` or `envs.json` change.
- `tokenEnvKey` preset option; the Default preset stores its token as `ANTHROPIC_API_KEY`.
- Unit tests for the preset logic (moved to `src/presets.ts`).

### Fixed
- Switching a preset no longer wipes the API token or unrelated `env` variables in `settings.json`.
- An invalid `settings.json` is never overwritten; switching is refused with an error instead.
- `settings.json` is written atomically.
- Invalid `envs.json` is reported instead of silently falling back to the defaults.
- The current preset is detected from the last switch and all preset values, not only `ANTHROPIC_BASE_URL`.
- Presets are selected by id, not by label.
- Webview content is HTML-escaped and protected by a Content Security Policy.
- Opening `settings.json` / `envs.json` creates the file if it does not exist.
- `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` are always removed on a switch, so credentials never leak to another provider.
- Concurrent switches and token changes are serialized.
- A symlinked `settings.json` is kept as a symlink; a rename blocked by another process on Windows is retried.
- A UTF-8 byte order mark in `settings.json` / `envs.json` is accepted.
- File changes are debounced and the same `envs.json` problem is reported only once.

### Changed
- Removed the deprecated `ANTHROPIC_SMALL_FAST_MODEL` from the MiniMax preset.
- `@types/vscode` is pinned to the minimum supported VS Code version; lint checks floating promises.

### Removed
- Unrelated `home.html`, the prebuilt `.vsix`, outdated `SPEC.md` and the template `envs.json`.
- All Chinese texts were translated to English.
