type ReferenceTarget = { path: string; start: number }
export function referenceTargets(text: string): ReferenceTarget[]
export function instructionLines(content: string): (string | null)[]
export function targetsForLines(lines: (string | null)[], codeStartsByLine?: Map<number, Set<number>>): Map<number, ReferenceTarget[]>
