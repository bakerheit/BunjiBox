export function markdownUrl(value: string): string {
  return /^(https?:\/\/|mailto:|#)/i.test(value) ? value : ''
}
