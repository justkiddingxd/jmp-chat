import type { JmpClient } from './client.ts'
import { ACTIONS_FIELD, stepUrls, type CommandStep } from './commands.ts'
import { JmpError } from './errors.ts'
import type { DataForm, FormValues } from './forms.ts'

export const CRYPTO_CURRENCIES = ['BTC', 'BCH', 'XMR', 'ETH'] as const
export type CryptoCurrency = (typeof CRYPTO_CURRENCIES)[number]

export interface CryptoAddress {
  currency: CryptoCurrency
  /** where to send; Bitcoin may list every address the account has */
  addresses: string[]
  /** JMP's terms, e.g. minimum amount and fees */
  description: string
  title: string
}

export interface AlternativeMethods {
  /** cryptocurrencies JMP offers right now: code → label */
  crypto: { currency: string, label: string }[]
  /** postal address for cheques / money orders, and what to write on them */
  mail: { address: string, note: string } | null
  /** "Current balance: $0.0000" as JMP shows it */
  balance: string | null
}

/** form filler for paying with a saved card: return the values for each step */
export type CardFormFiller = (form: DataForm, step: CommandStep) => FormValues | Promise<FormValues>

/** adding money to the account (`credit cards`, `top up`, `alt top up`) */
export class TopUp {
  constructor(private readonly jmp: JmpClient) {}

  /** your personal pay.jmp.chat page: pay by card, save a card, set up auto top-up */
  async cardUrl(): Promise<string> {
    const step = await this.jmp.runCommand('credit cards')
    const url = stepUrls(step)[0]
    if (!url) throw new JmpError('JMP did not return a payment page')
    return url
  }

  /** whether a card is saved, so `withSavedCard` can charge it */
  async hasSavedCard(): Promise<boolean> {
    return (await this.jmp.listCommands()).some(c => c.node === 'top up')
  }

  /** what the `alt top up` command offers right now */
  async alternatives(): Promise<AlternativeMethods> {
    const session = await this.jmp.startCommand('alt top up')
    try {
      const form = session.assertOk().form
      const adr = form?.fields.find(f => f.var === 'adr')
      return {
        crypto: (form?.fields.find(f => f.var === ACTIONS_FIELD)?.options ?? [])
          .filter(o => o.value !== 'complete')
          .map(o => ({ currency: o.value, label: o.label })),
        mail: adr?.values[0] ? { address: adr.values[0], note: adr.desc } : null,
        balance: form?.fields.find(f => !f.var && /balance/i.test(f.values[0] ?? ''))?.values[0] ?? null
      }
    } finally {
      await session.cancel()
    }
  }

  /** an address to pay to in crypto; the account is credited at the exchange rate once confirmed */
  async crypto(currency: CryptoCurrency): Promise<CryptoAddress> {
    const session = await this.jmp.startCommand('alt top up')
    try {
      const actions = session.form?.fields.find(f => f.var === ACTIONS_FIELD)
      if (!actions?.options.some(o => o.value === currency)) throw new JmpError(`JMP does not accept ${currency} right now`)

      await session.submit({ [ACTIONS_FIELD]: currency })
      const { form } = session.assertOk()
      // the result form may repeat the mailing address and balance; addresses are the rest
      const fields = (form?.fields ?? []).filter(f => f.var && f.var !== 'adr' && f.var !== ACTIONS_FIELD && f.values.length > 0)
      const preferred = fields.filter(f => /address/i.test(f.var) || /address/i.test(f.label))
      const picked = preferred.length > 0 ? preferred : fields
      const addresses = picked.flatMap(f => f.values.flatMap(v => v.split(/\s+/))).filter(Boolean)
      if (addresses.length === 0) throw new JmpError(`JMP returned no ${currency} address`)

      return {
        currency,
        addresses,
        description: picked.map(f => f.desc).filter(Boolean).join('\n') || form?.instructions || '',
        title: form?.title ?? ''
      }
    } finally {
      await session.cancel()
    }
  }

  /**
   * charges the saved card. JMP decides what it asks (amount etc.), so `fill` gets every form
   * and returns the answers. resolves with the final step; its notes say what happened
   */
  async withSavedCard(fill: CardFormFiller): Promise<CommandStep> {
    const session = await this.jmp.startCommand('top up')
    try {
      for (let i = 0; i < 10 && session.executing; i++) {
        session.assertOk()
        const form = session.form
        if (!form || form.type !== 'form') {
          await session.submit()
          continue
        }
        await session.submit(await fill(form, session.step))
      }
      if (session.executing) throw new JmpError('too many payment steps')
      return session.assertOk()
    } finally {
      await session.cancel()
    }
  }
}
