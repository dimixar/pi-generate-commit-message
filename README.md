# pi-generate-commit-message

A pi extension that generates commit messages from staged `git diff --cached` changes, with an interactive TUI preview, optional clarification flow, clipboard copy, and configurable model/thinking settings.

## Commands

- `/commit-msg`
- `/commit-msg:settings`

## Features

- Generates commit messages from staged changes
- Supports repo or submodule selection
- Uses a configurable pi model
- Optional reasoning/thinking level
- Optional read-only repo inspection tools:
  - `find_files`
  - `grep_files`
  - `read_file`
- When repo tools are enabled, the model is instructed to read the changed source files before producing the first result
- Interactive preview with sections for:
  - context
  - tool activity
  - thinking / thinking summary
  - generated result
- Runtime controls before and during generation:
  - `Shift+Tab` cycles the thinking level and saves it
  - `Ctrl+Y` toggles repo tools and saves it
  - `Ctrl+R` retries generation in the preview and applies the latest saved run settings
  - These controls are available in repo selection (when applicable), optional context entry, and the preview itself
- Copies the final message to the clipboard

## Settings

Settings are stored in:

```text
~/.pi/agent/data/generate-commit-message/settings.json
```

Default settings:

```json
{
  "model": null,
  "thinkingLevel": "medium",
  "useRepoTools": true,
  "showThinking": true,
  "showToolActivity": true,
  "showThinkingSummary": true
}
```

If no model is configured, `/commit-msg` will ask you to configure one through `/commit-msg:settings`.

If `useRepoTools` is enabled, the model is instructed to inspect the changed readable files with `read_file` before giving its first answer. If it is disabled, the model is expected to rely only on the staged diff and user clarifications.

## Local development

Clone the repo and install it into pi from a local path:

```bash
pi install /absolute/path/to/pi-generate-commit-message
```

Or test it for one run only:

```bash
pi -e /absolute/path/to/pi-generate-commit-message
```

Then reload pi:

```text
/reload
```

## Repository

GitHub: https://github.com/dimixar/pi-generate-commit-message

## Git install

Install directly from GitHub with:

```bash
pi install git:github.com/dimixar/pi-generate-commit-message
```

## npm install

After publishing to npm, install it with:

```bash
pi install npm:pi-generate-commit-message
```

## Package structure

```text
extensions/
  generate-commit-message/
    index.ts
    commit-message-generator.prompt.md
```

## Notes

- This package uses pi's bundled runtime packages via `peerDependencies`.
- The bundled prompt is shipped with the extension.
- Persistent user settings are stored outside the package directory so updates do not overwrite them.

## License

Choose a license before publishing publicly.
