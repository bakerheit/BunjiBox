import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { createSecurityRunner, inspectOpenRouterKey, readOpenRouterCredential, runOpenRouter, saveOpenRouterCredential, validOpenRouterKey } from '../src/openrouter.mjs'

const KEY = 'sk-or-v1-1234567890abcdefghijklmnop'

test('OpenRouter credentials validate and Keychain writes keep the key out of argv', async () => {
  assert.equal(validOpenRouterKey(KEY), true)
  assert.equal(validOpenRouterKey('not-a-key'), false)
  const calls = []
  await saveOpenRouterCredential(KEY, { run: async (args, input) => { calls.push({ args, input }) } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.includes(KEY), false)
  assert.equal(calls[0].args.at(-1), '-w')
  assert.equal(calls[0].input, `${KEY}\n${KEY}\n`)
})

test('a stuck macOS Keychain process is killed and returns a bounded error', async () => {
  let killed = false
  let spawnOptions
  const child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.stdin = new Writable({ write(_chunk, _encoding, done) { done() } })
  child.kill = signal => { killed = signal === 'SIGKILL'; queueMicrotask(() => child.emit('close', null, signal)) }
  const run = createSecurityRunner({ spawnProcess: (_command, _args, options) => { spawnOptions = options; return child }, timeoutMs: 5 })
  await assert.rejects(run(['add-generic-password'], 'secret\nsecret\n'), /Keychain timed out/)
  assert.equal(killed, true)
  assert.equal(spawnOptions.detached, true)
})

test('OpenRouter reads Keychain first and safely falls back to the environment', async () => {
  const keychain = await readOpenRouterCredential({ run: async () => KEY, env: { OPENROUTER_API_KEY: 'sk-or-v1-environmentkey1234567890' } })
  assert.deepEqual(keychain, { key: KEY, source: 'keychain' })
  const environment = await readOpenRouterCredential({ run: async () => { throw Object.assign(new Error('missing'), { code: 44 }) }, env: { OPENROUTER_API_KEY: 'sk-or-v1-environmentkey1234567890' } })
  assert.equal(environment.source, 'environment')
})

test('OpenRouter account checks use only the fixed provider origin', async () => {
  const account = await inspectOpenRouterKey(KEY, { signal: undefined, request: async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/key')
    assert.equal(options.headers.Authorization, `Bearer ${KEY}`)
    assert.equal(options.redirect, 'error')
    return { ok: true, json: async () => ({ data: { is_free_tier: true } }) }
  } })
  assert.equal(account.is_free_tier, true)
})

test('OpenRouter chat returns text and provider token counts without exposing the key', async () => {
  const activity = []
  const messages = [{ role: 'system', content: 'You are Chip.' }, { role: 'user', content: 'Hello' }]
  const result = await runOpenRouter({ model: 'openrouter/free', effort: 'medium', prompt: 'Hello' }, {
    messages, credential: async () => ({ key: KEY, source: 'keychain' }), onActivity: item => activity.push(item),
    request: async (url, options) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions')
      assert.equal(options.redirect, 'error')
      const body = JSON.parse(options.body)
      assert.equal(body.model, 'openrouter/free')
      assert.equal(body.reasoning.effort, 'medium')
      assert.deepEqual(body.messages, messages)
      return { ok: true, json: async () => ({ model: 'example/free', choices: [{ message: { content: 'Hi there.' } }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11, completion_tokens_details: { reasoning_tokens: 1 } } }) }
    },
  })
  assert.equal(result.ok, undefined)
  assert.equal(result.failed, false)
  assert.equal(result.text, 'Hi there.')
  assert.deepEqual(result.usage, { inputTokens: 8, outputTokens: 3, cachedInputTokens: null, cacheWriteTokens: null, reasoningOutputTokens: 1, totalTokens: 11, source: 'OpenRouter response usage' })
  assert.deepEqual(activity.map(item => item.status), ['running', 'complete'])
  assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY))
})

test('OpenRouter chat asks for a key without making a request', async () => {
  const result = await runOpenRouter({ model: 'openrouter/free', effort: 'low', prompt: 'Hello' }, { credential: async () => null, request: () => assert.fail('must not request') })
  assert.equal(result.failed, true)
  assert.match(result.error, /Usage page/)
})
