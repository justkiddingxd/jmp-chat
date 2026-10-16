import type { Element } from '@xmpp/xml'

/**
 * the part of an @xmpp/client `Client` that jmp-chat uses.
 * any connected client works, so you can share one connection with the rest of your app
 */
export interface XmppConnection {
  iqCaller: { request(stanza: Element, timeout?: number): Promise<Element> }
  send(stanza: Element): Promise<unknown>
  on(event: 'stanza', listener: (stanza: Element) => void): unknown
  removeListener(event: 'stanza', listener: (stanza: Element) => void): unknown
}
