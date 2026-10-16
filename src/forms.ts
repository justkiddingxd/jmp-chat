import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/xml'

// XEP-0004 data forms, plus the datatype / regex bits of XEP-0122 that JMP uses

export const NS_DATA = 'jabber:x:data'

export type FormType = 'form' | 'submit' | 'cancel' | 'result'

export interface FormOption {
  label: string
  value: string
}

export interface FormField {
  /** empty for fields without a var (usually fixed text) */
  var: string
  type: string
  label: string
  desc: string
  required: boolean
  values: string[]
  options: FormOption[]
  /** XEP-0122 datatype, e.g. xs:dateTime */
  datatype?: string
  /** XEP-0122 <regex> */
  regex?: string
}

export interface DataForm {
  type: FormType
  title: string
  instructions: string
  fields: FormField[]
  /** table header (<reported>), used by results like the transaction history */
  reported: FormField[]
  /** table rows (<item>) */
  items: FormField[][]
}

/** a value to submit: string, several strings, number or boolean */
export type FieldValue = string | number | boolean | readonly string[]
export type FormValues = Record<string, FieldValue | undefined> | Map<string, FieldValue | undefined>

function parseField(f: Element): FormField {
  const validate = f.getChild('validate', 'http://jabber.org/protocol/xdata-validate')
  return {
    var: f.attrs.var ?? '',
    type: f.attrs.type ?? 'text-single',
    label: f.attrs.label ?? f.attrs.var ?? '',
    desc: f.getChildText('desc') ?? '',
    required: f.getChild('required') !== undefined,
    values: f.getChildren('value').map(v => v.getText()),
    options: f.getChildren('option').map(o => ({
      label: o.attrs.label ?? o.getChildText('value') ?? '',
      value: o.getChildText('value') ?? ''
    })),
    datatype: validate?.attrs.datatype,
    regex: f.getChildText('regex') ?? undefined
  }
}

export function parseForm(x: Element): DataForm {
  return {
    type: (x.attrs.type ?? 'form') as FormType,
    title: x.getChildText('title') ?? '',
    instructions: x.getChildren('instructions').map(i => i.getText()).join('\n'),
    fields: x.getChildren('field').map(parseField),
    reported: x.getChild('reported')?.getChildren('field').map(parseField) ?? [],
    items: x.getChildren('item').map(item => item.getChildren('field').map(parseField))
  }
}

/** first value of a field by var, or by label for fields without a var (JMP has some) */
export function fieldValue(form: DataForm | undefined, key: string): string | null {
  const field = form?.fields.find(f => f.var === key) ?? form?.fields.find(f => !f.var && f.label === key)
  const value = field?.values[0]?.trim()
  return value ? value : null
}

/** table rows of a result form as var → value */
export function formRows(form: DataForm | undefined): Record<string, string>[] {
  return (form?.items ?? []).map(item =>
    Object.fromEntries(item.map(f => [f.var, f.values.join('\n')]))
  )
}

function toStrings(value: FieldValue): string[] {
  if (typeof value === 'boolean') return [value ? 'true' : 'false']
  if (typeof value === 'number') return [String(value)]
  if (typeof value === 'string') return [value]
  return [...value]
}

/** builds a submit form: `values` override the form defaults; `extra` elements go inside <x> */
export function submitForm(form: DataForm, values: FormValues = {}, extra: Element[] = []): Element {
  const map = values instanceof Map ? values : new Map(Object.entries(values))
  const fields = form.fields
    .filter(f => f.var && f.type !== 'fixed')
    .map((f) => {
      const given = map.get(f.var)
      const vals = given === undefined ? f.values : toStrings(given)
      return xml('field', { var: f.var }, ...vals.map(v => xml('value', {}, v)))
    })

  // values for fields the form did not declare (e.g. the actions field) are sent too
  for (const [key, value] of map) {
    if (value === undefined || form.fields.some(f => f.var === key)) continue
    fields.push(xml('field', { var: key }, ...toStrings(value).map(v => xml('value', {}, v))))
  }

  return xml('x', { xmlns: NS_DATA, type: 'submit' }, ...fields, ...extra)
}
