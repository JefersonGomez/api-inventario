import { z } from "zod"
import type { TaxRate, UnitOfMeasure } from "../generated/prisma/enums.ts"

// Cantidades: hasta 3 decimales (gramos en kg, mililitros en litros). Los productos por UNIDAD
// solo aceptan enteros; eso depende del producto, así que lo valida el service (assertQuantityForUnit).
const hasMax3Decimals = (v: number) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6

export const quantitySchema = z.number().positive().refine(hasMax3Decimals, "Máximo 3 decimales")
export const stockSchema = z.number().nonnegative().refine(hasMax3Decimals, "Máximo 3 decimales")

export function assertQuantityForUnit(qty: number, unit: UnitOfMeasure, label = "La cantidad") {
  if (unit === "UNIT" && !Number.isInteger(qty)) {
    throw new Error(`${label} debe ser un número entero: el producto se maneja por unidad`)
  }
}

// Redondeo a 3 decimales para no arrastrar errores de punto flotante al guardar
export const roundQty = (v: number) => Math.round(v * 1000) / 1000

// Abreviatura para textos que salen del backend (correo al proveedor)
const UNIT_LABEL: Record<UnitOfMeasure, string> = {
  UNIT: "unid.", KG: "kg", G: "g", L: "L", ML: "mL", M: "m", CM: "cm", M2: "m²",
}
export const formatQuantity = (qty: number, unit: UnitOfMeasure) =>
  `${qty.toLocaleString("es-CR", { maximumFractionDigits: 3 })} ${UNIT_LABEL[unit]}`

// Texto libre de una planilla → unidad / tarifa de IVA (importación desde Excel). null = no reconocido.
const fold = (v: string) => v.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[\s.²]/g, (c) => (c === "²" ? "2" : ""))
const UNIT_ALIASES: Record<string, UnitOfMeasure> = {
  u: "UNIT", un: "UNIT", und: "UNIT", unid: "UNIT", unidad: "UNIT", unidades: "UNIT", pza: "UNIT", pieza: "UNIT", unit: "UNIT",
  kg: "KG", kgs: "KG", kilo: "KG", kilos: "KG", kilogramo: "KG", kilogramos: "KG",
  g: "G", gr: "G", grs: "G", gramo: "G", gramos: "G",
  l: "L", lt: "L", lts: "L", litro: "L", litros: "L",
  ml: "ML", mililitro: "ML", mililitros: "ML",
  m: "M", mt: "M", mts: "M", metro: "M", metros: "M",
  cm: "CM", centimetro: "CM", centimetros: "CM",
  m2: "M2", metrocuadrado: "M2", metroscuadrados: "M2",
}
export function parseUnit(raw: string): UnitOfMeasure | null {
  return UNIT_ALIASES[fold(raw)] ?? null
}

export function parseTaxRate(raw: string): TaxRate | null {
  const v = raw.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[s%]/g, "").replace(",", ".")
  if (["exento", "exenta", "e", "0", "no"].includes(v)) return "EXEMPT"
  const n = Number(v)
  const pct = n > 0 && n < 1 ? Math.round(n * 100) : n // 0.13 → 13
  return ({ 1: "RATE_1", 2: "RATE_2", 4: "RATE_4", 13: "RATE_13" } as Record<number, TaxRate>)[pct] ?? null
}
