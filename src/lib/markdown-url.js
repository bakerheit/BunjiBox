export function markdownUrl(value) {
  return /^(https?:\/\/|mailto:|#)/i.test(value) ? value : ''
}
