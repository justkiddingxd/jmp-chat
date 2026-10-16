export interface Money {
  amount: number
  /** as JMP printed it, e.g. "$4.9900 / month" */
  text: string
}

/** "$4.9900 / month" → { amount: 4.99, text }, "-$1.50" → -1.5; null when there is no number */
export function parseMoney(text: string | null | undefined): Money | null {
  if (!text) return null
  const m = text.replace(/,/g, '').match(/(-?)\D{0,3}?(-?)(\d+(?:\.\d+)?)/)
  if (!m) return null
  const amount = Number(m[3]) * (m[1] || m[2] ? -1 : 1)
  return Number.isFinite(amount) ? { amount, text: text.trim() } : null
}
