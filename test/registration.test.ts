import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JmpCommandError, REGISTER_NODE } from '../src/index.ts'
import { command, fakeJmp, type CommandCall } from './fake.ts'

const ACTIONS = 'http://jabber.org/protocol/commands#actions'
const form = (fields: string, instructions = '', title = '') =>
  `<x xmlns="jabber:x:data" type="form">${title ? `<title>${title}</title>` : ''}${instructions ? `<instructions>${instructions}</instructions>` : ''}${fields}</x>`
const NAV = '<actions execute="next"><next/><prev/></actions>'

const GATEWAY = command(REGISTER_NODE, 'executing', form(`<field var="gateway-jid" type="list-single"><option label="JMP"><value>jmp.chat</value></option><option label="Other"><value>other.example</value></option></field>`))
const SEARCH = (error = '') => command(REGISTER_NODE, 'executing', form(`<field var="q" type="text-single"/><field var="${ACTIONS}" type="list-single"><value>next</value><option label="Search"><value>next</value></option><option label="Just Show Me Some Numbers"><value>feelinglucky</value></option></field>`, error))
const NUMBERS = command(REGISTER_NODE, 'executing', form(`<field var="tel" type="list-single"><option label="(512) 555-0101 (AUSTIN, TX)"><value>+15125550101</value></option><option label="(512) 555-0102 (AUSTIN, TX)"><value>+15125550102</value></option></field>`))
const FAIR_USE = command(REGISTER_NODE, 'executing', '<note type="info">Fair use policy: be nice</note>')
// JMP's activation is two forms: the method (with an optional referral code for paid methods), then the code itself
const ACTIVATE = command(REGISTER_NODE, 'executing', NAV + form(`<field var="activation_method" type="list-single" label="Activation method"><option label="Credit Card"><value>credit_card</value></option><option label="Bitcoin"><value>bitcoin</value></option><option label="Bitcoin Cash"><value>bch</value></option><option label="Referral Code"><value>code</value></option><option label="Mail or eTransfer"><value>mail</value></option></field><field var="plan_name" type="list-single" label="Plan"><option label="CAD"><value>cad</value></option><option label="USD"><value>usd</value></option></field><field var="code" type="text-single" label="Optional referral code"/>`, '', 'Activate JMP'))
const ENTER_CODE = (error = '') => command(REGISTER_NODE, 'executing', NAV + form(`<field var="code" type="text-single" label="Your referral code"><required/></field>`, error, 'Enter Referral Code'))
const DONE = command(REGISTER_NODE, 'completed', '<note type="info">Your JMP account has been activated as +15125550101</note>')

/** a scripted signup: each call gets the next response, decided by what was submitted */
function signup(opts: { codeOk: boolean }) {
  return (call: CommandCall) => {
    if (!call.sessionId) return GATEWAY
    if (call.values['gateway-jid']) return SEARCH()
    if (call.action === 'prev') return SEARCH()
    if ('q' in call.values) {
      if (call.values.q![0] === '000') return SEARCH('No numbers found, try another search.')
      return NUMBERS
    }
    if (call.values.tel) return FAIR_USE
    if (Object.keys(call.values).length === 0) return ACTIVATE
    if (call.values.activation_method?.[0] === 'code') return ENTER_CODE()
    if (call.values.code?.[0] && !call.values.activation_method) return opts.codeOk ? DONE : ENTER_CODE('Not a valid referral code')
    if (call.values.activation_method?.[0] === 'credit_card') {
      return command(REGISTER_NODE, 'completed', '<x xmlns="jabber:x:oob"><url>https://pay.jmp.chat/activate</url></x>')
    }
    throw new Error(`unexpected ${JSON.stringify(call)}`)
  }
}

test('signup with a promo code: gateway and fair-use steps are automatic', async () => {
  const { conn, jmp } = fakeJmp({ [REGISTER_NODE]: signup({ codeOk: true }) })
  const reg = await jmp.register()
  assert.equal(reg.stage, 'search')

  assert.deepEqual(await reg.search('000'), [])
  assert.equal(reg.message, 'No numbers found, try another search.')

  const numbers = await reg.search('512', { limit: 100 })
  assert.equal(reg.stage, 'choose')
  assert.deepEqual(numbers[0], { tel: '+15125550101', label: '(512) 555-0101 (AUSTIN, TX)', phone: '(512) 555-0101', location: 'Austin, TX' })
  const searchCall = conn.calls.find(c => c.values.q?.[0] === '512')!
  assert.equal(searchCall.x!.getChild('set', 'http://jabber.org/protocol/rsm')!.getChildText('max'), '100')

  await assert.rejects(reg.choose('+19999999999'), /not in the search results/)
  await reg.choose('+15125550101')
  assert.equal(reg.stage, 'activate')
  assert.deepEqual(reg.activationMethods.map(m => m.value), ['credit_card', 'bitcoin', 'bch', 'code', 'mail'])

  const result = await reg.activateWithCode('FAKECODE1', { currency: 'USD' })
  assert.deepEqual(result, { tel: '+15125550101', location: 'Austin, TX', notes: ['Your JMP account has been activated as +15125550101'] })
  // the method on "Activate JMP", then the code again on "Enter Referral Code"
  const [method, entered] = conn.calls.filter(c => c.values.code?.[0])
  assert.deepEqual(method!.values, { activation_method: ['code'], plan_name: ['usd'], code: ['FAKECODE1'] })
  assert.deepEqual(entered!.values, { code: ['FAKECODE1'] })
})

test('random numbers, going back to search, rejected code', async () => {
  const { conn, jmp } = fakeJmp({ [REGISTER_NODE]: signup({ codeOk: false }) })
  const reg = await jmp.register()

  await reg.search({ any: true })
  assert.deepEqual(conn.calls.at(-1)!.values[ACTIONS], ['feelinglucky'])

  // searching again from the list goes back first
  await reg.search('512')
  assert.ok(conn.calls.some(c => c.action === 'prev'))

  await reg.choose('+15125550102')
  // rejected on the second step, after the method was accepted
  await assert.rejects(reg.activateWithCode('FAKEBAD0'), (e: unknown) => e instanceof JmpCommandError && e.message === 'Not a valid referral code')
  assert.equal(conn.calls.filter(c => c.values.code?.[0] === 'FAKEBAD0').length, 2)
  assert.equal(reg.step.form?.title, 'Enter Referral Code')
  await reg.cancel()
  assert.equal(conn.calls.at(-1)!.action, 'cancel')
})

test('paid activation returns the payment link', async () => {
  const { jmp } = fakeJmp({ [REGISTER_NODE]: signup({ codeOk: true }) })
  const reg = await jmp.register()
  await reg.search('512')
  await reg.choose('+15125550101')
  const { urls } = await reg.activate('credit_card', { currency: 'USD' })
  assert.deepEqual(urls, ['https://pay.jmp.chat/activate'])
})
