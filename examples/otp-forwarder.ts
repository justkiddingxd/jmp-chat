// prints every SMS with its verification code and shows the account status on start:
//   JMP_JID=me@example.org JMP_PASSWORD=... node --import tsx examples/otp-forwarder.ts
import { JmpClient, formatPhone } from '../src/index.ts'

const jmp = await JmpClient.connect({ jid: process.env.JMP_JID!, password: process.env.JMP_PASSWORD! })

const info = await jmp.account.info()
if (!info) throw new Error('this JID has no JMP number')
console.log(`${formatPhone(info.tel!)}: ${info.status}, balance ${info.balance?.text}, renews ${info.expiresAt}`)

jmp.on('sms', (sms) => {
  console.log(`${formatPhone(sms.from)}: ${sms.body}${sms.otp ? `  [code ${sms.otp}]` : ''}`)
})
jmp.on('smsError', e => console.error(`not delivered to ${e.to}: ${e.text}`))

process.once('SIGINT', () => jmp.close().then(() => process.exit(0)))
