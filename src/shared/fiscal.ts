import { z } from "zod"

// Identificación fiscal de Costa Rica. Se guarda sin guiones ni espacios.
// Física 9 dígitos, jurídica y NITE 10, DIMEX 11 o 12; extranjero: documento del exterior (1–20).
export const ID_TYPES = ["FISICA", "JURIDICA", "DIMEX", "NITE", "EXTRANJERO"] as const
const ID_RULES: Record<(typeof ID_TYPES)[number], { re: RegExp; msg: string }> = {
  FISICA: { re: /^\d{9}$/, msg: "La cédula física tiene 9 dígitos" },
  JURIDICA: { re: /^\d{10}$/, msg: "La cédula jurídica tiene 10 dígitos" },
  DIMEX: { re: /^\d{11,12}$/, msg: "El DIMEX tiene 11 o 12 dígitos" },
  NITE: { re: /^\d{10}$/, msg: "El NITE tiene 10 dígitos" },
  EXTRANJERO: { re: /^[A-Za-z0-9]{1,20}$/, msg: "El documento extranjero tiene hasta 20 letras o números" },
}

export const normalizeIdNumber = (v: string) => v.replace(/[\s-]/g, "").toUpperCase()

// Campos { idType, idNumber } opcionales: van los dos o ninguno, y el número debe calzar con el tipo.
// Uso: z.object({...}).superRefine(checkFiscalId)
export const fiscalIdFields = {
  idType: z.enum(ID_TYPES).nullable().optional(),
  idNumber: z.string().trim().transform(normalizeIdNumber).nullable().optional(),
}

export function checkFiscalId(d: { idType?: string | null | undefined; idNumber?: string | null | undefined }, ctx: z.RefinementCtx) {
  const hasType = Boolean(d.idType)
  const hasNumber = Boolean(d.idNumber)
  if (hasType !== hasNumber) {
    ctx.addIssue({ code: "custom", path: [hasType ? "idNumber" : "idType"], message: "Indica el tipo y el número de identificación juntos" })
    return
  }
  if (hasType && hasNumber) {
    const rule = ID_RULES[d.idType as keyof typeof ID_RULES]
    if (!rule.re.test(d.idNumber!)) ctx.addIssue({ code: "custom", path: ["idNumber"], message: rule.msg })
  }
}

// Porcentaje de cada tarifa de IVA (el enum TaxRate del esquema)
export const TAX_PERCENT = { EXEMPT: 0, RATE_1: 1, RATE_2: 2, RATE_4: 4, RATE_13: 13 } as const

// Código de comprobante de Hacienda (va dentro del consecutivo de 20 dígitos)
export const DOCUMENT_CODE = { INVOICE: "01", DEBIT_NOTE: "02", CREDIT_NOTE: "03", TICKET: "04" } as const
