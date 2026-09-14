import { prisma } from "../../config/database.js";
import type { User } from "../../generated/prisma/client.ts";
import bcrypt from "bcrypt"
// Tipo de retorno para el perfil (sin passwordHash)
type ProfileData = Omit<User, "passwordHash">;

export async function getProfile(userId: string): Promise<ProfileData> {
    const profile = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            name: true,
            email: true,
            role: true,
            avatarUrl: true,
            isActive: true,
            createAt: true,
        }
    });

    if (!profile) {
        throw new Error("Usuario no encontrado");
    }

    return profile;
}

export async function updateAvatar(userId: string, filename: string): Promise<ProfileData> {
    const userExists = await prisma.user.findUnique({
        where: { id: userId }
    });

    if (!userExists) {
        throw new Error("Usuario no encontrado");
    }

    const avatarUrl = `/uploads/avatars/${filename}`;

    const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: { avatarUrl },
        select: {
            id: true,
            name: true,
            email: true,
            role: true,
            avatarUrl: true,
            isActive: true,
            createAt: true,
        }
    });

    return updatedUser;
}

export async function changePassword(userID:string,currentPassword:string,newPassword:string) {
    
    const user  = await prisma.user.findUnique({
        where:{id:userID}
    })
    if(!user){
        throw new Error("Usuario no encontrado")
    }
    const isValid = await bcrypt.compare(currentPassword,user.passwordHash)

    if(!isValid){
        throw new Error("La contraseña actual es incorrecta")
    }


    const newPasswordHash = await bcrypt.hash(newPassword,10)

    await prisma.user.update({
    where: { id: userID },
    data: { passwordHash: newPasswordHash },
  })
   return { message: "Contraseña actualizada correctamente" }
}

export async function updateProfile(userId: string, name: string, email: string) {
  const existingEmail = await prisma.user.findUnique({ where: { email } })

  if (existingEmail && existingEmail.id !== userId) {
    throw new Error("Ese email ya está en uso por otro usuario")
  }

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: { name, email },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      avatarUrl: true,
    },
  })

  return updatedUser
}