export function panelLanguage(locale?: string | null): 'en' | 'ko' {
  return /^ko(?:[-_]|$)/i.test(locale?.trim() ?? '') ? 'ko' : 'en'
}

export function englishCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}
