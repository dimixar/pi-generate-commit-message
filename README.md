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
- Read-only repo inspection tools before asking for clarification:
  - `find_files`
  - `grep_files`
  - `read_file`
- Interactive preview with sections for:
  - context
  - tool activity
  - thinking / thinking summary
  - generated result
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
  "thinkingLevel": "high",
  "showThinking": true,
  "showToolActivity": true,
  "showThinkingSummary": true
}
```

If no model is configured, `/commit-msg` will ask you to configure one through `/commit-msg:settings`.

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

## Git install

After pushing this repo to GitHub, install it with:

```bash
pi install git:github.com/<USER>/<REPO>
```

## npm install

After publishing to npm, install it with:

```bash
pi install npm:<PACKAGE_NAME>
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
