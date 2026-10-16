import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractOtp, formatPhone, jidToPhone, parseForm, parseMoney, phoneToJid, splitNumberLabel, submitForm } from '../src/index.ts'
import { el } from './fake.ts'

test('phoneToJid', () => {
  assert.equal(phoneToJid('+1 (512) 555-0101'), '+15125550101@cheogram.com')
  assert.equal(phoneToJid('5125550101'), '+15125550101@cheogram.com')
  assert.equal(phoneToJid('1-512-555-0101'), '+15125550101@cheogram.com')
  assert.equal(phoneToJid('22000'), '22000;phone-context=ca-us.phone-context.soprani.ca@cheogram.com')
  assert.equal(phoneToJid('+447700900123'), '+447700900123@cheogram.com')
  assert.equal(phoneToJid('hello'), null)
  assert.equal(phoneToJid('12'), null)
})

test('jidToPhone / formatPhone', () => {
  assert.equal(jidToPhone('+15125550101@cheogram.com'), '+15125550101')
  assert.equal(jidToPhone('22000;phone-context=ca-us.phone-context.soprani.ca@cheogram.com'), '22000')
  assert.equal(jidToPhone('cheogram.com'), null)
  assert.equal(formatPhone('+15125550101'), '+1 (512) 555-0101')
  assert.equal(formatPhone('22000'), '22000')
})

test('extractOtp', () => {
  assert.equal(extractOtp('G-535626 is your Google verification code.'), '535626')
  assert.equal(extractOtp('Your code is 123-456'), '123456')
  assert.equal(extractOtp('Call +15125550101 now'), null)
  assert.equal(extractOtp('hello'), null)
})

test('parseMoney', () => {
  assert.deepEqual(parseMoney('$4.9900 / month'), { amount: 4.99, text: '$4.9900 / month' })
  assert.equal(parseMoney('-$1.50')!.amount, -1.5)
  assert.equal(parseMoney('$-1.50')!.amount, -1.5)
  assert.equal(parseMoney('$1,234.5')!.amount, 1234.5)
  assert.equal(parseMoney('n/a'), null)
  assert.equal(parseMoney(null), null)
})

test('splitNumberLabel', () => {
  assert.deepEqual(splitNumberLabel('(325) 999-6404 (ABILENE, TX)'), { phone: '(325) 999-6404', location: 'Abilene, TX' })
  assert.deepEqual(splitNumberLabel('(512) 555-0101'), { phone: '(512) 555-0101', location: null })
})

test('forms: parse tables and submit with defaults, overrides and extra fields', () => {
  const form = parseForm(el(`<x xmlns="jabber:x:data" type="form">
    <field var="a" type="text-single"><value>1</value></field>
    <field var="b" type="boolean"><value>false</value></field>
    <field type="fixed"><value>note</value></field>
    <reported><field var="c" label="C"/></reported>
    <item><field var="c"><value>row1</value></field></item>
  </x>`))
  assert.equal(form.reported[0]!.label, 'C')
  assert.equal(form.items.length, 1)

  const x = submitForm(form, { b: true, extra: ['x', 'y'] })
  const values = Object.fromEntries(x.getChildren('field').map(f => [f.attrs.var, f.getChildren('value').map(v => v.getText())]))
  assert.deepEqual(values, { a: ['1'], b: ['true'], extra: ['x', 'y'] })
  assert.equal(x.attrs.type, 'submit')
})
