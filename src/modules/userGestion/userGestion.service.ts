import { prisma } from "../../config/database.js";

export async function getAllUsers() {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      avatarUrl: true,
      isActive: true,
      createAt: true,
    },
    orderBy: { createAt: "desc" },
  });

  return users;
}

export async function toggleUserActive(targetUserId: string, requestingUserId: string) {
  if (targetUserId === requestingUserId) {
    throw new Error("No puedes desactivar tu propia cuenta");
  }

  const targetUser = await prisma.user.findUnique({ where: { id: targetUserId } });

  if (!targetUser) {
    throw new Error("Usuario no encontrado");
  }

  const updatedUser = await prisma.user.update({
    where: { id: targetUserId },
    data: { isActive: !targetUser.isActive },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
    },
  });

  return updatedUser;
}