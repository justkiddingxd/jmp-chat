import type { CommandNote, CommandStep } from './commands.ts'

/** any failure talking to JMP; `condition` is the XMPP error condition when there is one */
export class JmpError extends Error {
  override name = 'JmpError'

  constructor(message: string, readonly condition?: string, options?: ErrorOptions) {
    super(message, options)
  }

  /** wraps an iq error from @xmpp/client into a JmpError */
  static from(error: unknown, context: string): JmpError {
    if (error instanceof JmpError) return error
    const e = error as { condition?: string, text?: string, message?: string }
    const detail = e.text || e.condition || e.message || String(error)
    return new JmpError(`${context}: ${detail}`, e.condition, { cause: error })
  }
}

/** an ad-hoc command finished with an error note, e.g. a rejected promo code */
export class JmpCommandError extends JmpError {
  override name = 'JmpCommandError'

  constructor(readonly node: string, readonly notes: CommandNote[], readonly step: CommandStep) {
    super(notes.map(n => n.text).join('\n') || `command "${node}" failed`)
  }
}
