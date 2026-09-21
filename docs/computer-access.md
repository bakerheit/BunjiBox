# Computer access — alpha design

Each bot has one shared computer profile in the Bunji workspace. That means the
same bot seen in BunjiBox on a phone and in `bunji` uses the same saved profile.
The browser never gets to send a raw working directory or a sandbox setting with
a chat request.

## Profiles

| Scope | Level | Current behavior |
| --- | --- | --- |
| No computer | Read only | Normal chat and memory only. |
| One folder | Read only | Save from any device; Codex then starts in the saved folder with its read-only sandbox. |
| One folder | Allow changes | Save from any device; Codex then starts with `workspace-write`, never `danger-full-access`. |
| This Mac | Full access | Choosing it shows a confirmation modal. Codex and Claude then run unrestricted, without per-action prompts. |

The default is **No computer**. A blank folder is never interpreted as “this
Mac.” Full access can be enabled from the Mac or a phone. The UI asks for a
single confirmation when full access is selected, then saves it immediately.
There is no device pairing or per-action approval. The modal is a warning, not
an authentication boundary: anyone who can reach this unauthenticated HTTP
web app on the Wi-Fi network can enable full access or send full-access work.
Keep the app on a trusted network and never expose it to the public internet.

Folder paths are server-validated before storage and rechecked before a run.
The profile rejects broad roots such as `/`, the user home, and BunjiBox's own
workspace. This is about avoiding accidental broad access; it is not a
container-grade data isolation boundary.

## Provider mapping

For a selected folder, Bunji launches Codex with an explicit working directory
and the matching sandbox:

```text
read only      codex exec --sandbox read-only --cd <folder>
allow changes  codex exec --sandbox workspace-write --cd <folder>
```

This Mac deliberately selects `danger-full-access` for Codex and bypasses
Claude's permission prompts. It is an unattended full-Mac process, including
network access. The saved `network` field does not restrict this mode.

Claude's current CLI has permission modes and `--add-dir`, but not an equivalent
OS-enforced folder sandbox. Bunji therefore keeps Claude's folder-scoped
computer control off. Claude's This Mac mode can use
its full built-in tool set and Bunji's scoped memory tools.

## Network

The folder-scoped Codex sandbox blocks network access. Full-Mac mode is
unrestricted, including network access. The old Ask mode is no longer offered
because it could not run in Bunji's non-interactive provider process.
