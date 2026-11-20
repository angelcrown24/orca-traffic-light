// Return literal source offsets. A matched code span consumes all intervening Markdown syntax.
function scanParagraph(text) {
  const ticks = new Map(), cursors = new Map(), codeStarts = new Set(), targets = []
  for (const run of text.matchAll(/\x60+/g)) {
    const size = run[0].length
    if (!ticks.has(size)) ticks.set(size, [])
    ticks.get(size).push(run.index)
  }
  const destination = /\]\((\.\/)?([\p{L}\p{N}_.\/-]+\.[\w-]+)(?:#[\w-]+)?\)/uy
  const labels = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue }
    if (text[i] === '\x60') {
      let end = i + 1
      while (text[end] === '\x60') end++
      const length = end - i, runs = ticks.get(length) ?? []
      let next = cursors.get(length) ?? 0
      while (next < runs.length && runs[next] <= i) next++
      cursors.set(length, next)
      if (next < runs.length) {
        codeStarts.add(i)
        i = runs[next] + length - 1
      } else i = end - 1
      continue
    }
    if (text[i] === '[') { labels.push(text[i - 1] === '!'); continue }
    if (text[i] !== ']' || !labels.length) continue
    const imageLabel = labels.pop()
    destination.lastIndex = i
    const match = destination.exec(text)
    if (match) {
      targets.push({ path: match[2], start: i + 2 + (match[1]?.length ?? 0) })
      // A link cannot contain another link. A linked image can still close its surrounding label.
      if (!imageLabel) labels.length = 0
      i = destination.lastIndex - 1
    }
  }
  const command = /^\uFEFF?[ \t]*(?:(?:[-*+] |\d+[.)] ))?(?:read|consult|see|run|execute|invoke)[ \t]+\x60(?:(?:python3?|bash|sh|node)[ \t]+)?(?:\.\/)?((?:scripts|references|assets|templates)\/[\w./-]+\.[\w-]+)\x60/gim
  for (const match of text.matchAll(command)) {
    if (codeStarts.has(match.index + match[0].indexOf('\x60'))) {
      targets.push({ path: match[1], start: match.index + match[0].length - 1 - match[1].length })
    }
  }
  return { targets: targets.sort((a, b) => a.start - b.start), codeStarts }
}

export function referenceTargets(text) {
  return scanParagraph(text).targets
}

// Keep line numbers while omitting metadata, fenced examples and quoted/generated instructions.
export function instructionLines(content) {
  const lines = content.split(/\r?\n/)
  let frontmatter = lines[0]?.trim() === '---', fence, exampleDepth = 0
  return lines.map((line, index) => {
    if (frontmatter) {
      if (index && /^(?:---|\.\.\.)\s*$/.test(line)) frontmatter = false
      return null
    }
    const marker = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined
      return null
    }
    if (marker) { fence = marker[1]; return null }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      if (exampleDepth && heading[1].length <= exampleDepth) exampleDepth = 0
      if (!exampleDepth && /\bexamples?\b/i.test(heading[2])) exampleDepth = heading[1].length
    }
    if (!line.trim() || exampleDepth || /^(?: {4}|\t|\s*>)/.test(line)) return null
    return line
  })
}

// Scan a paragraph together so a code span may cross a line break. Offsets in the result are line-relative.
export function targetsForLines(lines, codeStartsByLine) {
  const illustrative = /\b(?:e\.g\.|examples?\b|for instance\b|for illustration\b)/i
  const eligible = lines.map(line => line !== null && !illustrative.test(line))
  const targets = new Map()
  for (let first = 0; first < lines.length;) {
    if (lines[first] === null) { first++; continue }
    let end = first + 1
    while (end < lines.length && lines[end] !== null && !/^#{1,6}\s/.test(lines[end]) && !/^#{1,6}\s/.test(lines[end-1])) end++
    const paragraph = scanParagraph(lines.slice(first, end).join('\n'))
    function locate(positions, save) {
      let index = first, offset = 0
      for (const [position, value] of positions) {
        while (position >= offset + lines[index].length + 1) { offset += lines[index].length + 1; index++ }
        if (eligible[index]) save(index + 1, position - offset, value)
      }
    }
    locate(paragraph.targets.map(target => [target.start, target.path]), (line, start, path) => {
      if (!targets.has(line)) targets.set(line, [])
      targets.get(line).push({ path, start })
    })
    if (codeStartsByLine) locate([...paragraph.codeStarts].map(start => [start]), (line, start) => {
      if (!codeStartsByLine.has(line)) codeStartsByLine.set(line, new Set())
      codeStartsByLine.get(line).add(start)
    })
    first = end
  }
  return targets
}
