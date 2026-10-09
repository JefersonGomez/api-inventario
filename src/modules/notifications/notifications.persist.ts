// Avisos guardados (eventos dirigidos a un usuario). Archivo aparte de notifications.service.ts
// para que los servicios de solicitudes/órdenes puedan crearlos sin un import circular.
import { prisma } from "../../config/database.ts";
import type { Prisma } from "../../generated/prisma/client.ts";

export type NewNotification = {
  userId: string;
  type: string;
  title: string;
  link: string;
  meta?: Prisma.InputJsonValue;
};

// Pasar `tx` cuando se llama dentro de una transacción: el aviso queda atómico con el cambio que lo origina.
export async function createNotifications(
  items: NewNotification[],
  client: Prisma.TransactionClient | typeof prisma = prisma
) {
  if (items.length === 0) return;
  await client.notification.createMany({
    data: items.map(({ meta, ...rest }) => ({ ...rest, ...(meta !== undefined && { meta }) })),
  });
}

// ponytail: tope fijo de 30, sin paginación ni purga; añadir cuando haya usuarios con muchos avisos
export function getUserNotifications(userId: string) {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
}

// `userId` en el where: nadie puede marcar como leído el aviso de otro usuario
export async function markAsRead(userId: string, id: string) {
  const { count } = await prisma.notification.updateMany({
    where: { id, userId, readAt: null },
    data: { readAt: new Date() },
  });
  return count;
}

export async function markAllAsRead(userId: string) {
  const { count } = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return count;
}
