import { EventEmitter } from 'node:events'
import { parse } from 'ltx'
import type { Element } from '@xmpp/xml'
import { JmpClient } from '../src/index.ts'

const NS = 'http://jabber.org/protocol/commands'

export const el = (s: string) => parse(s) as unknown as Element

export interface CommandCall {
  node: string
  action: string
  sessionId?: string
  /** submitted values: var → values */
  values: Record<string, string[]>
  /** raw submitted <x>, if any */
  x?: Element
}

/** answers a command call with the inner <command .../> xml */
export type Responder = (call: CommandCall) => string

/** an in-memory XmppConnection: commands are answered by `responders`, sent stanzas are recorded */
export class FakeConnection extends EventEmitter {
  sent: Element[] = []
  calls: CommandCall[] = []
  commandList: { node: string, name: string }[] = []

  constructor(readonly responders: Record<string, Responder> = {}) {
    super()
  }

  iqCaller = {
    request: async (iq: Element): Promise<Element> => {
      const query = iq.getChild('query', 'http://jabber.org/protocol/disco#items')
      if (query) {
        return el(`<iq type="result"><query xmlns="http://jabber.org/protocol/disco#items" node="${NS}">${
          this.commandList.map(c => `<item jid="cheogram.com" node="${c.node}" name="${c.name}"/>`).join('')
        }</query></iq>`)
      }

      const command = iq.getChild('command', NS)!
      const x = command.getChild('x', 'jabber:x:data')
      const call: CommandCall = {
        node: command.attrs.node,
        action: command.attrs.action,
        sessionId: command.attrs.sessionid,
        values: Object.fromEntries((x?.getChildren('field') ?? []).map(f => [f.attrs.var, f.getChildren('value').map(v => v.getText())])),
        x
      }
      this.calls.push(call)
      if (call.action === 'cancel') return el(`<iq type="result"><command xmlns="${NS}" node="${call.node}" status="canceled"/></iq>`)

      const responder = this.responders[call.node]
      if (!responder) throw Object.assign(new Error('item-not-found'), { condition: 'item-not-found' })
      return el(`<iq type="result">${responder(call)}</iq>`)
    }
  }

  async send(stanza: Element) {
    this.sent.push(stanza)
  }

  /** delivers a stanza as if it came from the server */
  receive(xml: string) {
    this.emit('stanza', el(xml))
  }
}

export function fakeJmp(responders: Record<string, Responder> = {}) {
  const conn = new FakeConnection(responders)
  return { conn, jmp: JmpClient.attach(conn) }
}

/** wraps a form into a command response */
export const command = (node: string, status: string, inner: string, session = 's1') =>
  `<command xmlns="${NS}" node="${node}" sessionid="${session}" status="${status}">${inner}</command>`
