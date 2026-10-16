import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JmpCommandError, JmpError, type Delivered, type GatewayNotice, type Sms, type SmsError } from '../src/index.ts'
import { command, fakeJmp } from './fake.ts'
import { ALT_TOP_UP, CONFIGURE_CALLS, CREDIT_CARDS, INFO, PLAN_SETTINGS, REFERRAL, REFERRAL_INVITES, TRANSACTIONS, XMR_ADDRESS } from './fixtures.ts'

test('incoming sms with otp, mms, gateway notice and offline delay', () => {
  const { conn, jmp } = fakeJmp()
  const sms: Sms[] = []
  const notices: GatewayNotice[] = []
  jmp.on('sms', m => sms.push(m))
  jmp.on('notice', n => notices.push(n))

  conn.receive(`<message from="22000;phone-context=ca-us.phone-context.soprani.ca@cheogram.com/x" type="chat" id="m1"><body>G-535626 is your Google verification code.</body></message>`)
  conn.receive(`<message from="+15125550101@cheogram.com" type="chat"><body>https://media.example/pic.jpg</body><x xmlns="jabber:x:oob"><url>https://media.example/pic.jpg</url></x><delay xmlns="urn:xmpp:delay" stamp="2026-10-01T10:00:00Z"/></message>`)
  conn.receive(`<message from="cheogram.com" type="chat"><body>Your account will renew soon</body></message>`)
  // not from the gateway: ignored
  conn.receive(`<message from="friend@example.org" type="chat"><body>hi</body></message>`)

  assert.equal(sms.length, 2)
  assert.equal(sms[0]!.from, '22000')
  assert.equal(sms[0]!.otp, '535626')
  assert.equal(sms[0]!.id, 'm1')
  assert.equal(sms[1]!.body, '')
  assert.deepEqual(sms[1]!.media, ['https://media.example/pic.jpg'])
  assert.equal(sms[1]!.receivedAt.toISOString(), '2026-10-01T10:00:00.000Z')
  assert.equal(notices[0]!.body, 'Your account will renew soon')
})

test('sendSms / sendMms build gateway messages, receipts and errors come back by id', async () => {
  const { conn, jmp } = fakeJmp()
  const delivered: Delivered[] = []
  const errors: SmsError[] = []
  jmp.on('delivered', d => delivered.push(d))
  jmp.on('smsError', e => errors.push(e))

  const id = await jmp.sendSms('(512) 555-0101', 'hello')
  const sent = conn.sent[0]!
  assert.equal(sent.attrs.to, '+15125550101@cheogram.com')
  assert.equal(sent.attrs.id, id)
  assert.equal(sent.getChildText('body'), 'hello')
  assert.ok(sent.getChild('request', 'urn:xmpp:receipts'))

  conn.receive(`<message from="+15125550101@cheogram.com" id="r1"><received xmlns="urn:xmpp:receipts" id="${id}"/></message>`)
  assert.deepEqual(delivered, [{ id, to: '+15125550101' }])

  const mmsId = await jmp.sendMms('5125550101', 'https://example.org/a.png', { caption: 'look', receipt: false })
  assert.equal(conn.sent[1]!.getChild('x', 'jabber:x:oob')!.getChildText('url'), 'https://example.org/a.png')
  assert.equal(conn.sent[2]!.getChildText('body'), 'look')
  assert.equal(conn.sent[1]!.getChild('request', 'urn:xmpp:receipts'), undefined)

  conn.receive(`<message from="+15125550101@cheogram.com" type="error" id="${mmsId}"><error type="cancel"><service-unavailable xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/><text xmlns="urn:ietf:params:xml:ns:xmpp-stanzas">Number not reachable</text></error></message>`)
  assert.deepEqual(errors, [{ id: mmsId, to: '+15125550101', condition: 'service-unavailable', text: 'Number not reachable' }])

  await assert.rejects(jmp.sendSms('not a number', 'x'), JmpError)
})

test('approves presence subscription from the gateway only', () => {
  const { conn } = fakeJmp()
  conn.receive(`<presence from="cheogram.com" type="subscribe"/>`)
  conn.receive(`<presence from="spam.example" type="subscribe"/>`)
  assert.equal(conn.sent.length, 1)
  assert.equal(conn.sent[0]!.attrs.type, 'subscribed')
  assert.equal(conn.sent[0]!.attrs.to, 'cheogram.com')
})

test('account.info / transactions / referralCode', async () => {
  const { jmp } = fakeJmp({ info: () => INFO, transactions: () => TRANSACTIONS, 'referral codes': () => REFERRAL })

  const info = await jmp.account.info()
  assert.equal(info!.tel, '+15125550101')
  assert.equal(info!.active, true)
  assert.equal(info!.balance!.amount, 0)
  assert.equal(info!.renewal!.amount, 4.99)
  assert.equal(info!.includedCallingCredit!.amount, 1.044)
  assert.equal(info!.expiresAt, '2026-11-12')
  assert.equal(info!.autoTopUp, false)

  const tx = await jmp.account.transactions()
  assert.equal(tx.length, 2)
  assert.equal(tx[1]!.amount!.amount, -4.99)
  assert.equal(tx[0]!.createdAt!.toISOString(), '2026-10-01T12:00:00.000Z')

  const referral = await jmp.account.referralCode()
  assert.equal(referral.code, 'ABCD1234')
  assert.deepEqual(referral.invites, [])
  assert.match(referral.text, /^This code will provide credit/)
})

test('referralCode: result form with single-use invites', async () => {
  const { jmp } = fakeJmp({ 'referral codes': () => REFERRAL_INVITES })
  const referral = await jmp.account.referralCode()
  assert.equal(referral.code, 'TEST0REF')
  assert.deepEqual(referral.invites, ['FAKE0001', 'FAKE0002'])
  assert.match(referral.text, /single use/)
})

test('referralCode: invites without a var fall back to the first column, no code', async () => {
  const { jmp } = fakeJmp({
    'referral codes': () => command('referral codes', 'completed', '<x xmlns="jabber:x:data" type="result"><title>Unused Referral Codes</title><reported><field label="Invite Code" var="invite"/></reported><item><field var="invite"><value> FAKE0003 </value></field></item></x>')
  })
  assert.deepEqual(await jmp.account.referralCode(), { code: null, invites: ['FAKE0003'], text: '' })
})

test('account.info is null without a JMP account', async () => {
  const { jmp } = fakeJmp({ info: () => command('info', 'completed', '<note type="info">Not registered</note>') })
  assert.equal(await jmp.account.info(), null)
})

test('topUp: card url, alternatives, crypto address', async () => {
  const { conn, jmp } = fakeJmp({
    'credit cards': () => CREDIT_CARDS,
    'alt top up': call => (call.action === 'execute' && !call.sessionId ? ALT_TOP_UP : XMR_ADDRESS)
  })

  assert.match(await jmp.topUp.cardUrl(), /^https:\/\/pay\.jmp\.chat\/.+credit_cards/)
  // executing session got cancelled
  assert.ok(conn.calls.some(c => c.node === 'credit cards' && c.action === 'cancel'))

  const alt = await jmp.topUp.alternatives()
  assert.deepEqual(alt.crypto.map(c => c.currency), ['BTC', 'BCH', 'XMR', 'ETH'])
  assert.match(alt.mail!.address, /Kitchener/)
  assert.equal(alt.balance, 'Current balance: $0.0000')

  const xmr = await jmp.topUp.crypto('XMR')
  assert.deepEqual(xmr.addresses, ['4TestMoneroAddressDoNotPayToThisAddress000000000000000000000000000000000000000000000000'])
  assert.match(xmr.description, /\$20 or more/)
  const submit = conn.calls.find(c => c.node === 'alt top up' && c.sessionId && c.action === 'execute')!
  assert.deepEqual(submit.values['http://jabber.org/protocol/commands#actions'], ['XMR'])
})

test('topUp.withSavedCard passes every form to the filler', async () => {
  const amountForm = command('top up', 'executing', `<x xmlns="jabber:x:data" type="form"><field var="amount" type="list-single"><value>15</value><option label="$15"><value>15</value></option><option label="$30"><value>30</value></option></field></x>`)
  const { conn, jmp } = fakeJmp({
    'top up': call => (call.sessionId ? command('top up', 'completed', '<note type="info">$30 added</note>') : amountForm)
  })
  const step = await jmp.topUp.withSavedCard(form => {
    assert.equal(form.fields[0]!.var, 'amount')
    return { amount: '30' }
  })
  assert.equal(step.notes[0]!.text, '$30 added')
  assert.deepEqual(conn.calls[1]!.values.amount, ['30'])
})

test('settings: read, partial write, validation error', async () => {
  let accepted = true
  const { conn, jmp } = fakeJmp({
    'plan settings': call => (call.sessionId ? (accepted ? command('plan settings', 'completed', '<note type="info">Saved</note>') : PLAN_SETTINGS) : PLAN_SETTINGS),
    'configure calls': call => (call.sessionId ? command('configure calls', 'completed', '') : CONFIGURE_CALLS)
  })

  const plan = await jmp.settings.plan()
  assert.equal(plan.monthlyOverageLimit, 0)
  assert.deepEqual(await jmp.settings.setPlan({ monthlyOverageLimit: 5 }), ['Saved'])

  accepted = false
  await assert.rejects(jmp.settings.setPlan({ monthlyOverageLimit: -1 }), /did not accept/)

  const calls = await jmp.settings.calls()
  assert.equal(calls.voicemailEnabled, true)
  assert.equal(calls.ringSeconds, 25)
  assert.equal(calls.forwardOptions.length, 2)
  assert.equal(calls.callerName, null)

  await jmp.settings.setCalls({ ringSeconds: 40 })
  const submitted = conn.calls.filter(c => c.node === 'configure calls' && c.sessionId && c.action === 'execute').at(-1)!.values
  assert.deepEqual(submitted['fwd[timeout]'], ['40'])
  // untouched settings keep their current values
  assert.deepEqual(submitted['fwd[voicemail_enabled]'], ['true'])

  await assert.rejects(jmp.settings.setPortOutPin('1'), JmpError)
})

test('runCommand turns error notes into JmpCommandError', async () => {
  const { jmp } = fakeJmp({ transactions: () => command('transactions', 'completed', '<note type="error">Account not found</note>') })
  await assert.rejects(jmp.account.transactions(), (e: unknown) => e instanceof JmpCommandError && e.message === 'Account not found')
})

test('listCommands and unknown commands', async () => {
  const { conn, jmp } = fakeJmp()
  conn.commandList = [{ node: 'info', name: 'Show Account Info' }, { node: 'top up', name: 'Buy credit' }]
  assert.deepEqual((await jmp.listCommands()).map(c => c.node), ['info', 'top up'])
  assert.equal(await jmp.topUp.hasSavedCard(), true)
  await assert.rejects(jmp.runCommand('nope'), (e: unknown) => e instanceof JmpError && e.condition === 'item-not-found')
})
