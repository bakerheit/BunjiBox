import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BunjiSession, defaultBots, conversationPrompt } from './session.mjs'
import { loadBots, saveBots } from './config.mjs'
import { markdownLines, safeText, tokenLines } from './format.mjs'
import { providerCommand, MAX_PROMPT_LENGTH } from '@bunji/core/runtime'

test('shared runner validates settings and passes prompts as single arguments without a shell', () => {
  const prompt = '$(touch DO_NOT_RUN); "hello"\nworld'
  const [command, args] = providerCommand({ provider: 'codex', model: 'gpt-6-astra', effort: 'ultra', prompt })
  assert.equal(command, 'codex')
  assert.equal(args.at(-1), prompt)
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only')
  const [, claude] = providerCommand({ provider: 'claude', model: 'sonnet', effort: 'high', prompt })
  assert.equal(claude[claude.indexOf('--permission-mode') + 1], 'plan')
  assert.equal(claude[claude.indexOf('--print') + 1], prompt)
  const [ollama, ollamaArgs] = providerCommand({ provider: 'ollama', model: 'gemma3:1b', effort: 'low', prompt })
  assert.equal(ollama, 'ollama-http')
  assert.deepEqual(ollamaArgs, ['gemma3:1b'])
  assert.throws(() => providerCommand({ provider: 'codex', model: 'gpt-5.5', effort: 'ultra', prompt }), /Effort/)
  assert.throws(() => providerCommand({ provider: 'claude', model: 'gpt-6-astra', effort: 'low', prompt }), /model/)
})

test('conversation context keeps recent complete pairs within the shared limit', () => {
  const bot = defaultBots()[1]
  const turns = Array.from({ length: 8 }, (_, i) => ({ status: 'complete', prompt: `question ${i}` + 'q'.repeat(1000), text: `answer ${i}` + 'a'.repeat(1000) }))
  turns.push({ status: 'failed', prompt: 'failed secret', text: 'not valid history' })
  const result = conversationPrompt(bot, turns, 'continue')
  assert.ok(result.prompt.length <= MAX_PROMPT_LENGTH)
  assert.ok(result.omittedTurns > 0)
  assert.equal(result.contextTurns + result.omittedTurns, 8)
  assert.match(result.prompt, /question 7/)
  assert.match(result.prompt, /answer 7/)
  assert.doesNotMatch(result.prompt, /failed secret|question 0/)
  assert.throws(() => conversationPrompt(bot, [], 'x'.repeat(MAX_PROMPT_LENGTH)), /too long/)
})

test('bot chats stay isolated and model changes reach the shared runner', async () => {
  const calls = []
  const session = new BunjiSession({ run: async options => { calls.push(options); return { ok: true, text: 'The secret is kiwi.', usage: { totalTokens: 12 } } } })
  await session.send('Remember kiwi')
  await session.send('What was it?')
  assert.match(calls[1].prompt, /Remember kiwi/)
  assert.match(calls[1].prompt, /The secret is kiwi/)
  session.select('scout')
  session.update({ provider: 'claude', model: 'sonnet', effort: 'high' })
  await session.send('Hi Scout')
  assert.doesNotMatch(calls[2].prompt, /kiwi/)
  assert.equal(calls[2].provider, 'claude')
  assert.equal(calls[2].model, 'sonnet')
  assert.equal(calls[2].effort, 'high')
  assert.equal(session.requests.length, 1)
  session.select('bunjibox')
  assert.equal(session.requests.length, 2)
})

test('cancellation and activity updates stay with the originating bot', async () => {
  const session = new BunjiSession({ run: async (_options, { signal, onActivity }) => {
    onActivity({ id: 'tool', kind: 'tool', status: 'running', title: 'Read file' })
    onActivity({ id: 'tool', kind: 'tool', status: 'running', title: 'Read file', input: 'README.md' })
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    return { ok: false, usage: { totalTokens: 42 } }
  } })
  const request = session.send('Start')
  await assert.rejects(session.send('Concurrent'), /already running/)
  session.select('scout')
  session.stop()
  await request
  assert.equal(session.requests.length, 0)
  session.select('bunjibox')
  assert.equal(session.requests[0].status, 'cancelled')
  assert.equal(session.requests[0].activities.length, 1)
  assert.equal(session.requests[0].activities[0].status, 'unknown')
  assert.equal(session.requests[0].usage.totalTokens, 42)
  assert.equal(session.busy, null)
})

test('bot settings round-trip privately; invalid config is not silently overwritten', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bunji-config-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'settings', 'config.json')
  assert.deepEqual(await loadBots(path), defaultBots())
  const bots = defaultBots()
  bots[0].name = 'My helper'
  await saveBots(bots, path)
  assert.deepEqual(await loadBots(path), bots)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  await writeFile(path, '{bad json')
  await assert.rejects(loadBots(path), /Fix or move this file/)
  assert.equal(await readFile(path, 'utf8'), '{bad json')
})

test('terminal output strips cursor, clipboard and color escape injection', () => {
  const hostile = '\u001b[2JHello\u001b]52;c;c2VjcmV0\u0007\u001b[31m world\u001b[0m\u0000'
  assert.equal(safeText(hostile), 'Hello world')
  assert.doesNotMatch(markdownLines(hostile, 40).join('\n'), /52;|2J|c2VjcmV0/)
})

test('Markdown renders headings, nested formatting, tasks and code instead of literal syntax', () => {
  const output = safeText(markdownLines('# Hello\n\n- **bold**\n- *italic*\n  - nested\n\n- [x] done\n\n```js\nconst x = 1\n```\n\n[docs](https://example.com)', 80).join('\n'))
  assert.match(output, /Hello/)
  assert.match(output, /• bold/)
  assert.match(output, /• italic/)
  assert.match(output, /\[x\] done/)
  assert.match(output, /const x = 1/)
  assert.match(output, /docs \(https:\/\/example.com\)/)
  assert.doesNotMatch(output, /\*\*|```|# Hello/)
})

test('unknown token usage is not zero, and partial totals are labeled', () => {
  const pending = { status: 'running', model: 'gpt-6-astra', effort: 'low', usage: null }
  assert.match(tokenLines([pending], 40).join('\n'), /— tokens/)
  assert.match(tokenLines([pending, { ...pending, usage: { totalTokens: 42 } }], 40).join('\n'), /≥ 42 tokens/)
})
