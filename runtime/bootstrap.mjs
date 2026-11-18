import {
  lstat,
  realpath,
  readFile,
  writeFile,
  mkdir,
  rename,
  unlink,
  chmod,
  open
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, relative, isAbsolute, sep } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const START = '<!-- traffic-light:auto:start -->'
const END = '<!-- traffic-light:auto:end -->'
const hash = (text) => createHash('sha256').update(text).digest('hex')
const contains = (root, path) => {
  const r = relative(root, path)
  return !r || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r))
}
const q = (value) =>
  process.platform === 'win32'
    ? "'" + value.replaceAll("'", "''") + "'"
    : "'" + value.replaceAll("'", "'\\''") + "'"
function issue(message) {
  const e = new Error(message)
  e.code = 'BOOTSTRAP_CONFLICT'
  return e
}
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw issue('Traffic Light storage must be a real private directory.')
  await chmod(path, 0o700)
}
export async function atomicPrivate(path, data) {
  const tmp = path + '.' + randomUUID() + '.tmp'
  await writeFile(tmp, data, { flag: 'wx', mode: 0o600 })
  try {
    await rename(tmp, path)
  } finally {
    await unlink(tmp).catch(() => {})
  }
}
export function automationDirectory(home = homedir()) {
  return join(home, '.agents', 'traffic-light')
}
async function existing(path) {
  let info
  try {
    info = await lstat(path)
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  let actual = path
  if (info.isSymbolicLink()) {
    try {
      actual = await realpath(path)
    } catch {
      throw issue('An instruction symlink has no valid target; it was left unchanged.')
    }
  }
  const handle = await open(
    actual,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  try {
    const targetInfo = await handle.stat()
    if (!targetInfo.isFile() || targetInfo.size > 1024 * 1024)
      throw issue('Only bounded regular instruction files can be managed.')
    const bytes = Buffer.alloc(1024 * 1024 + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    if (length > 1024 * 1024) throw issue('The instruction file exceeded the size limit.')
    return { info, bytes: bytes.subarray(0, length) }
  } finally {
    await handle.close()
  }
}
async function canonicalMissing(path) {
  try {
    return await realpath(path)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    const parent = dirname(path)
    if (parent === path) throw issue('The instruction path is unavailable.')
    return join(
      await canonicalMissing(parent),
      path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1))
    )
  }
}
async function readManifest(base) {
  const p = join(base, 'bootstrap.json')
  const value = await existing(p)
  if (!value) return null
  if (!value.info.isFile() || value.info.isSymbolicLink() || value.bytes.length > 128 * 1024)
    throw issue('Bootstrap manifest is invalid.')
  try {
    const m = JSON.parse(value.bytes.toString())
    if (m.version !== 1 || !Array.isArray(m.files)) throw 0
    return m
  } catch {
    throw issue('Bootstrap manifest is invalid.')
  }
}
function mainBlock(cli) {
  return `${START}\n## Traffic Light shared capabilities\nWhen this task needs a skill or external tool, use the local shared catalog instead of loading every installed capability. Requires local shell access and Node.js 18+.\n- When a task would benefit from a skill, even if the user did not name it, run \`node ${q(cli)} recommend "short task description"\`. Use the conversation handle with --session if started. Check the suggested metadata and read a relevant skill with the handle before applying it. Check required tools against this agent’s available tools or the approved catalog. If a dependency is missing, report it and respect the skill’s fallback conditions.\n- Search only relevant approved metadata: \`node ${q(cli)} search "task keywords"\`.\n- Before first use in THIS conversation, run \`node ${q(cli)} start\` once and remember the returned session handle. Never borrow another conversation's handle.\n- Use \`node ${q(cli)} --session HANDLE search "keywords"\`, \`skill ITEM_ID\`, or \`tools ITEM_ID\` only as needed. Invoke \`call ITEM_ID TOOL_NAME\` with a JSON argument object on stdin; use \`end\` when finished.\n- Run from the task workspace. Access is determined by the canonical working directory and the workspace's selected allowlist, not the focused Orca tab.\n- A missing runner or denied capability is optional-tool unavailability: continue ordinary work. Never restart the conversation, change provider MCP settings, load all tools, or automatically retry a write. Preserve existing user instructions and approvals.\n${END}`
}
function bridgeBlock(ssot) {
  return `${START}\nRead the shared agent instructions in ${q(ssot)} before using shared tools. The Traffic Light block there provides the local, on-demand capability commands.\n${END}`
}
function detectBlock(text) {
  const starts = text.split(START).length - 1
  const ends = text.split(END).length - 1
  if (!starts && !ends) return null
  if (starts !== 1 || ends !== 1)
    throw issue('Managed instruction markers conflict. Existing instructions were left unchanged.')
  const begin = text.indexOf(START)
  const end = text.indexOf(END) + END.length
  if (end < begin) throw issue('Managed instruction markers conflict.')
  return { begin, end, text: text.slice(begin, end) }
}
async function target(home, path) {
  const value = await existing(path)
  if (!value) {
    const actual = await canonicalMissing(path)
    if (!contains(await realpath(home), actual))
      throw issue('Instruction target lies outside the user home.')
    return { path: actual, original: null, mode: 0o600 }
  }
  if (!Buffer.from(value.bytes.toString('utf8')).equals(value.bytes))
    throw issue('Instruction text is not valid UTF-8; it was left unchanged.')
  if (value.bytes.length > 1024 * 1024)
    throw issue('Instruction file is too large to update safely.')
  const actual = await realpath(path)
  if (!contains(await realpath(home), actual))
    throw issue('Instruction target lies outside the user home.')
  const info = await lstat(actual)
  if (!info.isFile()) throw issue('Instruction target is not a regular file.')
  return { path: actual, original: value.bytes, mode: info.mode & 0o777 }
}
async function writeChecked(item, next) {
  const current = await existing(item.path)
  if (
    !(current === null && item.original === null) &&
    !(
      current &&
      current.info.isFile() &&
      !current.info.isSymbolicLink() &&
      item.original &&
      current.bytes.equals(item.original)
    )
  )
    throw issue('Instructions changed concurrently; no overwrite was performed.')
  await mkdir(dirname(item.path), { recursive: true })
  const tmp = item.path + '.' + randomUUID() + '.tmp'
  await writeFile(tmp, next, { flag: 'wx', mode: item.mode })
  try {
    await rename(tmp, item.path)
  } finally {
    await unlink(tmp).catch(() => {})
  }
}
export async function bootstrapStatus({ home = homedir() } = {}) {
  const base = automationDirectory(home)
  const providers = []
  let manifest
  try {
    manifest = await readManifest(base)
  } catch {
    return { setup: false, providers: [], conflict: true }
  }
  async function installedBlock(path) {
    try {
      const actual = await realpath(path)
      const item = manifest?.files.find(x => x.path === actual)
      const value = await existing(path)
      const block = detectBlock(value?.bytes.toString('utf8') ?? '')
      return Boolean(item && block && hash(block.text) === item.blockHash)
    } catch { return false }
  }
  for (const [name, path] of [
    ['Codex', join(home, '.codex', 'AGENTS.md')],
    ['Gemini', join(home, '.gemini', 'GEMINI.md')],
    ['Claude', join(home, '.claude', 'CLAUDE.md')]
  ]) {
    providers.push({ name, state: await installedBlock(path) ? 'ready' : 'unconfigured' })
  }
  const cli = await existing(join(base, 'auto-cli.mjs'))
  const setup = Boolean(
    manifest &&
      cli?.info.isFile() && !cli.info.isSymbolicLink() &&
      await installedBlock(join(home, '.agents', 'AGENTS.md')) &&
      hash(cli.bytes) === manifest.cliHash &&
      providers.every((x) => x.state === 'ready')
  )
  return { setup, providers }
}
// Restore the recommendation command for grants created by an older plugin release.
export async function refreshOwnedBootstrap(home) {
  const manifest = await readManifest(automationDirectory(home))
  if (!manifest) return
  const source = await readFile(new URL('./auto-cli.mjs', import.meta.url))
  if (hash(source) !== manifest.cliHash && (await bootstrapStatus({ home })).setup) {
    await installBootstrap({ home })
  }
}

export async function installBootstrap({ home = homedir() } = {}) {
  const base = automationDirectory(home)
  await privateDirectory(base)
  const manifest = await readManifest(base)
  const ssot = join(home, '.agents', 'AGENTS.md')
  const cli = join(base, 'auto-cli.mjs')
  const oldCli = await existing(cli)
  if (
    oldCli &&
    (!manifest ||
      !oldCli.info.isFile() ||
      oldCli.info.isSymbolicLink() ||
      hash(oldCli.bytes) !== manifest.cliHash)
  )
    throw issue('An unmanaged or modified Traffic Light launcher exists.')
  const planned = new Map()
  for (const [path, block] of [
    [ssot, mainBlock(cli)],
    [join(home, '.codex', 'AGENTS.md'), bridgeBlock(ssot)],
    [join(home, '.gemini', 'GEMINI.md'), bridgeBlock(ssot)],
    [join(home, '.claude', 'CLAUDE.md'), bridgeBlock(ssot)]
  ]) {
    const item = await target(home, path)
    if (planned.has(item.path)) continue // Existing provider symlinks already point to the SSOT.
    const content = item.original?.toString('utf8') ?? ''
    const currentBlock = detectBlock(content)
    const previous = manifest?.files.find((x) => x.path === item.path)
    if (currentBlock && (!previous || hash(currentBlock.text) !== previous.blockHash))
      throw issue('A managed instruction block was edited; no instructions were overwritten.')
    if (previous && !currentBlock)
      throw issue('A managed instruction block was removed; reconcile it before enabling again.')
    const inserted = currentBlock
      ? block
      : (content && !content.endsWith('\n') ? '\n' : '') + '\n' + block + '\n'
    const next = currentBlock
      ? content.slice(0, currentBlock.begin) + block + content.slice(currentBlock.end)
      : content + inserted
    planned.set(item.path, { ...item, next, blockHash: hash(block), inserted, previous })
  }
  const source = await readFile(fileURLToPath(new URL('./auto-cli.mjs', import.meta.url)))
  const backupDir = join(base, 'backups', randomUUID())
  await privateDirectory(backupDir)
  const written = []
  try {
    let i = 0
    for (const item of planned.values()) {
      if (item.original)
        await writeFile(join(backupDir, String(i++) + '.bak'), item.original, {
          flag: 'wx',
          mode: 0o600
        })
      await writeChecked(item, item.next)
      written.push(item)
    }
    await atomicPrivate(cli, source)
    const files = [...planned.values()].map((x) => ({
      path: x.path,
      blockHash: x.blockHash,
      created: x.previous?.created ?? x.original === null,
      inserted: x.previous ? x.previous.inserted.replace(/<!-- traffic-light:auto:start -->[\s\S]*?<!-- traffic-light:auto:end -->/, () => x.inserted) : x.inserted
    }))
    await atomicPrivate(
      join(base, 'bootstrap.json'),
      JSON.stringify({ version: 1, cliHash: hash(source), files, backupDir })
    )
  } catch (e) {
    for (const item of written.reverse()) {
      const now = await existing(item.path)
      if (
        now &&
        now.info.isFile() &&
        !now.info.isSymbolicLink() &&
        now.bytes.equals(Buffer.from(item.next))
      ) {
        if (item.original === null) await unlink(item.path)
        else await writeFile(item.path, item.original, { mode: item.mode })
      }
    }
    if (oldCli) await atomicPrivate(cli, oldCli.bytes)
    else await unlink(cli).catch(() => {})
    throw e
  }
  return bootstrapStatus({ home })
}
export async function removeBootstrap({ home = homedir() } = {}) {
  const base = automationDirectory(home)
  const manifest = await readManifest(base)
  if (!manifest) return bootstrapStatus({ home })
  const changes = []
  for (const item of manifest.files) {
    const current = await target(home, item.path)
    const text = current.original?.toString('utf8') ?? ''
    const block = detectBlock(text)
    if (!block || hash(block.text) !== item.blockHash)
      throw issue('A managed block changed. Disable refused to preserve the user edits.')
    // Remove exactly the bytes we inserted when possible; preserve all unrelated additions.
    const next = text.includes(item.inserted)
      ? text.replace(item.inserted, '')
      : text.slice(0, block.begin) + text.slice(block.end)
    changes.push({ ...current, next, remove: item.created && next.length === 0 })
  }
  const cli = join(base, 'auto-cli.mjs')
  const currentCli = await existing(cli)
  if (
    currentCli &&
    (!currentCli.info.isFile() ||
      currentCli.info.isSymbolicLink() ||
      hash(currentCli.bytes) !== manifest.cliHash)
  )
    throw issue('The launcher changed; disable refused to remove it.')
  const written = []
  let removedCli = false
  try {
    for (const item of changes) {
      if (item.remove) {
        const current = await existing(item.path)
        if (
          !current ||
          !current.info.isFile() ||
          current.info.isSymbolicLink() ||
          !current.bytes.equals(item.original)
        )
          throw issue('Instructions changed concurrently; removal stopped.')
        await unlink(item.path)
      } else await writeChecked(item, item.next)
      written.push(item)
    }
    const latestCli = await existing(cli)
    if (
      latestCli &&
      (!latestCli.info.isFile() ||
        latestCli.info.isSymbolicLink() ||
        hash(latestCli.bytes) !== manifest.cliHash)
    )
      throw issue('The launcher changed during removal.')
    if (latestCli) {
      await unlink(cli)
      removedCli = true
    }
    await unlink(join(base, 'bootstrap.json'))
  } catch {
    for (const item of written.reverse()) {
      const current = await existing(item.path).catch(() => null)
      const unchanged = item.remove
        ? current === null
        : current &&
          current.info.isFile() &&
          !current.info.isSymbolicLink() &&
          current.bytes.equals(Buffer.from(item.next))
      if (unchanged) {
        try {
          await writeChecked({ ...item, original: current?.bytes ?? null }, item.original)
        } catch {}
      }
    }
    if (removedCli && currentCli && !(await existing(cli))) {
      await writeFile(cli, currentCli.bytes, { flag: 'wx', mode: 0o600 }).catch(() => {})
    }
    throw issue(
      'Removal stopped. Managed edits were rolled back where unchanged; concurrent user edits were preserved. Review the remaining managed blocks before retrying.'
    )
  }
  return bootstrapStatus({ home })
}
