# jmp-chat

[![npm](https://img.shields.io/npm/v/jmp-chat)](https://www.npmjs.com/package/jmp-chat) [![CI](https://github.com/justkiddingxd/jmp-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/justkiddingxd/jmp-chat/actions/workflows/ci.yml)

A Node.js client for [JMP.chat](https://jmp.chat) accounts. Give it a JID that has a JMP number (or should get one) and you can:

- send and receive SMS / MMS, with delivery receipts, errors and verification codes pulled out of the text
- read the account: status, number, balance, renewal date, transactions, call history, referral code and invites
- top up: personal card payment page, charging a saved card, crypto addresses (BTC, BCH, XMR, ETH)
- change settings: overage limit, voicemail, call forwarding, caller ID name, port-out PIN
- sign a JID up for a new number: search, pick, activate with a promo code or a payment
- run any other JMP command through a generic ad-hoc command session

JMP has no HTTP API. Everything goes over XMPP: texts are messages to `+15551234567@cheogram.com`, and account features are [XEP-0050](https://xmpp.org/extensions/xep-0050.html) ad-hoc commands on `cheogram.com`. This library wraps both on top of [`@xmpp/client`](https://github.com/xmppjs/xmpp.js).

Not affiliated with JMP.chat or Soprani.ca.

```sh
npm i jmp-chat
```

Node 22+, ESM only, TypeScript types included.

## Quick start

```ts
import { JmpClient } from 'jmp-chat'

const jmp = await JmpClient.connect({ jid: 'me@example.org', password: '...' })

jmp.on('sms', (sms) => {
  console.log(sms.from, sms.body, sms.otp) // '+15125550101', 'G-535626 is your…', '535626'
})

await jmp.sendSms('+1 (512) 555-0101', 'hello from node')

const info = await jmp.account.info()
console.log(info?.tel, info?.balance?.amount, info?.expiresAt) // '+15125550199', 12.5, '2026-11-12'

await jmp.close()
```

### Sharing an existing connection

If your app already holds an `@xmpp/client` connection, attach to it instead of opening a second one. You manage the connection and the initial presence yourself:

```ts
import { client, xml } from '@xmpp/client'
import { JmpClient } from 'jmp-chat'

const xmpp = client({ service: 'xmpp://example.org', username: 'me', password: '...' })
xmpp.on('online', () => xmpp.send(xml('presence')))
await xmpp.start()

const jmp = JmpClient.attach(xmpp)
```

## Messages

```ts
const id = await jmp.sendSms('5125550101', 'hi')              // 10 digits = US/Canada
await jmp.sendSms('22000', 'STOP')                            // short codes work too
await jmp.sendMms('+15125550101', 'https://example.org/cat.jpg', { caption: 'look' })

jmp.on('sms', (sms) => { /* { id, from, fromJid, body, media, otp, receivedAt } */ })
jmp.on('delivered', ({ id, to }) => { /* the gateway confirmed message `id` (XEP-0184, when it sends receipts) */ })
jmp.on('smsError', ({ id, to, condition, text }) => { /* message `id` could not be sent */ })
jmp.on('notice', ({ body }) => { /* a message from cheogram.com itself */ })
```

- `sms.media` holds MMS picture urls; `body` is empty for a picture without text.
- `sms.receivedAt` is the original time for messages the server kept while you were offline.
- To answer a short code, reply to `sms.fromJid` — it carries the routing context the gateway needs.

Helpers: `phoneToJid(input)`, `jidToPhone(jid)`, `formatPhone('+15125550101')` → `+1 (512) 555-0101`, `extractOtp(text)`.

## Account

```ts
await jmp.account.info()           // null when the JID has no JMP number
await jmp.account.transactions()   // [{ amount: { amount: -4.99, text: '-$4.9900' }, note, createdAt }]
await jmp.account.calls()          // [{ start, direction, tel, status, duration, rate, charge }]
await jmp.account.referralCode()   // { code: 'ABCD1234', invites: ['EF567890'], text }
```

`referralCode()` returns the reusable referral code (a friend gets a month after paying, you get a month once their payment clears), the single-use invite codes JMP lists in its "Unused Referral Codes" table (each a free month; `[]` when there are none) and JMP's text as is.

Money comes as `{ amount: number, text: string }`: `text` is exactly what JMP printed.

## Topping up

```ts
await jmp.topUp.cardUrl()      // personal pay.jmp.chat page: pay, save a card, enable auto top-up
await jmp.topUp.alternatives() // { crypto: [{ currency: 'BTC', label }], mail: { address, note }, balance }

const { addresses, description } = await jmp.topUp.crypto('XMR')
// description holds JMP's terms, e.g. the minimum amount
```

With a card already saved (`await jmp.topUp.hasSavedCard()`), charge it from code. JMP decides what to ask, so you answer each form:

```ts
const step = await jmp.topUp.withSavedCard((form) => {
  console.log(form.fields) // see what JMP asks for
  return { amount: '30' }
})
console.log(step.notes.map(n => n.text))
```

`crypto('BTC')` and `crypto('BCH')` add a permanent address to the account; `XMR` and `ETH` addresses are single-use.

## Settings

```ts
await jmp.settings.plan()                               // { monthlyOverageLimit: 0, description }
await jmp.settings.setPlan({ monthlyOverageLimit: 5 })

await jmp.settings.calls()   // { voicemailEnabled, ringSeconds, voicemailTranscription, forwardTo, forwardOptions, callerName }
await jmp.settings.setCalls({ ringSeconds: 30, forwardTo: 'sip:me@sip.example.org' }) // others stay as they are

await jmp.settings.setPortOutPin('a1b2c3')
```

## Getting a number

```ts
const reg = await jmp.register()

let numbers = await reg.search('512')           // area code, 'TX', 'Austin, TX', '~777'
if (numbers.length === 0) console.log(reg.message) // "No numbers found, try another search."
numbers = await reg.search({ any: true })       // whatever is available

await reg.choose(numbers[0].tel)

// with a promo / referral code
const { tel } = await reg.activateWithCode('PROMOCODE', { currency: 'USD' })

// or pay: JMP answers with a payment page
console.log(reg.activationMethods)              // [{ value: 'credit_card', label }, { value: 'code', … }, …]
const { urls } = await reg.activate('credit_card')
```

The gateway choice and the fair-use notice are answered automatically. If JMP shows a step this library does not know, `reg.stage` is `'unknown'`: inspect `reg.step.form` and answer with `reg.submit(values)`. Always `reg.cancel()` a signup you abandon.

## Any other command

Everything JMP offers is an ad-hoc command, including the ones not wrapped here (`sims`, `lnp`, `subaccount`, `change jabber id`, …):

```ts
await jmp.listCommands() // [{ node: 'info', name: '👤 Show Account Info' }, …]

const session = await jmp.startCommand('sims')
console.log(session.form)                       // title, instructions, fields, table rows
await session.submit({ 'http://jabber.org/protocol/commands#actions': 'order-esim' })
console.log(session.step.status, session.step.notes, session.step.links)
await session.cancel()                          // always cancel what you do not finish
```

`jmp.runCommand(node)` runs a one-step command and returns its result. The form helpers (`parseForm`, `submitForm`, `fieldValue`, `formRows`) are exported for your own parsing.

## Errors

Everything rejects with `JmpError` (`.condition` holds the XMPP error condition, e.g. `not-authorized`, `item-not-found`). When JMP answers a command with an error note — a rejected code, a missing account — you get `JmpCommandError` with `.notes` and `.step`.

## Testing your code

`JmpClient.attach()` accepts anything shaped like `XmppConnection` (`iqCaller.request`, `send`, `on('stanza')`), so you can drive it with a fake. See `test/fake.ts` in the repository.

## Releasing

Bump the version and push the tag; GitHub Actions tests, builds and publishes to npm with provenance, then creates a GitHub release:

```sh
npm version patch   # or minor / major
git push --follow-tags
```

## License

MIT
