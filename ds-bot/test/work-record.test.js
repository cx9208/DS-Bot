import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callsIn, workRecord, workRecordText } from '../src/host/work-record.js'

const call = (name, args) => ({ type: 'tool-call', id: name, name, arguments: JSON.stringify(args) })

test('the work record lists the files changed, the latest last, and the commands run', () => {
  const record = workRecord([
    call('write', { file_path: '/w/a.md', content: 'x' }),
    call('read', { file_path: '/w/notes.md' }),
    call('str_replace_editor', { command: 'view', path: '/w/c.js' }),
    call('str_replace_editor', { command: 'str_replace', path: '/elsewhere/d.js' }),
    call('apply_patch', { input: '*** Begin Patch\n*** Update File: src/e.js\n@@\n-a\n+b\n*** Add File: src/f.js\n+x\n*** Update File: src/g.js\n*** Move to: src/h.js\n*** End Patch' }),
    call('edit', { file_path: '/w/a.md', old_string: 'x', new_string: 'y' }),
    call('bash', { command: 'npm test' }),
    call('bash', { command: 'npm test' }),
    call('pwsh', { command: 'git status\n  --short' }),
  ], { cwd: '/w' })
  assert.deepEqual(record.files, ['/elsewhere/d.js', 'src/e.js', 'src/f.js', 'src/g.js', 'src/h.js', 'a.md'])
  assert.deepEqual(record.commands, ['npm test (×2)', 'git status --short'])
})

test('a long stretch keeps the latest entries and says how many it left out', () => {
  const calls = Array.from({ length: 50 }, (_, index) => call('write', { file_path: `/w/f${index}.txt` }))
  calls.push(...Array.from({ length: 20 }, (_, index) => call('bash', { command: `step ${index} ${'x'.repeat(300)}` })))
  const record = workRecord(calls, { cwd: '/w' })
  assert.equal(record.files.length, 40)
  assert.equal(record.files.at(-1), 'f49.txt')
  assert.equal(record.moreFiles, 10)
  assert.equal(record.commands.length, 15)
  assert.equal(record.moreCommands, 5)
  assert.ok(record.commands.every(line => line.length <= 200))
  const text = workRecordText(record, '## Work')
  assert.match(text, /Files changed \(the latest 40; 10 earlier not listed\):/)
  assert.match(text, /Commands run \(the latest 15; 5 earlier not listed\):/)
})

test('a stretch without changes or commands has no record, and bad arguments are skipped', () => {
  assert.equal(workRecordText(workRecord([call('read', { file_path: '/w/a' }), { type: 'tool-call', name: 'write', arguments: '{oops' }]), '## Work'), undefined)
  assert.deepEqual(callsIn([{ role: 'user', content: [] }, { role: 'assistant', content: [{ type: 'text', text: 'x' }, call('bash', { command: 'ls' })] }]).map(block => block.name), ['bash'])
})
