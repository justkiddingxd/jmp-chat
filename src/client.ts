import { EventEmitter } from 'node:events'
import { client, jid as parseJid, xml, type Client } from '@xmpp/client'
import type { Element } from '@xmpp/xml'
import { Account } from './account.ts'
import { CommandSession, listCommands, type CommandInfo, type CommandStep, DEFAULT_COMMAND_TIMEOUT } from './commands.ts'
import type { XmppConnection } from './connection.ts'
import { JmpError, loginError } from './errors.ts'
import { DEFAULT_GATEWAY, extractOtp, jidToPhone, phoneToJid } from './phone.ts'
import { Registration } from './registration.ts'
import { Settings } from './settings.ts'
import { TopUp } from './topup.ts'

const NS_OOB = 'jabber:x:oob'
const NS_DELAY = 'urn:xmpp:delay'
const NS_RECEIPTS = 'urn:xmpp:receipts'
const NS_STANZAS = 'urn:ietf:params:xml:ns:xmpp-stanzas'

const DEFAULT_XMPP_TIMEOUT = 15_000

export interface Sms {
  /** stanza id, if the gateway set one */
  id: string | null
  /** the other side: +15551234567 or a short code like 22000 */
  from: string
  /** full gateway JID of the sender, use it to reply to short codes */
  fromJid: string
  /** text; empty for a picture-only MMS */
  body: string
  /** MMS attachments (XEP-0066 urls) */
  media: string[]
  /** verification code found in the text, if any */
  otp: string | null
  /** when the message was sent; older than now for messages stored while you were offline */
  receivedAt: Date
}

/** a message from the gateway itself (cheogram.com), not from a phone number */
export interface GatewayNotice {
  body: string
  receivedAt: Date
}

export interface SmsError {
  /** id of the message that failed, as returned by sendSms */
  id: string | null
  /** number the message was sent to */
  to: string | null
  /** XMPP error condition, e.g. service-unavailable */
  condition: string | null
  text: string
}

export interface Delivered {
  /** id of the message, as returned by sendSms */
  id: string
  to: string | null
}

export interface JmpEvents {
  sms: [Sms]
  smsError: [SmsError]
  delivered: [Delivered]
  notice: [GatewayNotice]
  online: []
  offline: []
  /** connection errors; only emitted when you listen for them */
  error: [Error]
}

export interface JmpOptions {
  /** the JMP gateway, cheogram.com unless you run your own */
  gateway?: string
  /** timeout for ad-hoc commands, ms */
  commandTimeout?: number
  /** approve presence subscriptions from the gateway (default true) */
  autoSubscribe?: boolean
}

export interface ConnectOptions extends JmpOptions {
  /** your JID, the one registered with JMP */
  jid: string
  password: string
  /** xmpp://host:port or xmpps://host:port; defaults to the JID's domain (SRV lookup) */
  service?: string
  /** XMPP resource, default "jmp-chat" */
  resource?: string
  /** how long to wait for login, ms (default 30s) */
  connectTimeout?: number
  /** how long @xmpp/client waits for the stream header and each login step, ms (default 15s; the library's own default of 2s is too short for many servers) */
  xmppTimeout?: number
}

export interface SendOptions {
  /** ask for a delivery receipt (XEP-0184), reported via the "delivered" event; default true */
  receipt?: boolean
}

/**
 * a JMP account seen through its JID.
 *
 * - `JmpClient.connect({ jid, password })` logs in and owns the connection
 * - `JmpClient.attach(xmppClient)` reuses a connection you already have
 */
export class JmpClient extends EventEmitter<JmpEvents> {
  readonly gateway: string
  readonly account: Account
  readonly settings: Settings
  readonly topUp: TopUp

  private readonly commandTimeout: number
  private readonly autoSubscribe: boolean
  private readonly listener = (stanza: Element) => this.onStanza(stanza)
  private readonly pending = new Map<string, string | null>()

  constructor(readonly connection: XmppConnection, opts: JmpOptions = {}, private readonly owned?: Client) {
    super()
    this.gateway = opts.gateway ?? DEFAULT_GATEWAY
    this.commandTimeout = opts.commandTimeout ?? DEFAULT_COMMAND_TIMEOUT
    this.autoSubscribe = opts.autoSubscribe ?? true
    this.account = new Account(this)
    this.settings = new Settings(this)
    this.topUp = new TopUp(this)
    connection.on('stanza', this.listener)
  }

  /** logs in with the JID and password and sends initial presence, so the server starts delivering messages */
  static async connect(opts: ConnectOptions): Promise<JmpClient> {
    const { local, domain } = parseJid(opts.jid)
    if (!local) throw new JmpError(`not a user JID: ${opts.jid}`)

    const xmpp = client({
      service: opts.service ?? domain,
      domain,
      username: local,
      password: opts.password,
      resource: opts.resource ?? 'jmp-chat',
      timeout: opts.xmppTimeout ?? DEFAULT_XMPP_TIMEOUT
    })
    const jmp = new JmpClient(xmpp, opts, xmpp)

    xmpp.on('error', (error: Error) => {
      if (jmp.listenerCount('error') > 0) jmp.emit('error', error)
    })
    xmpp.on('online', () => {
      // without available presence the server holds messages back
      xmpp.send(xml('presence')).catch(() => {})
      jmp.emit('online')
    })
    xmpp.on('offline', () => jmp.emit('offline'))

    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        xmpp.start(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new JmpError(`${domain} did not answer in time`, 'remote-server-timeout')), opts.connectTimeout ?? 30_000)
        })
      ])
    } catch (error) {
      await xmpp.stop().catch(() => {})
      jmp.detach()
      throw loginError(error, opts.jid, domain)
    } finally {
      clearTimeout(timer)
    }
    return jmp
  }

  /** works on top of a connection you manage; send presence yourself to receive messages */
  static attach(connection: XmppConnection, opts?: JmpOptions): JmpClient {
    return new JmpClient(connection, opts)
  }

  /** stops listening; closes the connection only if `connect()` opened it */
  async close(): Promise<void> {
    this.detach()
    await this.owned?.stop().catch(() => {})
  }

  private detach() {
    this.connection.removeListener('stanza', this.listener)
  }

  // ---------- messages ----------

  /** gateway JID for a number or short code; JIDs pass through */
  jidFor(to: string): string {
    if (to.includes('@')) return to
    const jid = phoneToJid(to, this.gateway)
    if (!jid) throw new JmpError(`not a phone number: ${to}`)
    return jid
  }

  /** sends a text message; returns the stanza id that "delivered" / "smsError" refer to */
  async sendSms(to: string, body: string, opts: SendOptions = {}): Promise<string> {
    return this.sendMessage(to, body, [], opts)
  }

  /** sends a picture (any public url) as MMS, optionally with a caption in a separate message */
  async sendMms(to: string, url: string, opts: SendOptions & { caption?: string } = {}): Promise<string> {
    const id = await this.sendMessage(to, url, [xml('x', { xmlns: NS_OOB }, xml('url', {}, url))], opts)
    if (opts.caption) await this.sendMessage(to, opts.caption, [], opts)
    return id
  }

  private async sendMessage(to: string, body: string, extra: Element[], opts: SendOptions): Promise<string> {
    const target = this.jidFor(to)
    const id = `jmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const children = [xml('body', {}, body), ...extra]
    if (opts.receipt ?? true) children.push(xml('request', { xmlns: NS_RECEIPTS }))

    this.pending.set(id, jidToPhone(target))
    // forget ids nobody will confirm
    if (this.pending.size > 1000) this.pending.delete(this.pending.keys().next().value!)

    try {
      await this.connection.send(xml('message', { to: target, type: 'chat', id }, ...children))
    } catch (error) {
      this.pending.delete(id)
      throw JmpError.from(error, `sending to ${to} failed`)
    }
    return id
  }

  private onStanza(stanza: Element) {
    const from = stanza.attrs.from as string | undefined
    if (!from) return
    const sender = parseJid(from)
    if (sender.domain !== this.gateway) return
    const bare = sender.bare().toString()

    if (stanza.is('presence')) {
      if (stanza.attrs.type === 'subscribe' && this.autoSubscribe) {
        this.connection.send(xml('presence', { to: bare, type: 'subscribed' })).catch(() => {})
      }
      return
    }
    if (!stanza.is('message')) return

    const id = (stanza.attrs.id as string | undefined) ?? null

    if (stanza.attrs.type === 'error') {
      const error = stanza.getChild('error')
      const condition = error?.children.find((c): c is Element => typeof c !== 'string' && c.attrs.xmlns === NS_STANZAS && c.name !== 'text')?.name ?? null
      this.emit('smsError', {
        id,
        to: jidToPhone(bare),
        condition,
        text: error?.getChildText('text', NS_STANZAS) ?? condition ?? 'unknown error'
      })
      if (id) this.pending.delete(id)
      return
    }

    const receipt = stanza.getChild('received', NS_RECEIPTS)
    if (receipt?.attrs.id) {
      const sentId = receipt.attrs.id as string
      this.emit('delivered', { id: sentId, to: this.pending.get(sentId) ?? jidToPhone(bare) })
      this.pending.delete(sentId)
    }

    const stamp = stanza.getChild('delay', NS_DELAY)?.attrs.stamp as string | undefined
    const receivedAt = stamp ? new Date(stamp) : new Date()
    const media = stanza.getChildren('x', NS_OOB).map(x => x.getChildText('url') ?? '').filter(Boolean)
    let body = stanza.getChildText('body') ?? ''
    // an MMS repeats the attachment url as its body
    if (media.includes(body.trim())) body = ''
    if (!body && media.length === 0) return

    if (!sender.local) {
      this.emit('notice', { body, receivedAt })
      return
    }

    this.emit('sms', {
      id,
      from: jidToPhone(bare) ?? bare,
      fromJid: bare,
      body,
      media,
      otp: body ? extractOtp(body) : null,
      receivedAt
    })
  }

  // ---------- commands ----------

  /** every ad-hoc command the gateway offers this account */
  listCommands(): Promise<CommandInfo[]> {
    return listCommands(this.connection, this.gateway)
  }

  /** starts any gateway command, for things this library does not wrap */
  startCommand(node: string): Promise<CommandSession> {
    return CommandSession.start(this.connection, this.gateway, node, this.commandTimeout)
  }

  /** runs a command that answers in one step (info, transactions, ...) and cancels it if it wanted more */
  async runCommand(node: string): Promise<CommandStep> {
    const session = await this.startCommand(node)
    try {
      return session.assertOk()
    } finally {
      await session.cancel()
    }
  }

  /** starts the number signup flow on this JID */
  register(): Promise<Registration> {
    return Registration.start(this)
  }
}
