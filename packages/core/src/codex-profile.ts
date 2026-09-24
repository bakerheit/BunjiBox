// Bunji supplies its own identity, memory, file tools, and permission policy.
// Loading the host Codex configuration as well duplicates those capabilities
// and can add every installed plugin, skill, hook, connector, and MCP server to
// a request. `--ignore-user-config` keeps CODEX_HOME authentication while
// skipping config.toml; explicit feature disables keep Agent mode focused.
export const BUNJI_CODEX_DISABLED_FEATURES = Object.freeze([
  'plugins',
  'apps',
  'memories',
  'hooks',
  'browser_use',
  'computer_use',
  'image_generation',
  'multi_agent',
  'goals',
  'workspace_dependencies',
  'skill_search',
])

export function bunjiCodexProfileArgs() {
  return [
    '--ignore-user-config',
    ...BUNJI_CODEX_DISABLED_FEATURES.flatMap(feature => ['--disable', feature]),
  ]
}
