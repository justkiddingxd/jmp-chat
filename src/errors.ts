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
    const detail = e.text || e.condition || e.message || describeError(error)
    return new JmpError(`${context}: ${detail}`, e.condition, { cause: error })
  }
}

interface ErrorLike {
  name?: string
  message?: string
  code?: string
  errors?: unknown[]
}

/**
 * describes an error that has no message of its own: the AggregateError from net.connect
 * (one member per IPv6/IPv4 address) or a bare xmpp.js error, so the reason isn't lost
 */
export function describeError(error: unknown, depth = 0): string {
  if (!error || typeof error !== 'object') return String(error)
  const e = error as ErrorLike
  const parts = e.message
    ? [e.code && !e.message.includes(e.code) ? e.code : null, e.message]
    : [e.name, e.code]
  let text = parts.filter(Boolean).join(' ') || String(error)
  if (depth < 2 && Array.isArray(e.errors) && e.errors.length > 0) {
    text += ` [${e.errors.map(inner => describeError(inner, depth + 1)).join('; ')}]`
  }
  return text
}

/** turns a failed JmpClient.connect() into a JmpError that says what went wrong */
export function loginError(error: unknown, jid: string, domain: string): JmpError {
  if (error instanceof JmpError) return error
  const e = error as { name?: string, message?: string, condition?: string }
  if (e?.name === 'SASLError') return new JmpError('wrong JID or password', e.condition ?? 'not-authorized', { cause: error })
  // xmpp.js times out the stream header and each login step without a message
  if (e?.name === 'TimeoutError' && !e.message) {
    return new JmpError(`${domain} did not answer in time`, 'remote-server-timeout', { cause: error })
  }
  return JmpError.from(error, `could not log in as ${jid}`)
}

/** an ad-hoc command finished with an error note, e.g. a rejected promo code */
export class JmpCommandError extends JmpError {
  override name = 'JmpCommandError'

  constructor(readonly node: string, readonly notes: CommandNote[], readonly step: CommandStep) {
    super(notes.map(n => n.text).join('\n') || `command "${node}" failed`)
  }
}
