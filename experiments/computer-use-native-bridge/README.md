# Native stdio MCP experiment

Standalone Node bridge for the parent-owned Swift helper. No production integration,
network listener, model calls, arbitrary-command tool, credential loading, or GUI
automation in this directory. Tests use a fake executable and never operate the GUI.
Uses the repo's existing `@modelcontextprotocol/sdk` and `zod`; no install needed.

## Run

Node >=22.13 is required. Build the parent-owned helper from the main checkout:

```sh
cd /Users/andrewbaker/workspace/BunjiBox
zsh experiments/computer-use-native/build-lab.sh
```

Then launch the bridge:

```sh
cd /Users/andrewbaker/workspace/BunjiBox
BUNJI_NATIVE_EXPERIMENT=1 \
BUNJI_NATIVE_DEPENDENCY_ROOT=/Users/andrewbaker/workspace/BunjiBox \
node experiments/computer-use-native-bridge/server.mjs \
  --helper '/Users/andrewbaker/workspace/BunjiBox/experiments/computer-use-native/.build/lab/Bunji Native Lab.app/Contents/MacOS/BunjiNativeLab' \
  --target fixture
```

The `.app` executable above is the native helper's actual main-checkout build path.
Its source and build script belong to the parent; this bridge does not supply them.
The command serves MCP on stdin/stdout and waits for an MCP client, not typed chat.
Only startup errors go to stderr. Native stderr is drained and discarded.

Generic MCP host configuration (use an absolute Node executable if the host PATH
does not contain Node):

```json
{
  "mcpServers": {
    "bunji-native-experiment": {
      "command": "node",
      "args": [
        "/Users/andrewbaker/workspace/BunjiBox/experiments/computer-use-native-bridge/server.mjs",
        "--helper",
        "/Users/andrewbaker/workspace/BunjiBox/experiments/computer-use-native/.build/lab/Bunji Native Lab.app/Contents/MacOS/BunjiNativeLab",
        "--target",
        "fixture"
      ],
      "env": {
        "BUNJI_NATIVE_EXPERIMENT": "1",
        "BUNJI_NATIVE_DEPENDENCY_ROOT": "/Users/andrewbaker/workspace/BunjiBox"
      }
    }
  }
}
```

`BUNJI_NATIVE_DEPENDENCY_ROOT` is optional when the worktree already resolves the
repo dependencies. It must point at a trusted existing checkout, not at node_modules.
The bridge refuses to spawn unless its own parent environment has exactly
`BUNJI_NATIVE_EXPERIMENT=1`. It then passes that value to the child. The helper path
must be absolute. The launcher accepts only `--target fixture` (the default) or
`--target com.apple.Notes`; all other targets are rejected before spawn. No tool accepts
target, executable, environment, start, or resume arguments. Child execution uses
`spawn(helper, ['--stdio', '--target', target])` with no shell. The child receives only
`PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `LC_*`,
`__CF_USER_TEXT_ENCODING`, and the experiment flag. API keys, `CODEX_HOME`,
`BUNJI_NATIVE_DEPENDENCY_ROOT`, test fixture settings, and all other environment
variables are excluded. The bridge does not read or emit credential stores.

## Native contract and tool behavior

Requests are UTF-8 JSON lines: `{ "id": "1", "method": "status", "params": {} }`.
Methods are `status`, `focus`, `observe`, `act`, `stop`. Replies must be exactly one
object per line with a matching string `id` and either an object `result` or string
`error`. Native stdout must contain protocol output only. Error replies reject that
request but leave the transport usable; malformed transport data terminates it.

| MCP tool | Native method | Read only | Behavior |
| --- | --- | --- | --- |
| `native_status` | `status` | Yes | Bounded, untrusted status text |
| `native_focus` | `focus` | No | Focus only; native must enforce takeover state |
| `native_observe` | `observe` | Yes | MCP PNG image plus bounded, untrusted metadata |
| `native_act` | `act` | No | Forward validated action shape and frame ID |
| `native_stop` | `stop` | No | Terminal stop; interrupt queue; restart lab to use again |

`native_act` accepts `{frameId, action}`. Actions:

```json
{"type":"click","x":10,"y":20}
{"type":"press","elementId":"native-element-id"}
{"type":"type","text":"hello"}
{"type":"key","key":"return"}
{"type":"scroll","direction":"down","amount":2}
```

Keys are restricted to `return`, `tab`, `escape`, `command+n`, `command+a`. Click
coordinates are nonnegative integer **screenshot pixels**, not desktop coordinates.
Scroll amount is an integer from 1 to 600. Typed text requires 1–1000 UTF-16 code
units and no Unicode control or format characters (categories Cc/Cf, matching
Foundation's control-character set). Use key actions for Return, Tab, etc.
Frame IDs and element IDs require 1–128 UTF-16 code units. All tool and action objects reject extra
fields. Native remains authoritative for pixel bounds, freshness, element validity,
foreground window, target ownership, permissions, user takeover, and final races.

Observe requires `frameId`, positive integer `width`/`height`, matching `target`,
integer `windowId`, `elements` with `id`, `role`, `label`, optional `value`, and
`image: {mimeType: 'image/png', data: base64}`. The bridge checks canonical base64
and the PNG signature; it does not decode or resize PNGs. Metadata includes at most
50 elements, retains complete element IDs, clips labels/roles/values to 128 code
units, and drops trailing elements to fit 24,000 code units of JSON. Unknown
observation fields are omitted. Other native objects/errors become bounded text,
which can be truncated. All native text is labeled untrusted data, not instructions.

## Safety and lifecycle limits

Normal requests serialize. Up to 16 total normal requests may be queued/inflight;
stop has one reserved slot and is written immediately, even with an action awaiting
a response. The native helper **must process stop immediately**, and must recheck
authorization at the final action boundary. A bridge cannot undo an action already
applied. **Stop is terminal: restart the lab to begin again.** Host UI Resume cannot
undo Stop. Only the **Take over** pause can resume through the host UI; focus must
never grant control. There is no model start/resume tool or automatic restart/retry.
Native safety and actual Swift/GUI/model validation belong to the parent; the bridge
tests do not duplicate those checks.

Each sent request has a 15-second **transport response deadline**, not a timeout for
the user's whole task. Queued time does not consume it. An unresponsive transport,
oversize line, too many pending requests, malformed JSON/UTF-8/envelope, unknown or
duplicate ID, stream error/EOF, or process exit fails all pending work. No retries.
The bridge sends SIGTERM, then SIGKILL after 250ms if needed, and closes child stdin
to stop control. MCP cancellation, MCP disconnect, stdin EOF, SIGINT, and SIGTERM
also close the helper. A forcibly killed bridge cannot run its cleanup, so native
must itself relinquish control on parent pipe EOF. The helper is assumed to be one
process; the bridge does not manage independently spawned descendants.

NDJSON request/response lines are limited to 16 MiB excluding the newline. PNG
base64 is additionally limited to 15 MiB. These caps can reject large screenshots;
the parent should bound native capture output. The exported transport constructor
accepts smaller limits and deadlines for tests. Constructors are library seams for
trusted host code, not tools exposed to models.

## Test

```sh
cd /Users/andrewbaker/workspace/BunjiBox
BUNJI_NATIVE_EXPERIMENT=1 \
BUNJI_NATIVE_DEPENDENCY_ROOT=/Users/andrewbaker/workspace/BunjiBox \
node --test experiments/computer-use-native-bridge/test/bridge.test.mjs
```

The executable fake helper implements only an in-memory fixture. Tests exercise
both the actual SDK in-memory transport and a real stdio MCP subprocess, plus
fragmented NDJSON, protocol failures, stop priority, strict schemas, images, locked
targets, opt-in gating, environment filtering, schema boundaries, terminal-stop
error forwarding, stale-frame/native action errors, EOF/exit, timeout, kill
escalation, and helper cleanup. This proves bridge behavior, not real macOS
permissions, accessibility, screenshot accuracy, or takeover detection.
Fault modes are injected through the test's `spawnImpl` hook after environment
filtering; production spawning never passes fixture settings through.
