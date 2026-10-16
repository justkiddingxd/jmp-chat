import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JmpError } from '../src/index.ts'
import { describeError, loginError } from '../src/errors.ts'

function timeoutError(): Error {
  // what @xmpp/events throws when the stream header or a login step doesn't arrive
  const e = new Error()
  e.name = 'TimeoutError'
  return e
}

function connRefused(address: string): Error {
  return Object.assign(new Error(`connect ECONNREFUSED ${address}:5222`), { code: 'ECONNREFUSED' })
}

test('loginError: an empty TimeoutError means the server did not answer', () => {
  const cause = timeoutError()
  const e = loginError(cause, 'me@xmpp.chat', 'xmpp.chat')
  assert.ok(e instanceof JmpError)
  assert.equal(e.message, 'xmpp.chat did not answer in time')
  assert.equal(e.condition, 'remote-server-timeout')
  assert.equal(e.cause, cause)
})

test('loginError: SASL failure is a wrong password', () => {
  const sasl = Object.assign(new Error('not-authorized'), { name: 'SASLError', condition: 'not-authorized' })
  const e = loginError(sasl, 'me@xmpp.chat', 'xmpp.chat')
  assert.equal(e.message, 'wrong JID or password')
  assert.equal(e.condition, 'not-authorized')
})

test('loginError: a JmpError passes through, anything else names the JID', () => {
  const own = new JmpError('xmpp.chat did not answer in time', 'remote-server-timeout')
  assert.equal(loginError(own, 'me@xmpp.chat', 'xmpp.chat'), own)
  const e = loginError(connRefused('127.0.0.1'), 'me@xmpp.chat', 'xmpp.chat')
  assert.equal(e.message, 'could not log in as me@xmpp.chat: connect ECONNREFUSED 127.0.0.1:5222')
})

test('JmpError.from: an empty AggregateError lists its members', () => {
  const agg = Object.assign(new AggregateError([connRefused('::1'), connRefused('127.0.0.1')]), { code: 'ECONNREFUSED' })
  const e = JmpError.from(agg, 'could not log in as me@xmpp.chat')
  assert.equal(e.message,
    'could not log in as me@xmpp.chat: AggregateError ECONNREFUSED [connect ECONNREFUSED ::1:5222; connect ECONNREFUSED 127.0.0.1:5222]')
  assert.equal(e.cause, agg)
})

test('JmpError.from: keeps text / condition / message when there is one', () => {
  assert.equal(JmpError.from({ condition: 'item-not-found', text: 'no such node' }, 'ctx').message, 'ctx: no such node')
  assert.equal(JmpError.from({ condition: 'item-not-found' }, 'ctx').condition, 'item-not-found')
  assert.equal(JmpError.from(new Error('boom'), 'ctx').message, 'ctx: boom')
  assert.equal(JmpError.from('plain', 'ctx').message, 'ctx: plain')
})

test('describeError: code without message, code not repeated', () => {
  assert.equal(describeError(Object.assign(new Error(), { code: 'ENOTFOUND' })), 'Error ENOTFOUND')
  assert.equal(describeError(connRefused('::1')), 'connect ECONNREFUSED ::1:5222')
  assert.equal(describeError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), 'ECONNRESET socket hang up')
})
