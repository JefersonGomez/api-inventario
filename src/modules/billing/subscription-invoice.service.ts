// Factura electrónica de Cubivo por cada pago de suscripción (C6; decisión del usuario del 22-nov: las
// suscripciones se facturan CON Cubivo). La emite la empresa de la plataforma dentro del propio sistema
// (PLATFORM_COMPANY_ID: los datos fiscales y la llave de Hacienda del dueño de Cubivo) y sale por el mismo
// motor de facturación de siempre: se firma, va a Hacienda y, al aceptarse, le llega al cliente por correo.
// - Cliente con cédula en sus datos fiscales → FACTURA a su nombre; sin cédula → TIQUETE (con su correo).
// - Una línea de servicio: "Suscripción Cubivo plan X …", CABYS de software en línea (PLATFORM_CABYS), IVA 13 %
//   incluido en el precio, pagada con tarjeta o SINPE (referencia: el cobro de ONVO).
// - Sin PLATFORM_COMPANY_ID no hace nada. Si falla, queda el motivo y la revisión de cada hora reintenta (5 veces).
import { prismaRoot } from "../../config/database.ts";
import { prisma } from "../../config/database.ts";
import { runWithCompany } from "../../shared/tenant.ts";
import { issueDocument } from "../documents/document.service.ts";
import { queueEInvoice } from "../einvoice/einvoice.service.ts";

export const platformCompanyId = () => process.env.PLATFORM_COMPANY_ID?.trim() || null;
// "Servicios de programas informáticos (software) en línea (on-line), n.c.p." (13 %). Confirmar con el contador.
export const platformCabys = () => process.env.PLATFORM_CABYS?.trim() || "8439200000000";
// numeración propia de las suscripciones (no choca con cajas 00001… ni con la oficina 99999)
const SUBSCRIPTION_TERMINAL = "99998";
const MAX_ATTEMPTS = 5;

const PLAN = { INVOICING: "Solo facturación", BASIC: "Básico", PRO: "Pro", BUSINESS: "Empresarial" } as const;
const day = (d: Date) => d.toLocaleDateString("es-CR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Costa_Rica" });

export async function invoiceSubscriptionPayment(paymentId: string) {
  const issuerId = platformCompanyId();
  if (!issuerId) return null;
  // la toma una sola vez (la vuelta del 3DS, el webhook y la revisión de cada hora pueden coincidir)
  const claimed = await prismaRoot.subscriptionPayment.updateMany({
    where: {
      id: paymentId, status: "SUCCEEDED", documentId: null, invoiceAttempts: { lt: MAX_ATTEMPTS },
      OR: [{ invoicingAt: null }, { invoicingAt: { lt: new Date(Date.now() - 10 * 60_000) } }],
    },
    data: { invoicingAt: new Date(), invoiceAttempts: { increment: 1 } },
  });
  if (!claimed.count) return null;

  try {
    const payment = await prismaRoot.subscriptionPayment.findUniqueOrThrow({
      where: { id: paymentId },
      include: {
        subscription: {
          select: {
            user: {
              select: {
                name: true, email: true,
                ownedCompanies: {
                  orderBy: { createdAt: "asc" }, take: 1,
                  select: { name: true, legalName: true, idType: true, idNumber: true, invoiceEmail: true },
                },
              },
            },
          },
        },
      },
    });
    const issuer = await prismaRoot.company.findUnique({ where: { id: issuerId }, select: { ownerId: true } });
    if (!issuer) throw new Error("PLATFORM_COMPANY_ID no corresponde a ninguna empresa");
    const owner = payment.subscription.user;
    const client = owner.ownedCompanies[0];
    const email = client?.invoiceEmail?.trim() || owner.email;
    const hasId = !!(client?.idType && client.idNumber);
    const name = (client?.legalName || client?.name || owner.name).trim();

    const documentId = await runWithCompany(issuerId, async () => {
      // el cliente en la empresa de Cubivo: por su cédula o, sin cédula, por su correo
      let customer = hasId
        ? await prisma.customer.findFirst({ where: { idNumber: client!.idNumber!, deletedAt: null } })
        : await prisma.customer.findFirst({ where: { email, idNumber: null, deletedAt: null } });
      if (!customer) {
        customer = await prisma.customer.create({
          data: {
            companyId: issuerId, name: name.slice(0, 120), email,
            ...(hasId && { idType: client!.idType!, idNumber: client!.idNumber! }),
          },
        });
      } else if (customer.email !== email || customer.name !== name) {
        customer = await prisma.customer.update({ where: { id: customer.id }, data: { email, name: name.slice(0, 120) } });
      }
      const location = await prisma.location.findFirst({ where: { type: "BRANCH", isActive: true, code: { not: null } }, orderBy: { createdAt: "asc" }, select: { code: true } });
      const what = payment.kind === "UPGRADE"
        ? `Cambio a plan ${PLAN[payment.plan]} de Cubivo`
        : `Suscripción Cubivo plan ${PLAN[payment.plan]} ${payment.interval === "ANNUAL" ? "anual" : "mensual"}`;
      const period = payment.periodStart && payment.periodEnd ? ` (${day(payment.periodStart)} al ${day(payment.periodEnd)})` : "";
      const doc = await issueDocument(
        {
          type: hasId ? "INVOICE" : "TICKET",
          customerId: customer.id,
          lines: [{ description: `${what}${period}`.slice(0, 200), quantity: 1, unitPriceWithTax: payment.amount, taxRate: "RATE_13", cabys: platformCabys() }],
          payments: [{ method: payment.method === "SINPE" ? "SINPE" : "CARD", amount: payment.amount, reference: payment.onvoIntentId?.slice(0, 60) ?? null }],
          branchCode: location?.code ?? "001",
          terminalCode: SUBSCRIPTION_TERMINAL,
          notes: "Pago con ONVO Pay",
        },
        issuer.ownerId,
      );
      queueEInvoice(doc.id); // a Hacienda y, al aceptarse, por correo al cliente
      return doc.id;
    });
    await prismaRoot.subscriptionPayment.update({ where: { id: paymentId }, data: { documentId, invoiceError: null, invoicingAt: null } });
    return documentId;
  } catch (err) {
    await prismaRoot.subscriptionPayment.update({
      where: { id: paymentId },
      data: { invoiceError: (err as Error).message.slice(0, 300), invoicingAt: null },
    });
    throw err;
  }
}

// La revisión de cada hora: pagos confirmados de los últimos 30 días sin factura (con reintentos)
export async function invoicePendingPayments(limit = 20) {
  if (!platformCompanyId()) return;
  const rows = await prismaRoot.subscriptionPayment.findMany({
    where: { status: "SUCCEEDED", documentId: null, invoiceAttempts: { lt: MAX_ATTEMPTS }, paidAt: { gt: new Date(Date.now() - 30 * 86_400_000) } },
    select: { id: true },
    take: limit,
  });
  for (const r of rows) await invoiceSubscriptionPayment(r.id).catch((e) => console.error("factura de suscripción:", (e as Error).message));
}
