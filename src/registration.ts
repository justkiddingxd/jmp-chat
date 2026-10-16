import { xml } from '@xmpp/client'
import type { JmpClient } from './client.ts'
import { ACTIONS_FIELD, CommandSession, stepUrls, type CommandStep } from './commands.ts'
import { JmpCommandError, JmpError } from './errors.ts'
import type { FormOption, FormValues } from './forms.ts'

// signup is the `jabber:iq:register` command on the gateway:
//   gateway choice (jmp.chat) → search → pick a number → fair use note → activation → done
// steps the library recognises are exposed as methods; anything else stays reachable via submit()

export const REGISTER_NODE = 'jabber:iq:register'
const RSM = 'http://jabber.org/protocol/rsm'

export type RegistrationStage =
  | 'search'
  | 'choose'
  | 'activate'
  | 'done'
  | 'canceled'
  /** a form this library does not know: inspect `step.form` and call `submit()` */
  | 'unknown'

export interface AvailableNumber {
  /** +15551234567, what you pass to choose() */
  tel: string
  /** the label as JMP shows it: "(512) 555-0101 (AUSTIN, TX)" */
  label: string
  /** "(512) 555-0101" */
  phone: string
  /** "Austin, TX" */
  location: string | null
}

export interface RegistrationResult {
  tel: string | null
  location: string | null
  notes: string[]
}

/** "(325) 999-6404 (ABILENE, TX)" → { phone: "(325) 999-6404", location: "Abilene, TX" } */
export function splitNumberLabel(label: string): { phone: string, location: string | null } {
  const m = label.match(/^(.*?\d{4})\s*\((.+)\)\s*$/)
  if (!m) return { phone: label, location: null }
  const location = m[2]!
    .toLowerCase()
    .replace(/(^|[\s-])\p{L}/gu, s => s.toUpperCase())
    .replace(/, (\p{L}{2})$/u, (_, st: string) => `, ${st.toUpperCase()}`)
  return { phone: m[1]!, location }
}

/**
 * signing a JID up for a JMP number, one call per step:
 *
 *   const reg = await jmp.register()
 *   const numbers = await reg.search('512')
 *   await reg.choose(numbers[0].tel)
 *   const { tel } = await reg.activateWithCode('PROMOCODE')
 */
export class Registration {
  private chosen: AvailableNumber | null = null

  private constructor(readonly session: CommandSession, private readonly gatewayChoice: string) {}

  /** prefer `jmp.register()` */
  static async start(jmp: JmpClient, opts: { gatewayChoice?: string } = {}): Promise<Registration> {
    const reg = new Registration(await jmp.startCommand(REGISTER_NODE), opts.gatewayChoice ?? 'jmp.chat')
    await reg.settle()
    return reg
  }

  get step(): CommandStep {
    return this.session.step
  }

  get stage(): RegistrationStage {
    const step = this.session.step
    if (step.status === 'completed') return 'done'
    if (step.status === 'canceled') return 'canceled'
    const fields = step.form?.fields ?? []
    const has = (name: string) => fields.some(f => f.var === name)
    if (has('q')) return 'search'
    if (has('tel') && fields.find(f => f.var === 'tel')!.options.length > 0) return 'choose'
    if (has('activation_method') || has('code') || has('plan_name')) return 'activate'
    return 'unknown'
  }

  /** what JMP says on the current step, e.g. "No numbers found, try another search." */
  get message(): string {
    return this.session.step.form?.instructions ?? ''
  }

  /** numbers offered on the "choose" stage */
  get numbers(): AvailableNumber[] {
    if (this.stage !== 'choose') return []
    return (this.session.form?.fields.find(f => f.var === 'tel')?.options ?? []).map(o => ({
      tel: o.value,
      label: o.label,
      ...splitNumberLabel(o.label)
    }))
  }

  /** ways to pay on the "activate" stage: code, credit_card, bitcoin, ... */
  get activationMethods(): FormOption[] {
    return this.session.form?.fields.find(f => f.var === 'activation_method')?.options ?? []
  }

  /** plans (currencies) on the "activate" stage */
  get plans(): FormOption[] {
    return this.session.form?.fields.find(f => f.var === 'plan_name')?.options ?? []
  }

  private expect(stage: RegistrationStage) {
    if (this.stage !== stage) throw new JmpError(`registration is at "${this.stage}", not "${stage}"`)
  }

  /** answers steps that need no decision: the gateway choice and info-only notes */
  private async settle() {
    for (let i = 0; i < 5 && this.session.executing; i++) {
      this.session.assertOk()
      const form = this.session.form
      const gateway = form?.fields.find(f => f.var === 'gateway-jid')
      if (gateway) {
        const option = gateway.options.find(o => o.value === this.gatewayChoice)
        if (!option) throw new JmpError(`gateway ${this.gatewayChoice} is not offered`)
        await this.session.submit({ 'gateway-jid': option.value })
        continue
      }
      if (!form || form.type !== 'form') {
        await this.session.submit()
        continue
      }
      return
    }
    this.session.assertOk()
  }

  /**
   * searches numbers: an area code ("512"), a state or city ("TX", "Austin, TX"), a vanity pattern ("~777"),
   * or `{ any: true }` for whatever is available. resolves with [] when nothing matched (see `message`)
   */
  async search(query: string | { any: true }, opts: { limit?: number } = {}): Promise<AvailableNumber[]> {
    if (this.stage === 'choose') await this.backToSearch()
    this.expect('search')

    const actions = this.session.form?.fields.find(f => f.var === ACTIONS_FIELD)
    const values: FormValues = {}
    if (typeof query === 'string') {
      values.q = query
      if (actions) values[ACTIONS_FIELD] = 'next'
    } else {
      const any = actions?.options.find(o => /lucky|any|some/i.test(o.value) || /show me/i.test(o.label))
      if (!any) throw new JmpError('JMP offers no "show any numbers" search')
      values.q = ''
      values[ACTIONS_FIELD] = any.value
    }

    // JMP returns 10 numbers by default; RSM <max> asks for more (it caps at 500)
    const extra = [xml('set', { xmlns: RSM }, xml('max', {}, String(opts.limit ?? 50)))]
    await this.session.submit(values, { extra })
    await this.settle()
    return this.numbers
  }

  /** from the number list back to the search form */
  async backToSearch(): Promise<void> {
    this.expect('choose')
    await this.session.prev()
    await this.settle()
  }

  /** takes a number from the last search */
  async choose(tel: string): Promise<void> {
    this.expect('choose')
    const number = this.numbers.find(n => n.tel === tel)
    if (!number) throw new JmpError(`${tel} was not in the search results`)
    this.chosen = number
    await this.session.submit({ tel })
    await this.settle()
  }

  /**
   * activates with a referral / promo code: the account starts with the code's credit and needs no payment now.
   * `currency` picks the plan (USD or CAD)
   */
  async activateWithCode(code: string, opts: { currency?: string } = {}): Promise<RegistrationResult> {
    this.expect('activate')
    const fields = this.session.form?.fields ?? []

    const values: FormValues = { code }
    if (fields.some(f => f.var === 'activation_method')) {
      if (!this.activationMethods.some(o => o.value === 'code')) {
        throw new JmpError('this number cannot be activated with a code (premium number?)')
      }
      values.activation_method = 'code'
    }
    const plan = this.pickPlan(opts.currency)
    if (plan) values.plan_name = plan

    await this.session.submit(values)
    await this.settle()

    // asked again: the code was rejected or the plan needs something else
    if (this.stage === 'activate') {
      throw new JmpCommandError(REGISTER_NODE, [{ type: 'error', text: this.message || 'code rejected' }], this.step)
    }
    if (this.stage !== 'done') throw new JmpError(`unexpected registration step "${this.stage}"`)
    return this.result()
  }

  /**
   * activates with another method (credit_card, bitcoin, ...). JMP usually answers with a payment page,
   * see `urls`; the number is yours once the payment clears
   */
  async activate(method: string, opts: { currency?: string, values?: FormValues } = {}): Promise<{ urls: string[], step: CommandStep }> {
    this.expect('activate')
    if (!this.activationMethods.some(o => o.value === method)) throw new JmpError(`activation method "${method}" is not offered`)
    const plan = this.pickPlan(opts.currency)
    await this.session.submit({ activation_method: method, ...(plan ? { plan_name: plan } : {}), ...opts.values })
    const step = this.session.assertOk()
    return { urls: stepUrls(step), step }
  }

  /** answers an unknown step yourself; known steps after it are handled again */
  async submit(values: FormValues, action?: string): Promise<CommandStep> {
    await this.session.submit(values, { action })
    await this.settle()
    return this.step
  }

  result(): RegistrationResult {
    this.expect('done')
    const step = this.session.assertOk()
    const notes = step.notes.map(n => n.text)
    return {
      tel: this.chosen?.tel ?? notes.join('\n').match(/\+1\d{10}/)?.[0] ?? null,
      location: this.chosen?.location ?? null,
      notes
    }
  }

  cancel(): Promise<void> {
    return this.session.cancel()
  }

  private pickPlan(currency?: string): string | null {
    const plans = this.plans
    if (plans.length === 0) return null
    const wanted = currency?.toUpperCase()
    return (plans.find(p => p.value.toUpperCase() === wanted) ?? plans[0])!.value
  }
}
