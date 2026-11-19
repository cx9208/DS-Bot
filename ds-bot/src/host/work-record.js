// What a stretch of a Bot's conversation did, read from its tool calls without a model:
// the files it changed and the commands it ran. A handoff note or a checkpoint is
// written by the model and can leave these out, or not be written at all; this record
// travels next to it, so the next part still knows what was touched.

const FILES_MAX = 40
const COMMANDS_MAX = 15
const LINE_MAX = 200

// The argument that names the file, per file tool; str_replace_editor's view changes nothing.
const FILE_ARGS = { write: 'file_path', edit: 'file_path', str_replace_editor: 'path' }
const SHELLS = new Set(['bash', 'pwsh'])
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm

const argsOf = call => {
  if (call?.arguments !== null && typeof call?.arguments === 'object') return call.arguments
  try {
    const parsed = JSON.parse(call?.arguments ?? '')
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const oneLine = text => {
  const line = String(text).replace(/\s+/g, ' ').trim()
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line
}

function filesOf(name, args) {
  if (name === 'apply_patch') return [...String(args.input ?? '').matchAll(PATCH_FILE)].map(match => (match[1] ?? match[2]).trim())
  const key = FILE_ARGS[name]
  if (key === undefined || typeof args[key] !== 'string') return []
  if (name === 'str_replace_editor' && args.command === 'view') return []
  return [args[key]]
}

// `calls`: tool-call blocks, oldest first. `cwd`: paths under it are shown relative.
export function workRecord(calls, { cwd } = {}) {
  const files = new Map()
  const commands = []
  const shorten = path => (cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)
  for (const call of calls) {
    if (call?.type !== 'tool-call' || typeof call.name !== 'string') continue
    const args = argsOf(call)
    for (const path of filesOf(call.name, args)) {
      const shown = shorten(path)
      // A file changed again moves to the end, so the list ends with the latest.
      files.delete(shown)
      files.set(shown, true)
    }
    if (SHELLS.has(call.name) && typeof args.command === 'string' && args.command.trim() !== '') {
      const line = oneLine(args.command)
      const last = commands.at(-1)
      if (last?.line === line) last.times += 1
      else commands.push({ line, times: 1 })
    }
  }
  const changed = [...files.keys()]
  return {
    files: changed.slice(-FILES_MAX),
    moreFiles: Math.max(0, changed.length - FILES_MAX),
    commands: commands.slice(-COMMANDS_MAX).map(({ line, times }) => (times > 1 ? `${line} (×${times})` : line)),
    moreCommands: Math.max(0, commands.length - COMMANDS_MAX),
  }
}

// The record as text, or undefined when the stretch changed no file and ran no command.
export function workRecordText(record, heading) {
  if (record === undefined || (record.files.length === 0 && record.commands.length === 0)) return undefined
  return [
    heading,
    'Read from your tool calls, not written by you: it lists what was done, not whether it worked.',
    ...(record.files.length === 0 ? [] : [
      `Files changed${record.moreFiles > 0 ? ` (the latest ${record.files.length}; ${record.moreFiles} earlier not listed)` : ''}:`,
      ...record.files.map(path => `- ${path}`),
    ]),
    ...(record.commands.length === 0 ? [] : [
      `Commands run${record.moreCommands > 0 ? ` (the latest ${record.commands.length}; ${record.moreCommands} earlier not listed)` : ''}:`,
      ...record.commands.map(line => `- ${line}`),
    ]),
  ].join('\n')
}

// The tool calls in a list of messages, oldest first.
export const callsIn = messages => (Array.isArray(messages) ? messages : [])
  .filter(message => message?.role === 'assistant' && Array.isArray(message.content))
  .flatMap(message => message.content.filter(block => block?.type === 'tool-call'))
