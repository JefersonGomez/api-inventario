// company.service.ts — datos de la empresa de esta instalación (fila única id = 1)
import { prisma } from "../../config/database.ts";
import { logAudit } from "../audit/audit.service.ts";

export async function getCompany() {
  return (await prisma.company.findUnique({ where: { id: 1 } })) ?? { id: 1, name: null, updatedAt: null };
}

export async function updateCompany(name: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    const company = await tx.company.upsert({ where: { id: 1 }, create: { name }, update: { name } });
    await logAudit(userId, "UPDATE", "Company", "1", { name }, tx);
    return company;
  });
}
