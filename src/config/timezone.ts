// Los días del negocio (ventas del día, cuotas que vencen, reportes, cierres) son de Costa Rica aunque
// el servidor esté en UTC (lo normal en una VPS). TZ en el .env la cambia si hace falta (otro país).
// Se importa primero en app.ts: Node toma el cambio de TZ en caliente.
process.env.TZ ||= "America/Costa_Rica"
