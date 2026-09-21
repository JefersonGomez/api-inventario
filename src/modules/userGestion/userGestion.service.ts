import { prisma } from "../../config/database.js";
import { logAudit } from "../audit/audit.service.ts";

export async function getAllUsers() {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      avatarUrl: true,
      isActive: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return users;
}

export async function toggleUserActive(
  targetUserId: string,
  requestingUserId: string
) {
  if (targetUserId === requestingUserId) {
    throw new Error("No podés desactivar tu propia cuenta");
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
  });

  if (!targetUser) {
    throw new Error("Usuario no encontrado");
  }

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: { isActive: !targetUser.isActive },
  });

  const action = updated.isActive ? "ACTIVATE" : "DEACTIVATE";
  await logAudit(requestingUserId, action, "User", targetUserId, {
    previousState: targetUser.isActive,
    newState: updated.isActive,
  });

  return updated;
}