import type { JmpClient } from './client.ts'
import { fieldValue, formRows, type DataForm } from './forms.ts'
import { parseMoney, type Money } from './money.ts'

export interface AccountInfo {
  /** "Active", "Expired", ... as JMP reports it */
  status: string | null
  active: boolean
  /** the JMP number, +15551234567 */
  tel: string | null
  balance: Money | null
  /** included calling credit left this month */
  includedCallingCredit: Money | null
  /** plan price, e.g. "$4.9900 / month" */
  renewal: Money | null
  /** USD or CAD */
  currency: string | null
  /** next renewal, YYYY-MM-DD */
  expiresAt: string | null
  autoTopUp: boolean | null
  /** the raw form, for fields this library does not map */
  form: DataForm
}

export interface Transaction {
  amount: Money | null
  note: string
  createdAt: Date | null
}

export interface CallRecord {
  start: Date | null
  /** inbound / outbound */
  direction: string
  tel: string
  /** answered, busy, ... */
  status: string
  duration: string
  rate: Money | null
  charge: Money | null
}

export interface ReferralCode {
  /** reusable code: a friend gets a month after paying, you get a month once their payment clears */
  code: string | null
  /** single-use invite codes, each worth a free month; empty when JMP lists none */
  invites: string[]
  /** JMP's explanation of what the codes give (notes and form instructions) */
  text: string
}

function date(value: string | undefined): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function yesNo(value: string | null): boolean | null {
  if (value === null) return null
  if (/^(yes|true|1|on)$/i.test(value)) return true
  if (/^(no|false|0|off)$/i.test(value)) return false
  return null
}

/** account status, history and referrals (`info`, `transactions`, `cdrs`, `referral codes`) */
export class Account {
  constructor(private readonly jmp: JmpClient) {}

  /** status, number, balance, renewal date; null when this JID has no JMP account */
  async info(): Promise<AccountInfo | null> {
    const { form } = await this.jmp.runCommand('info')
    if (!form) return null

    const status = fieldValue(form, 'account_status')
    const tel = fieldValue(form, 'tel')
    if (!status && !tel) return null

    return {
      status,
      active: status?.toLowerCase() === 'active',
      tel,
      balance: parseMoney(fieldValue(form, 'balance')),
      includedCallingCredit: parseMoney(fieldValue(form, 'remaining_included_calling_credit')),
      renewal: parseMoney(fieldValue(form, 'renewal')),
      currency: fieldValue(form, 'currency'),
      expiresAt: fieldValue(form, 'expires_at'),
      autoTopUp: yesNo(fieldValue(form, 'auto_top_up') ?? fieldValue(form, 'Auto Top-up')),
      form
    }
  }

  /** true when this JID has a JMP number */
  async isRegistered(): Promise<boolean> {
    return (await this.info()) !== null
  }

  async transactions(): Promise<Transaction[]> {
    const { form } = await this.jmp.runCommand('transactions')
    return formRows(form).map(row => ({
      amount: parseMoney(row.formatted_amount),
      note: row.note ?? '',
      createdAt: date(row.created_at)
    }))
  }

  /** call history */
  async calls(): Promise<CallRecord[]> {
    const { form } = await this.jmp.runCommand('cdrs')
    return formRows(form).map(row => ({
      start: date(row.start),
      direction: row.direction ?? '',
      tel: row.tel ?? '',
      status: row.disposition ?? '',
      duration: row.duration ?? '',
      rate: parseMoney(row.formatted_rate),
      charge: parseMoney(row.formatted_charge)
    }))
  }

  /**
   * your code that gives a friend a free month (and you credit once they pay), plus single-use invites.
   * JMP answers either with a note only, or with a result form: the same text as instructions
   * and an "Invite Code" table
   */
  async referralCode(): Promise<ReferralCode> {
    const step = await this.jmp.runCommand('referral codes')
    const text = [...step.notes.map(n => n.text), step.form?.instructions ?? '']
      .map(t => t.trim())
      .filter(Boolean)
      .join('\n\n')
    const code = text.match(/pay:\s*([A-Z0-9]{4,})/)?.[1] ?? text.match(/:\s*([A-Z0-9]{4,})\s*$/m)?.[1] ?? null
    const invites = formRows(step.form)
      .map(row => (row.code ?? Object.values(row)[0] ?? '').trim())
      .filter(Boolean)
    return { code, invites, text }
  }
}
