// comment.service.ts
// Hilo de comentarios de una solicitud (quien la pidió + admins) o de una orden (solo admins).
// Sin edición ni borrado: el hilo es un registro de la conversación.
import { prisma } from "../../config/database.ts";
import { createNotifications } from "../notifications/notifications.persist.ts";

export type ThreadKind = "request" | "order";
type Viewer = { id: string; role: string };

const authorSelect = { select: { id: true, name: true, avatarUrl: true } };

// null si no existe o si el usuario no puede verlo (el empleado solo ve sus solicitudes; las órdenes son de admins)
async function findThread(kind: ThreadKind, id: string, user: Viewer) {
  if (kind === "request") {
    const r = await prisma.purchaseRequest.findUnique({ where: { id }, include: { product: true } });
    if (!r || (user.role !== "ADMIN" && r.requestedById !== user.id)) return null;
    return { title: r.product.name, ownerId: r.requestedById, link: `/purchase-requests?highlight=${id}&comments=1` };
  }
  if (user.role !== "ADMIN") return null;
  const o = await prisma.purchaseOrder.findUnique({ where: { id }, include: { supplier: true } });
  if (!o) return null;
  return { title: o.supplier.name, ownerId: null, link: `/purchase-orders?highlight=${id}&comments=1` };
}

const threadWhere = (kind: ThreadKind, id: string) =>
  kind === "request" ? { purchaseRequestId: id } : { purchaseOrderId: id };

export async function getComments(kind: ThreadKind, id: string, user: Viewer) {
  if (!(await findThread(kind, id, user))) return null;
  return prisma.comment.findMany({
    where: threadWhere(kind, id),
    include: { author: authorSelect },
    orderBy: { createdAt: "asc" },
  });
}

// Devuelve el comentario y a quiénes se avisó (para el socket), o null si no hay acceso.
export async function addComment(kind: ThreadKind, id: string, user: Viewer, body: string) {
  const thread = await findThread(kind, id, user);
  if (!thread) return null;

  // avisa a todos los que pueden ver el hilo menos al autor: admins activos + quien pidió la solicitud
  const admins = await prisma.user.findMany({ where: { role: "ADMIN", isActive: true }, select: { id: true } });
  const recipients = [...new Set([...admins.map((a) => a.id), ...(thread.ownerId ? [thread.ownerId] : [])])]
    .filter((uid) => uid !== user.id);

  const comment = await prisma.$transaction(async (tx) => {
    const created = await tx.comment.create({
      data: { authorId: user.id, body, ...threadWhere(kind, id) },
      include: { author: authorSelect },
    });
    await createNotifications(
      recipients.map((userId) => ({
        userId,
        type: kind === "request" ? "requestComment" : "orderComment",
        title: thread.title,
        // ponytail: el extracto se corta a 120 caracteres; el texto completo vive en el hilo
        meta: { author: created.author.name, excerpt: body.slice(0, 120) },
        link: thread.link,
      })),
      tx
    );
    return created;
  });

  return { comment, recipients };
}
