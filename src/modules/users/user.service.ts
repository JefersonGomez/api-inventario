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
            createAt: true, // Es útil tener la fecha de creación
        }
    });

    if (!profile) {
        throw new Error("Usuario no encontrado");
    }

    return profile;
}

export async function updateAvatar(userId: string, filename: string): Promise<ProfileData> {
    // 1. Verificar que el usuario existe
    const userExists = await prisma.user.findUnique({
        where: { id: userId }
    });

    if (!userExists) {
        throw new Error("Usuario no encontrado");
    }

    // 2. Construir la URL pública relativa
    // Como en app.ts usamos express.static('uploads'), la ruta web empieza con /uploads
    const avatarUrl = `/uploads/avatars/${filename}`;

    // 3. Actualizar la base de datos
    const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: { avatarUrl },
        select: {
            id: true,
            name: true,
            email: true,
            role: true,
            avatarUrl: true,
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