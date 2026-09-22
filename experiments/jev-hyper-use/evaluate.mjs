import { baseline, createClient, metrics } from './harness.mjs'
import { fixtures } from './fixtures.mjs'

const args = process.argv.slice(2)
if (args.length && !(args.length === 2 && args[0] === '--live-case' && fixtures.some(f => f.id === args[1]))) {
  console.error('Usage: node experiments/jev-hyper-use/evaluate.mjs [--live-case synthetic-case-id]')
  process.exitCode = 1
} else if (!args.length) {
  console.log(JSON.stringify({ mode: 'offline-lexical-baseline', ...metrics(fixtures.map(f => ({ expected: f.expected, decision: baseline(f) }))),
    usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null } }, null, 2))
} else {
  const fixture = fixtures.find(f => f.id === args[1])
  const start = performance.now()
  const result = await createClient({ live: true })(fixture)
  console.log(JSON.stringify({ mode: 'live-single-synthetic-case', case: fixture.id, ...result,
    latencyMs: Math.round(performance.now() - start), ...metrics([{ expected: fixture.expected, decision: result.decision }]) }, null, 2))
}
