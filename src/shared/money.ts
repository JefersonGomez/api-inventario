// Formato de montos para textos generados en el servidor (correos). En pantalla lo hace el frontend.
export type Currency = "CRC" | "USD";

export function formatMoney(value: number, currency: Currency) {
  return new Intl.NumberFormat("es-CR", {
    style: "currency",
    currencyDisplay: "narrowSymbol",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}
