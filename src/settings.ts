import type { JmpClient } from './client.ts'
import { JmpError } from './errors.ts'
import { fieldValue, type DataForm, type FormOption, type FormValues } from './forms.ts'

export interface PlanSettings {
  /** dollars of overage JMP may charge per month without asking; 0 = never */
  monthlyOverageLimit: number | null
  /** JMP's summary of what the plan includes */
  description: string
}

export interface CallSettings {
  voicemailEnabled: boolean | null
  /** seconds to ring before voicemail (one ring is ~5s) */
  ringSeconds: number | null
  voicemailTranscription: boolean | null
  /** where calls go: xmpp:, sip: or tel: URI */
  forwardTo: string | null
  /** the choices JMP suggests (your JID, your SIP account); any custom URI also works */
  forwardOptions: FormOption[]
  /** caller ID name (CNAM) */
  callerName: string | null
}

const bool = (value: string | null) => (value === null ? null : value === 'true' || value === '1')
const num = (value: string | null) => (value === null || Number.isNaN(Number(value)) ? null : Number(value))

/** account settings (`plan settings`, `configure calls`, `set-port-out-pin`) */
export class Settings {
  constructor(private readonly jmp: JmpClient) {}

  private async read(node: string): Promise<DataForm> {
    const session = await this.jmp.startCommand(node)
    try {
      session.assertOk()
      if (!session.form) throw new JmpError(`command "${node}" returned no form`)
      return session.form
    } finally {
      await session.cancel()
    }
  }

  private async write(node: string, values: FormValues): Promise<string[]> {
    const session = await this.jmp.startCommand(node)
    try {
      if (!session.form) throw new JmpError(`command "${node}" returned no form`)
      await session.submit(values)
      session.assertOk()
      // the same form again means JMP did not accept the values
      if (session.executing && session.form?.type === 'form') {
        throw new JmpError(`JMP did not accept the settings${session.form.instructions ? `: ${session.form.instructions}` : ''}`)
      }
      return session.step.notes.map(n => n.text)
    } finally {
      await session.cancel()
    }
  }

  async plan(): Promise<PlanSettings> {
    const form = await this.read('plan settings')
    return {
      monthlyOverageLimit: num(fieldValue(form, 'monthly_overage_limit')),
      description: form.instructions
    }
  }

  async setPlan(settings: { monthlyOverageLimit: number }): Promise<string[]> {
    return this.write('plan settings', { monthly_overage_limit: settings.monthlyOverageLimit })
  }

  async calls(): Promise<CallSettings> {
    const form = await this.read('configure calls')
    return {
      voicemailEnabled: bool(fieldValue(form, 'fwd[voicemail_enabled]')),
      ringSeconds: num(fieldValue(form, 'fwd[timeout]')),
      voicemailTranscription: bool(fieldValue(form, 'voicemail_transcription')),
      forwardTo: fieldValue(form, 'fwd[uri]'),
      forwardOptions: form.fields.find(f => f.var === 'fwd[uri]')?.options ?? [],
      callerName: fieldValue(form, 'lidb_name')
    }
  }

  /** changes only the settings you pass, the rest stay as they are */
  async setCalls(settings: Partial<Omit<CallSettings, 'forwardOptions'>>): Promise<string[]> {
    return this.write('configure calls', {
      'fwd[voicemail_enabled]': settings.voicemailEnabled ?? undefined,
      'fwd[timeout]': settings.ringSeconds ?? undefined,
      voicemail_transcription: settings.voicemailTranscription ?? undefined,
      'fwd[uri]': settings.forwardTo ?? undefined,
      lidb_name: settings.callerName === null ? ' ' : settings.callerName
    })
  }

  /** PIN another carrier will need to port your number out; 4-10 letters or digits */
  async setPortOutPin(pin: string): Promise<string[]> {
    if (!/^[A-Za-z0-9]{4,10}$/.test(pin)) throw new JmpError('port-out PIN must be 4-10 letters or digits')
    return this.write('set-port-out-pin', { pin, confirm_pin: pin })
  }
}
