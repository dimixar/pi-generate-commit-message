# Changelog

## Unreleased

### Added
- Add manual `m` shortcut in the preview to commit staged changes with the generated message

## 0.1.3 - 2026-04-23

### Fixed
- Surface provider/model request failures instead of showing an empty commit message preview
- Send the bundled prompt as `systemPrompt` so OpenAI Codex receives required top-level instructions
- Use portable `reasoning` handling via pi-ai for better cross-provider compatibility

### Notes
- Verified intent of these fixes for both GitHub Copilot and OpenAI-based models
