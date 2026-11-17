import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { adapters } from '../src/host/im/platforms/index.js'

// A Feishu adapter stand-in: it records card sends and serves the OpenAPI calls a
// digital employee makes from canned chats, people and messages.
const fakeFeishu = () => {
  const sent = []
  const posts = []
  const files = []
  const reads = []
  const reactions = []
  const people = { ou_zhang: '张三', ou_li: '李四', ou_owner: 'Owner' }
  const chats = { oc_g1: { name: '产品周会' } }
  const history = {
    oc_g1: [
      { message_id: 'om_3', msg_type: 'text', create_time: '1763359380000', sender: { id: 'ou_zhang', sender_type: 'user' }, body: { content: JSON.stringify({ text: '@_user_1 能看一下这个需求吗' }) }, mentions: [{ key: '@_user_1', id: 'ou_bot', name: 'Bot' }], parent_id: 'om_2' },
      { message_id: 'om_2', msg_type: 'file', create_time: '1763359320000', sender: { id: 'ou_li', sender_type: 'user' }, body: { content: JSON.stringify({ file_key: 'fk', file_name: 'spec.docx' }) } },
      { message_id: 'om_1', msg_type: 'text', create_time: '1763359260000', sender: { id: 'cli_a1', sender_type: 'app' }, body: { content: JSON.stringify({ text: 'earlier answer' }) } },
    ],
  }
  const adapter = {
    id: 'feishu',
    sent, posts, files, reads, reactions,
    handlers: null,
    async check() { return { account: { id: 'ou_bot', name: 'fakebot' } } },
    connect(fields, env, handlers) {
      adapter.handlers = handlers
      handlers.onStatus({ state: 'ready' })
      return {
        send: async (chat, body) => { sent.push({ chat, ...body }); return { messageId: `m${sent.length}` } },
        edit: async () => {},
        stop: () => {},
        employee: adapter.api = {
          appId: 'cli_a1',
          botOpenId: async () => 'ou_bot',
          user: async (id) => (people[id] === undefined ? {} : { name: people[id] }),
          app: async id => (id === 'cli_scan' ? { app_name: '暴露面扫描' } : {}),
          members: async () => [],
          chat: async id => chats[id] ?? {},
          chats: async () => ({ items: [{ chat_id: 'oc_g1', name: '产品周会' }], more: false }),
          messages: async (chatKey, options) => { reads.push({ chatKey, ...options }); return { items: history[chatKey] ?? [], more: true, pageToken: 'pt_next' } },
          message: async () => undefined,
          post: async (to, body) => { posts.push({ to, ...body }); return { messageIds: ['om_sent'] } },
          sendFile: async (to, body) => { files.push({ to, ...body, data: Buffer.from(body.data).toString() }); return { messageId: 'om_file', kind: body.name.endsWith('.png') ? 'image' : 'file' } },
          react: async (id, emoji) => { if (id === "om_denied") throw new Error("no permission"); reactions.push({ id, emoji }); return "r1" },
          resource: async () => new Uint8Array(),
        },
      }
    },
  }
  return adapter
}

const TEAM = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

// Short waits, so a test sees a notice soon after the message and messages go out at once.
const QUICK = { settleMs: 5, settleMaxMs: 20, groupSettleMs: 5, groupSettleMaxMs: 20, typingScale: 0 }

async function start(employee = QUICK) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-emp-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM()))
  const ctx = fakeContext({})
  const prompts = []
  const agents = new Map()
  const agentOf = (id) => {
    if (!agents.has(id)) agents.set(id, {
      id,
      session: { id, requestHeader: () => undefined },
      followup() {},
      steered: [],
      steer(message) { this.steered.push(message) },
      cancel() {},
      inbox: { nextStep: [], nextTurn: [], remove: () => false },
      async whenIdle() {},
    })
    return agents.get(id)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [] },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'w1' }), archiveSession: async () => {} },
    sessionController: {
      prompt: async (request) => { prompts.push(request); return { ok: true } },
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
    },
    sessions: { flush: async () => {} },
  })
  const fake = fakeFeishu()
  const real = adapters.feishu
  adapters.feishu = fake
  const rt = createRuntime(ctx, { home, im: { feishu: { employee } } })
  const emitEvent = (sessionId, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id: sessionId }, { type, data, time: Date.now() })
    }
  }
  const fireApprovals = (request, next) => Promise.all((ctx.listeners.get('approval/request') ?? []).map(listener => listener(request, next)))
  const stop = async () => {
    adapters.feishu = real
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  const conn = await rt.imEndpoint('im-add', { platform: 'feishu', botId: 'a', fields: { domain: 'feishu', appId: 'cli_a1', appSecret: 'sec-1' } })
  await rt.imEndpoint('im-update', { id: conn.id, mode: 'employee' })
  await delay(10)
  const tool = name => (args, botId = 'a') => rt.teamTools.find(def => def.name === name).execute(args, { agent: { id: botId } })
  const say = async (message, settle = 40) => { await fake.handlers.onMessage(message); await delay(settle) }
  return { say, agentOf, ctx, rt, fake, prompts, emitEvent, fireApprovals, stop, conn: () => rt.state.im.connections[conn.id], tool }
}

const TENANT = 'tk_corp'
const msg = ({ from = 'ou_zhang', chat = { key: 'oc_dm_zhang', kind: 'direct', title: 'oc_dm_zhang' }, text = 'hi', mentioned = false, tenant = TENANT, type = 'user' } = {}) => ({
  chat, sender: { id: from, name: from, type, tenant }, tenant: TENANT, text, images: [], files: [], mentioned, messageId: `om_in_${Math.random()}`,
})
const group = { key: 'oc_g1', kind: 'group', title: 'oc_g1' }

test('a direct message from a colleague puts a notice in the Bot chat, not the message itself', async (t) => {
  const s = await start()
  t.after(s.stop)
  await s.say(msg({ text: 'please review the contract' }))
  assert.equal(s.prompts.length, 1)
  const prompt = s.prompts[0]
  assert.equal(prompt.sessionId, 'a')
  assert.match(prompt.requestId, /^imnote:feishu:/)
  const notice = prompt.content[0].text
  assert.match(notice, /张三 sent you a direct message on Feishu \(chat oc_dm_zhang; 1 unread\)/)
  assert.match(notice, /feishu_read_chat/)
  assert.doesNotMatch(notice, /contract/, 'the Bot reads the chat itself')
  assert.equal(s.fake.sent.length, 0, 'no pairing request goes back to the colleague')
  assert.equal(s.conn().chats.oc_dm_zhang.title, 'direct message with 张三')
})

test('other companies and other apps do not wake the Bot', async (t) => {
  const s = await start()
  t.after(s.stop)
  await s.say(msg({ tenant: 'tk_other' }))
  await s.say(msg({ tenant: '' }))
  await s.say(msg({ type: 'app' }))
  assert.equal(s.prompts.length, 0)
  // A paired account from elsewhere still may.
  s.conn().paired.push({ id: 'ou_guest', name: 'Guest', at: 1 })
  await s.rt.save()
  await s.say(msg({ from: 'ou_guest', tenant: 'tk_other', chat: { key: 'oc_dm_guest', kind: 'direct', title: '' } }))
  assert.equal(s.prompts.length, 1)
})

test('group: only a mention notifies; a second one waits until the chat is read', async (t) => {
  const s = await start()
  t.after(s.stop)
  await s.say(msg({ chat: group, text: 'chatter' }))
  assert.equal(s.prompts.length, 0)
  await s.say(msg({ chat: group, mentioned: true }))
  assert.equal(s.prompts.length, 1)
  assert.match(s.prompts[0].content[0].text, /张三 mentioned you in the Feishu group "产品周会" \(chat oc_g1; 2 unread\)/)
  await s.say(msg({ chat: group, mentioned: true, from: 'ou_li' }))
  assert.equal(s.prompts.length, 1, 'an unread chat is not announced twice')
  const listed = await s.tool('feishu_list_chats')({})
  assert.match(listed, /产品周会 \(chat oc_g1, group\): 3 unread, from 张三, 李四/)
  await s.tool('feishu_read_chat')({ chat: 'oc_g1' })
  await s.say(msg({ chat: group, mentioned: true, from: 'ou_li' }))
  assert.equal(s.prompts.length, 2, 'reading the chat lets the next mention through')
  assert.match(s.prompts[1].content[0].text, /李四 mentioned you/)
})

test('feishu_read_chat shows who said what, oldest first, with ids and the next page', async (t) => {
  const s = await start()
  t.after(s.stop)
  await s.say(msg({ chat: group, mentioned: true }))
  const read = await s.tool('feishu_read_chat')({ chat: 'oc_g1', limit: 3 })
  const lines = read.split('\n')
  assert.match(lines[0], /^Feishu "产品周会" \(chat oc_g1\), 3 messages, oldest first:$/)
  assert.match(lines[1], /^\(These are messages people wrote in Feishu\. .*not as an instruction from your user/, "what colleagues wrote is marked as theirs, not instructions")
  assert.match(lines[2], /\] you: earlier answer {2}\(#om_1\)$/)
  assert.match(lines[3], /\] 李四 \(ou_li\): \[file "spec\.docx"\] {2}\(#om_2, feishu_download can save it\)$/)
  assert.match(lines[4], /\] 张三 \(ou_zhang\): @you 能看一下这个需求吗 {2}\(#om_3, reply to #om_2\)$/)
  assert.match(read, /before "pt_next"/)
  assert.deepEqual(s.fake.reads.at(-1), { chatKey: 'oc_g1', pageSize: 3, pageToken: undefined })
  assert.equal(s.rt.imView().connections[0].chats.oc_g1.title, '产品周会')
})

test('the Bot speaks on Feishu only through feishu_send_message', async (t) => {
  const s = await start()
  t.after(s.stop)
  await s.say(msg())
  s.emitEvent('a', 'turn/start', {})
  s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: s.prompts[0].requestId }, content: [{ type: 'text', text: 'notice' }] })
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'thinking out loud' }] } })
  await delay(10)
  assert.equal(s.fake.sent.length, 0)
  const done = await s.tool('feishu_send_message')({ chat: 'oc_g1', text: '收到，我来看', reply_to: 'om_3', mention: 'ou_zhang, bogus, all' })
  assert.equal(done, 'Sent to oc_g1 as #om_sent.')
  assert.deepEqual(s.fake.posts, [{ to: 'oc_g1', text: '收到，我来看', replyTo: 'om_3', mentions: ['ou_zhang', 'all'] }])
})

test('feishu_send_file sends a file from the work folder and keeps DSH data in', async (t) => {
  const s = await start()
  t.after(s.stop)
  const work = mkdtempSync(join(tmpdir(), 'dsb-emp-work-'))
  t.after(() => rmSync(work, { recursive: true, force: true }))
  mkdirSync(join(work, 'out'))
  writeFileSync(join(work, 'out', 'report.docx'), 'the report')
  writeFileSync(join(work, 'empty.txt'), '')
  s.rt.botOf('a').workDir = work
  const send = s.tool('feishu_send_file')
  assert.equal(await send({ chat: 'oc_g1', path: 'out/report.docx', reply_to: 'om_3' }), 'Sent report.docx to oc_g1 as a file (#om_file).')
  assert.equal(s.fake.files.length, 1)
  assert.deepEqual(s.fake.files[0], { to: 'oc_g1', name: 'report.docx', data: 'the report', replyTo: 'om_3' })
  assert.match(await send({ chat: 'oc_g1', path: join(work, 'missing.pdf') }), /There is no file at/)
  assert.match(await send({ chat: 'oc_g1', path: 'out' }), /is a folder, not a file/)
  assert.match(await send({ chat: 'oc_g1', path: 'empty.txt' }), /is empty/)
  assert.match(await send({ chat: 'oc_g1', path: join(s.rt.home, 'state.json') }), /in DeepSeek Harness data, which is not sent out/)
  assert.match(await send({ chat: 'oc_g1', path: 'out/report.docx' }, 'b'), /not a Feishu digital employee/)
  assert.equal(s.fake.files.length, 1, 'nothing else left the computer')
})

test('the Feishu tools are offered to the employee Bot only, and refuse anyone else', async (t) => {
  const s = await start()
  t.after(s.stop)
  assert.equal(s.rt.toolOffered('feishu_read_chat', 'a'), true)
  assert.equal(s.rt.toolOffered('feishu_read_chat', 'b'), false)
  assert.equal(s.rt.toolOffered('read_own_chat', 'b'), true)
  assert.match(await s.tool('feishu_send_message')({ chat: 'oc_g1', text: 'x' }, 'b'), /not a Feishu digital employee/)
  await s.rt.imEndpoint('im-update', { id: s.conn().id, mode: 'channel' })
  assert.equal(s.rt.toolOffered('feishu_read_chat', 'a'), false)
  assert.equal(s.rt.imView().connections[0].mode, 'channel')
})

test('only Feishu IM bots take the employee mode', async (t) => {
  const s = await start()
  t.after(s.stop)
  await assert.rejects(s.rt.imEndpoint('im-update', { id: s.conn().id, mode: 'boss' }), /Unknown mode/)
  s.conn().platform = 'telegram'
  await assert.rejects(s.rt.imEndpoint('im-update', { id: s.conn().id, mode: 'employee' }), /Only Feishu/)
})

test('an approval goes to the owner\'s direct chat, whoever started the turn', async (t) => {
  const s = await start()
  t.after(s.stop)
  s.conn().paired.push({ id: 'ou_owner', name: 'Owner', at: 1 })
  await s.rt.save()
  // The owner's direct chat is learned from the owner writing to the Bot.
  await s.say(msg({ from: 'ou_owner', chat: { key: 'oc_dm_owner', kind: 'direct', title: '' } }))
  assert.equal(s.conn().chats.oc_dm_owner.owner, 'ou_owner')
  await s.say(msg({ chat: group, mentioned: true }))
  const racing = s.fireApprovals({ agent: { id: 'a' }, toolName: 'bash', reason: 'run it', signal: new AbortController().signal }, () => new Promise(() => {}))
  await delay(20)
  assert.equal(s.fake.sent.length, 1)
  assert.equal(s.fake.sent[0].chat.key, 'oc_dm_owner')
  assert.match(s.fake.sent[0].text, /bash/)
  const approvalId = s.fake.sent[0].buttons[0].data.split(':')[1]
  // A colleague pressing the button is not the owner and is ignored.
  await s.fake.handlers.onAction({ chat: { key: 'oc_g1', kind: 'group', title: '' }, sender: { id: 'ou_zhang', name: '' }, data: `a:${approvalId}:allow`, messageId: 'x' })
  await s.fake.handlers.onAction({ chat: { key: 'oc_dm_owner', kind: 'direct', title: '' }, sender: { id: 'ou_owner', name: '' }, data: `a:${approvalId}:allow`, messageId: 'm1' })
  assert.equal((await racing)[0], 'allowed-once')
  // Answering from the owner's chat claims the turn there, and still no text goes out.
  const before = s.fake.sent.length
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'done with the command' }] } })
  await delay(10)
  assert.equal(s.fake.sent.length, before)
})

test('a burst of messages becomes one notice once the person pauses', async (t) => {
  const s = await start({ ...QUICK, settleMs: 60, settleMaxMs: 1000 })
  t.after(s.stop)
  await s.say(msg({ text: '在吗' }), 10)
  await s.say(msg({ text: '帮我看个合同' }), 10)
  await s.say(msg({ text: '今天要' }), 10)
  assert.equal(s.prompts.length, 0, 'still typing')
  await delay(120)
  assert.equal(s.prompts.length, 1)
  assert.match(s.prompts[0].content[0].text, /3 unread/)
  assert.match(s.prompts[0].content[0].text, /feishu_acknowledge/, 'the notice says when to acknowledge')
})

test('a burst never holds the notice past its limit', async (t) => {
  const s = await start({ ...QUICK, settleMs: 60, settleMaxMs: 100 })
  t.after(s.stop)
  for (let i = 0; i < 6; i += 1) await s.say(msg({ text: `line ${i}` }), 30)
  assert.equal(s.prompts.length, 1, 'announced at the limit although messages kept coming')
})

test('news in the chat the Bot is working on joins its running turn', async (t) => {
  const s = await start()
  t.after(s.stop)
  await s.say(msg())
  s.emitEvent('a', 'turn/start', {})
  if (s.rt.live.get('a')?.turn === undefined) s.rt.live.set('a', { ...s.rt.live.get('a'), turn: {} })
  await s.tool('feishu_read_chat')({ chat: 'oc_dm_zhang' })
  await s.say(msg({ text: '对了，还有附件' }))
  assert.equal(s.prompts.length, 1, 'no new notice queued')
  const steered = s.agentOf('a').steered
  assert.equal(steered.length, 1)
  assert.match(steered[0].content[0].text, /张三 wrote again in chat oc_dm_zhang while you were on it/)
  // Another chat still gets a notice of its own.
  await s.say(msg({ from: 'ou_li', chat: { key: 'oc_dm_li', kind: 'direct', title: '' } }))
  assert.equal(s.prompts.length, 2)
  // Once the turn ends, the chat is announced the usual way again.
  s.emitEvent('a', 'turn/end', {})
  s.rt.live.get('a').turn = undefined
  await s.say(msg({ text: '人呢' }))
  assert.equal(s.prompts.length, 3)
  assert.equal(steered.length, 1)
})

test('feishu_send_message sends several short messages in order, quoting only with the first', async (t) => {
  const s = await start()
  t.after(s.stop)
  const done = await s.tool('feishu_send_message')({ chat: 'oc_dm_zhang', messages: ['收到', '我看一下', ''], reply_to: 'om_3', mention: 'ou_zhang' })
  assert.match(done, /^Sent 2 messages to oc_dm_zhang/)
  assert.deepEqual(s.fake.posts, [
    { to: 'oc_dm_zhang', text: '收到', replyTo: 'om_3', mentions: ['ou_zhang'] },
    { to: 'oc_dm_zhang', text: '我看一下', mentions: [] },
  ])
  assert.match(await s.tool('feishu_send_message')({ chat: 'oc_g1', text: 'a', messages: ['b'] }), /not both/)
  assert.match(await s.tool('feishu_send_message')({ chat: 'oc_g1', messages: [] }), /what to send/)
})

test('a group gets at most three messages in a row; the rest join the last', async (t) => {
  const s = await start()
  t.after(s.stop)
  await s.say(msg({ chat: group, mentioned: true }))
  await s.tool('feishu_send_message')({ chat: 'oc_g1', messages: ['1', '2', '3', '4', '5'] })
  assert.deepEqual(s.fake.posts.map(post => post.text), ['1', '2', '3\n4\n5'])
})

test('messages pause like typing, and a file asked for after them waits its turn', async (t) => {
  const s = await start({ ...QUICK, typingScale: 0.05 })
  t.after(s.stop)
  const work = mkdtempSync(join(tmpdir(), 'dsb-emp-order-'))
  t.after(() => rmSync(work, { recursive: true, force: true }))
  const path = join(work, 'report.pdf')
  writeFileSync(path, 'pdf')
  const order = []
  const started = Date.now()
  const talking = s.tool('feishu_send_message')({ chat: 'oc_g1', messages: ['报告好了', '我发给你'] }).then(() => order.push('text'))
  const filing = s.tool('feishu_send_file')({ chat: 'oc_g1', path }).then(() => order.push('file'))
  await Promise.all([talking, filing])
  assert.ok(Date.now() - started >= 25, 'a typing pause before the second message')
  assert.deepEqual(order, ['text', 'file'])
  assert.equal(s.fake.posts.length, 2)
  assert.equal(s.fake.files.length, 1)
})

test('feishu_acknowledge puts a 了解 reaction on the request', async (t) => {
  const s = await start()
  t.after(s.stop)
  assert.equal(await s.tool('feishu_acknowledge')({ message_id: 'om_3' }), 'Reacted 了解 to #om_3.')
  assert.deepEqual(s.fake.reactions, [{ id: 'om_3', emoji: 'Get' }])
  assert.match(await s.tool('feishu_acknowledge')({ message_id: 'oc_g1' }), /message id/)
  assert.match(await s.tool('feishu_acknowledge')({ message_id: 'om_denied' }), /im:message\.reactions:write_only/)
  assert.match(await s.tool('feishu_acknowledge')({ message_id: 'om_3' }, 'b'), /not a Feishu digital employee/)
})

test('a read without names says why, and takes names from @mentions', async (t) => {
  const s = await start()
  t.after(s.stop)
  s.fake.api.user = async () => { throw new Error('Feishu error 99991672: Access denied') }
  s.fake.api.members = async () => { throw new Error('Feishu error 232011: bot not in chat') }
  // om_3 mentions the Bot only; add a message that @mentions 李四 by name.
  const before = s.fake.api.messages
  s.fake.api.messages = async (chatKey, options) => {
    const page = await before(chatKey, options)
    return { ...page, items: [{ message_id: 'om_4', msg_type: 'text', create_time: '1763359440000', sender: { id: 'ou_zhang', sender_type: 'user' }, body: { content: JSON.stringify({ text: '@_user_1 你来' }) }, mentions: [{ key: '@_user_1', id: 'ou_li', name: '李四' }] }, ...page.items] }
  }
  const read = await s.tool('feishu_read_chat')({ chat: 'oc_g1' })
  assert.match(read, /\] 李四 \(ou_li\): \[file/, 'the name from the mention is used')
  assert.match(read, /\] ou_zhang \(ou_zhang\): /)
  assert.match(read, /Feishu did not give the names of ou_zhang, so their open ids stand in\./)
  assert.match(read, /Why: contact API: Feishu error 99991672: Access denied; chat members API: Feishu error 232011/)
  assert.match(read, /contact:user\.base:readonly/)
})

test('a message from another app shows that app\'s name and id', async (t) => {
  const s = await start()
  t.after(s.stop)
  const report = (id, appId) => ({ message_id: id, msg_type: 'text', create_time: '1763359500000', sender: { id: appId, sender_type: 'app' }, body: { content: JSON.stringify({ text: '今日暴露面扫描日报' }) } })
  const before = s.fake.api.messages
  s.fake.api.messages = async (chatKey, options) => {
    const page = await before(chatKey, options)
    return { ...page, items: [report('om_6', 'cli_other'), report('om_5', 'cli_scan'), ...page.items] }
  }
  let read = await s.tool('feishu_read_chat')({ chat: 'oc_g1' })
  assert.match(read, /\] you: earlier answer/, 'its own messages stay "you"')
  assert.match(read, /\] 暴露面扫描 \(app cli_scan\): 今日暴露面扫描日报/)
  assert.match(read, /\] an app \(app cli_other\): 今日暴露面扫描日报/)
  assert.match(read, /Feishu did not give the names of the apps cli_other, so their app ids stand in\. Why: the app API returned no name\./)
  assert.match(read, /admin:app\.info:readonly/)
  assert.doesNotMatch(read, /apps cli_scan/)
  s.fake.api.app = async () => { throw new Error('Feishu error 99991672: Access denied') }
  s.fake.api.messages = async () => ({ items: [report('om_7', 'cli_third')], more: false })
  read = await s.tool('feishu_read_chat')({ chat: 'oc_g1' })
  assert.match(read, /Why: app API: Feishu error 99991672: Access denied\./)
})
