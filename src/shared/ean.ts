// Códigos EAN. Los internos usan el prefijo 20 (GS1 lo reserva para uso dentro de la tienda: no choca
// con códigos de fabricantes) + 10 dígitos de secuencia + dígito verificador.

// Dígito verificador EAN-8 / EAN-13 / UPC-A: pesos 3 y 1 alternados desde la derecha
export function eanCheckDigit(body: string): number {
  let sum = 0
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i])
    sum += i % 2 === 0 ? digit * 3 : digit
  }
  return (10 - (sum % 10)) % 10
}

export const isValidEan = (code: string) =>
  /^(\d{8}|\d{12}|\d{13})$/.test(code) && eanCheckDigit(code.slice(0, -1)) === Number(code.at(-1))

export const INTERNAL_PREFIX = "20"

export function internalEan(sequence: number): string {
  const body = INTERNAL_PREFIX + String(sequence).padStart(10, "0")
  return body + eanCheckDigit(body)
}
