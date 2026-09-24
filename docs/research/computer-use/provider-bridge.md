# Computer-use provider bridge

Research snapshot: September 22, 2026. This is an experiment, not an app integration.

## Recommendation

Start with one provider-neutral, local stdio MCP bridge for the existing Codex and Claude Code CLI harnesses. Keep the browser/session owner in BunjiBox; give the model only `computer_observe` and `computer_act` during an Agent run. Keep Chat mode tool-free. Use native provider computer APIs only as optional adapters when API billing and account setup are acceptable. Do not make Jev the visual driver yet.

Why this fits this repo:

- `packages/core/src/memory-mcp.ts` already starts a scoped stdio MCP server; its `scope()` callback binds writes to the active request. `packages/core/src/runtime.ts` starts that bridge only for Agent-mode Codex/Claude runs and explicitly strips Bunji tools in Chat mode.
- `docs/computer-access.md` and `packages/core/src/computer-policy.ts` already map saved computer policy to provider execution. Keep that trusted server-side profile as the authority; never let model tool arguments pick a path, app, site, or permission level.
- Codex CLI supports MCP servers, and Claude Code supports local stdio MCP servers. Their local authenticated harnesses are the plausible subscription path, not a Bunji-owned public subscription API. The exact account entitlement and whether each host passes image results through must be checked per installed client/account before shipping.

## Routes

| Route | What is verified | Trade-off | Call |
| --- | --- | --- | --- |
| Local MCP in Codex CLI / Claude Code | Both clients document local MCP; Claude Code documents stdio. Bunji already has a stdio MCP pattern. | One Bunji-owned tool contract; host support for image content and subscription use still needs a live check. MCP is a transport, not an automation sandbox. | Best first spike. Start with the app-owned browser, not the whole Mac. |
| OpenAI Responses computer tool | The API returns ordered UI actions; Bunji supplies the executor, keeps the environment between calls, then sends the matching call ID and screenshot back. The docs also allow using your own UI tools/MCP. | API integration and API account/billing path; it does not grant a third-party app access to a ChatGPT subscription session. | A clean optional OpenAI API adapter, not the subscription bridge. |
| Anthropic API computer toolset | `computer_toolset_20260801` is a client toolset: Bunji runs actions in its environment and returns screenshots. Anthropic recommends browser use for webpage-only tasks. | API/platform integration, not Claude Code's Pro/Max subscription harness. Current toolset definition adds about 4,500 input tokens before screenshot/tool results. | Optional API adapter; enable only for a computer task. |
| TypeSafe Jev | The official TypeSafe launch post uses the spelling **Jev**, describes an early-access System One model for typed probabilistic decisions, and says it gives up free-form string generation. | The official material reviewed does not establish image input, computer-use actions, or an MCP integration. Third-party demos are not enough to treat those as supported. | Not a visual driver. Revisit as a bounded selector over text/DOM state only after official modality/API docs and an eval. |

The provider labels in `experiments/computer-use-bridge/contract.mjs` reflect those boundaries: subscription CLI routes use MCP, API routes use their native tool protocol, and Jev is decision-only. There is no shared subscription API in this spike.

## Tool contract

The prototype is pure Node code. It does not capture screens, launch browsers, inject input, open a listener, or widen filesystem access. Its image bytes in tests are fake fixture data. `authorizeAction()` returns `execution: 'NOT_EXECUTED'`; a real executor is intentionally absent.

- `computer_observe {}` returns the latest frame as an MCP image block plus bounded text/ARIA evidence, tagged with `sessionId`, `frameId`, sequence, app, and origin. Page content is marked untrusted evidence, never policy or instructions.
- `computer_act { frameId, frameSequence, sequence, action }` authorizes one allowlisted click/type/scroll/navigation against that exact frame. It rejects stale frame IDs/sequences, duplicate/out-of-order actions, stale owners, and off-list apps/sites. It does not run the action.
- The trusted host binds `requestId`, provider source, owner actor, and ownership epoch outside model-supplied arguments. Each action consumes its frame; another action needs a fresh observation.
- Lifecycle is host-owned: pause clears the frame and lease; user takeover bumps the ownership epoch; handback requires a fresh frame; stop is terminal. An old agent call cannot regain ownership by replaying an earlier frame.
- The spike has exact-origin allowlists and a step cap. A real broker also needs user approval for consequential actions (submitting, sending, purchasing, deleting, consenting), cancellation/time limits, and a controlled browser profile. DOM, screenshots, and accessibility text remain untrusted.

## UI shape

Treat the session and the UI as separate layers. A single session event stream can feed a React sidebar, a native macOS floating window, and a text-only CLI; it should carry session/frame IDs, owner, action lifecycle, viewport, and an optional agent-pointer marker. The pointer is a visual overlay tied to a frame/action, not a second input writer. Clear or freeze it on stale frames and user takeover.

- Web: show the app-owned browser beside chat. Hide/collapse the sidebar without stopping the session. Document Picture-in-Picture can host arbitrary HTML in supporting browsers, but its window cannot outlive its opener; feature-detect it and keep a regular in-app fallback.
- macOS: use a native floating/panel surface for the same events. That surface and browser view are platform-specific adapters; do not make macOS APIs part of the provider tool contract.
- CLI: show action/status/frame IDs and takeover/pause/stop commands. There is no meaningful PiP surface in a terminal.

The event protocol can be shared; a single cross-platform PiP/cursor implementation cannot. This repo currently has a React web app and a SwiftUI macOS shell, so these should remain separate renderers.

## Context and evidence

Do not attach image tools to every ordinary turn. Register these tools only when the request is routed to Agent mode and the saved computer policy permits it. Return a screenshot when the model asks, after an action, or when visual uncertainty requires one. Pair it with a small, current accessibility snapshot or focused DOM subtree and element references; avoid full-page DOM dumps and replaying old frames. For web sessions, Playwright's ARIA snapshot API can return an AI-oriented tree with element refs and optional viewport boxes. For native apps, a platform adapter would provide the corresponding accessibility evidence.

This keeps regular Chat lean and avoids paying visual context on turns that never use it. It does **not** remove image cost from an active computer-use loop. Anthropic's current API computer toolset alone has roughly 4.5k input tokens of tool-definition overhead, which is another reason to activate it only on demand.

## Verified / inferred / blocked

**Verified**

- Existing Bunji Agent/Chat separation and stdio memory-MCP scope are in the repo; existing computer permissions are loaded from the saved bot profile, not public run JSON.
- OpenAI's computer-use API requires the caller to run actions and return the matching screenshot; it documents allowlists, untrusted screen content, user confirmation for consequential actions, limits, cancellation, and verification.
- Claude Code documents local stdio MCP. Anthropic's API documents a separate computer client-toolset and a browser-use tool for webpage-only tasks.
- Official TypeSafe material found calls the model **Jev** and describes typed decisions. No official image/computer capability was found in the material reviewed.
- The web PiP API can host arbitrary HTML, but its window is tied to the opener. The project has separate React and SwiftUI UI layers.

**Inferred**

- A local MCP bridge is the smallest shared path to try with already-authenticated Codex/Claude CLI harnesses. It avoids inventing provider subscription APIs and avoids an internet listener. Confirm the MCP image block reaches each selected model/client before committing to this route.
- For a sidebar browser, a dedicated browser context is a safer first target than controlling the user's active Mac session. Cursor, PiP, and activity are renderers over session events, not reasons to give the model more authority.
- Jev may be useful later to choose among bounded DOM candidates; that is a hypothesis, not an official computer-use feature.

**Blocked / not tested here**

- Live MCP image/tool compatibility, plan entitlements/usage, and provider-specific limits in the user's authenticated Codex and Claude CLI sessions.
- Browser embedding/PiP/cursor visuals, browser and native-app execution, operating-system permission flows, and real screenshots. The main agent owns live UI evidence; this spike deliberately does not automate any UI.
- Jev's current API details, image modality, MCP support, and real UI-selection quality. No official primary source reviewed settles these.

## Sources

All product claims below use primary vendor/spec sources, checked September 22, 2026.

- OpenAI Codex MCP and auth: [MCP for Codex CLI](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Codex authentication](https://learn.chatgpt.com/docs/auth).
- Anthropic subscription CLI/MCP: [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Claude Code with Pro or Max](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan).
- API computer use: [OpenAI computer use](https://developers.openai.com/api/docs/guides/tools-computer-use), [Anthropic computer use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool).
- MCP result types: [MCP server tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
- Web UI support: [Playwright ARIA snapshots](https://playwright.dev/docs/api/class-locator#locator-ariasnapshot), [Chrome Document Picture-in-Picture](https://developer.chrome.com/docs/web-platform/document-picture-in-picture).
- Jev: [TypeSafe's official System One/Jev announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev).
