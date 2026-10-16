// phone numbers <-> gateway JIDs. cheogram addresses a number as +15551234567@cheogram.com
// and short codes (banks, 2FA services) as 22000;phone-context=ca-us.phone-context.soprani.ca@cheogram.com

export const DEFAULT_GATEWAY = 'cheogram.com'
export const SHORT_CODE_CONTEXT = 'phone-context=ca-us.phone-context.soprani.ca'

/**
 * turns what a person typed into the gateway JID for that number, or null if it is not a number.
 * accepts +15551234567, 5551234567, 1-555-123-4567, short codes like 22000, and +E.164 for other countries
 */
export function phoneToJid(input: string, gateway = DEFAULT_GATEWAY): string | null {
  const digits = input.replace(/[^\d+]/g, '')
  const plain = digits.replace(/^\+/, '')

  if (!digits.startsWith('+') && /^\d{3,6}$/.test(plain)) return `${plain};${SHORT_CODE_CONTEXT}@${gateway}`
  if (!digits.startsWith('+') && /^\d{10}$/.test(plain)) return `+1${plain}@${gateway}`
  if (/^1\d{10}$/.test(plain)) return `+${plain}@${gateway}`
  if (digits.startsWith('+') && /^\d{8,15}$/.test(plain)) return `+${plain}@${gateway}`
  return null
}

/** the phone number (or short code) behind a gateway JID; null for the gateway itself */
export function jidToPhone(jid: string): string | null {
  const at = jid.lastIndexOf('@')
  if (at <= 0) return null
  return jid.slice(0, at).split(';')[0]!.split('/')[0]! || null
}

/** +15551234567 → +1 (555) 123-4567; anything else is returned as is */
export function formatPhone(phone: string): string {
  const m = phone.match(/^\+1(\d{3})(\d{3})(\d{4})$/)
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : phone
}

/** pulls a verification code out of an SMS: "G-123456", "123-456", "code: 4821" */
export function extractOtp(text: string): string | null {
  const split = text.match(/(?<![\d+])(\d{3})[- ](\d{3})(?!\d)/)
  if (split) return split[1]! + split[2]!

  const plain = text.match(/(?<![\d+])\d{4,8}(?!\d)/)
  return plain?.[0] ?? null
}
