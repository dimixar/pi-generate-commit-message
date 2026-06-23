# pi-generate-commit-message

A pi extension that generates commit messages from staged `git diff --cached` changes, with an interactive TUI preview, optional clarification flow, clipboard copy, optional manual `git commit`, and configurable model/thinking settings.

## Commands

- `/commit_msg`
- `/commit_msg:settings`

Note: current pi command parsing uses underscores for extension command names; older `/commit-msg` docs are superseded.

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
  - `c` copies the final message to the clipboard
  - `m` commits the currently staged changes with the generated message
  - These controls are available in repo selection (when applicable), optional context entry, and the preview itself
- Copies the final message to the clipboard
- Can manually run `git commit -F <generated-message-file>` for staged changes from the preview
- For submodule commits, can optionally auto-commit the updated submodule pointer in the parent repo with a fixed subject and a summary of the generated submodule commit message in the body

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
  "showThinkingSummary": true,
  "autoCommitSubmodulePointer": false
}
```

If no model is configured, `/commit_msg` will ask you to configure one through `/commit_msg:settings`.

If `useRepoTools` is enabled, the model is instructed to inspect the changed readable files with `read_file` before giving its first answer. If it is disabled, the model is expected to rely only on the staged diff and user clarifications.

If `autoCommitSubmodulePointer` is enabled, pressing `m` after generating a submodule commit message commits the submodule first, then stages and commits the updated submodule pointer in the parent repo. The parent commit uses `Update <submodule> submodule pointer` as the subject and includes a one-line summary of the generated submodule commit message in the body. If disabled, the preview reminds you to stage and commit the parent pointer separately.

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

MIT
