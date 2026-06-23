# Changelog

## 0.2.2 - 2026-06-23

### Fixed
- Update extension imports for the latest `@earendil-works` pi packages
- Rename commands to `/commit_msg` and `/commit_msg:settings` for current pi command parsing
- Use current pi-ai auth and streaming options, including OAuth/env-backed auth
- Replace removed TUI helpers with local rendering helpers

## 0.2.1 - 2026-04-27

### Added
- Add an optional setting to auto-commit updated parent submodule pointers after submodule commits with a generated-message summary in the parent commit body
- Show a reminder after submodule commits when parent pointer auto-commit is disabled

## 0.2.0 - 2026-04-27

### Added
- Add manual `m` shortcut in the preview to commit staged changes with the generated message

## 0.1.3 - 2026-04-23

### Fixed
- Surface provider/model request failures instead of showing an empty commit message preview
- Send the bundled prompt as `systemPrompt` so OpenAI Codex receives required top-level instructions
- Use portable `reasoning` handling via pi-ai for better cross-provider compatibility

### Notes
- Verified intent of these fixes for both GitHub Copilot and OpenAI-based models
