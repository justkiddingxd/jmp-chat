import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/xml'
import type { XmppConnection } from './connection.ts'
import { JmpCommandError, JmpError } from './errors.ts'
import { parseForm, submitForm, type DataForm, type FormValues } from './forms.ts'

// XEP-0050 ad-hoc commands: every JMP account feature is one of these on the gateway

export const NS_COMMANDS = 'http://jabber.org/protocol/commands'
/** JMP puts extra choices ("Add new Bitcoin address", "Search") into this form field */
export const ACTIONS_FIELD = 'http://jabber.org/protocol/commands#actions'
const NS_OOB = 'jabber:x:oob'
const NS_DISCO_ITEMS = 'http://jabber.org/protocol/disco#items'

export const DEFAULT_COMMAND_TIMEOUT = 90_000

export type CommandStatus = 'executing' | 'completed' | 'canceled'

export interface CommandNote {
  /** info | warn | error */
  type: string
  text: string
}

export interface CommandLink {
  url: string
  desc: string
}

/** one response of an ad-hoc command */
export interface CommandStep {
  node: string
  sessionId: string
  status: CommandStatus
  /** allowed actions: next / prev / complete */
  actions: string[]
  /** the action <actions execute="..."> points at */
  defaultAction: string | null
  notes: CommandNote[]
  form?: DataForm
  /** XEP-0066 links, e.g. the payment page */
  links: CommandLink[]
}

export interface CommandInfo {
  node: string
  name: string
}

export function parseCommand(command: Element, fallback: { node: string, sessionId?: string }): CommandStep {
  const actions = command.getChild('actions')
  const x = command.getChild('x', 'jabber:x:data')
  return {
    node: command.attrs.node ?? fallback.node,
    sessionId: command.attrs.sessionid ?? fallback.sessionId ?? '',
    status: (command.attrs.status ?? 'completed') as CommandStatus,
    actions: actions ? actions.children.filter((c): c is Element => typeof c !== 'string').map(c => c.name) : [],
    defaultAction: actions?.attrs.execute ?? null,
    notes: command.getChildren('note').map(n => ({ type: n.attrs.type ?? 'info', text: n.getText() })),
    form: x ? parseForm(x) : undefined,
    links: command.getChildren('x', NS_OOB).map(o => ({ url: o.getChildText('url') ?? '', desc: o.getChildText('desc') ?? '' }))
  }
}

/** all urls a step mentions: XEP-0066 links first, then urls inside notes */
export function stepUrls(step: CommandStep): string[] {
  const fromNotes = step.notes.flatMap(n => n.text.match(/https?:\/\/\S+/g) ?? [])
  return [...new Set([...step.links.map(l => l.url).filter(Boolean), ...fromNotes])]
}

export async function listCommands(conn: XmppConnection, to: string): Promise<CommandInfo[]> {
  try {
    const response = await conn.iqCaller.request(
      xml('iq', { type: 'get', to }, xml('query', { xmlns: NS_DISCO_ITEMS, node: NS_COMMANDS })),
      30_000
    )
    return (response.getChild('query')?.getChildren('item') ?? [])
      .map(item => ({ node: item.attrs.node ?? '', name: item.attrs.name ?? item.attrs.node ?? '' }))
      .filter(c => c.node)
  } catch (error) {
    throw JmpError.from(error, 'listing commands failed')
  }
}

export interface SubmitOptions {
  /** execute (default), next, prev, complete */
  action?: string
  /** extra elements to put inside the submitted <x>, e.g. an RSM <set> */
  extra?: Element[]
}

/**
 * a running ad-hoc command. `step` is the latest response.
 * sessions left in `executing` should be `cancel()`ed — JMP keeps them alive otherwise
 */
export class CommandSession {
  private constructor(
    private readonly conn: XmppConnection,
    readonly to: string,
    readonly node: string,
    public step: CommandStep,
    private readonly timeout: number
  ) {}

  static async start(conn: XmppConnection, to: string, node: string, timeout = DEFAULT_COMMAND_TIMEOUT): Promise<CommandSession> {
    const step = await request(conn, to, node, { action: 'execute' }, timeout)
    return new CommandSession(conn, to, node, step, timeout)
  }

  get executing(): boolean {
    return this.step.status === 'executing'
  }

  get form(): DataForm | undefined {
    return this.step.form
  }

  /** submits the current form (values merged over its defaults) or just advances when there is no form */
  async submit(values: FormValues = {}, opts: SubmitOptions = {}): Promise<CommandStep> {
    if (!this.executing) throw new JmpError(`command "${this.node}" is already ${this.step.status}`)
    const form = this.step.form?.type === 'form' ? submitForm(this.step.form, values, opts.extra) : undefined
    this.step = await request(this.conn, this.to, this.node, {
      sessionId: this.step.sessionId,
      action: opts.action ?? 'execute',
      form
    }, this.timeout)
    return this.step
  }

  next(values?: FormValues): Promise<CommandStep> {
    return this.submit(values, { action: 'next' })
  }

  complete(values?: FormValues): Promise<CommandStep> {
    return this.submit(values, { action: 'complete' })
  }

  async prev(): Promise<CommandStep> {
    if (!this.executing) throw new JmpError(`command "${this.node}" is already ${this.step.status}`)
    this.step = await request(this.conn, this.to, this.node, { sessionId: this.step.sessionId, action: 'prev' }, this.timeout)
    return this.step
  }

  /** cancels the session if it is still running; never throws */
  async cancel(): Promise<void> {
    if (!this.executing) return
    const { sessionId } = this.step
    this.step = { ...this.step, status: 'canceled' }
    await request(this.conn, this.to, this.node, { sessionId, action: 'cancel' }, 15_000).catch(() => {})
  }

  /** throws JmpCommandError when the latest step carries an error note */
  assertOk(): CommandStep {
    if (this.step.notes.some(n => n.type === 'error')) throw new JmpCommandError(this.node, this.step.notes, this.step)
    return this.step
  }
}

async function request(
  conn: XmppConnection,
  to: string,
  node: string,
  opts: { sessionId?: string, action: string, form?: Element },
  timeout: number
): Promise<CommandStep> {
  const attrs: Record<string, string> = { xmlns: NS_COMMANDS, node, action: opts.action }
  if (opts.sessionId) attrs.sessionid = opts.sessionId

  let response: Element
  try {
    response = await conn.iqCaller.request(
      xml('iq', { type: 'set', to }, xml('command', attrs, ...(opts.form ? [opts.form] : []))),
      timeout
    )
  } catch (error) {
    throw JmpError.from(error, `command "${node}" failed`)
  }

  const command = response.getChild('command', NS_COMMANDS)
  if (!command) throw new JmpError(`command "${node}": empty response`)
  return parseCommand(command, { node, sessionId: opts.sessionId })
}
