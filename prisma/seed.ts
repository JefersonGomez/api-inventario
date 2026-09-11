import { prisma } from "../src/config/database.ts"
import bcrypt from "bcrypt"

async function main() {
  try {
    const existingAdmin = await prisma.user.findFirst({
      where: { role: "ADMIN" }
    })

    if (existingAdmin) {
      console.log("El admin ya existe, no se creó nada")
      return
    }

    const passwordHashed = await bcrypt.hash(process.env.ADMIN_INITIAL_PASSWORD!, 10)

    const admin = await prisma.user.create({
      data: {
        name: "Admin",
        email: "admin@gmail.com",
        passwordHash: passwordHashed,
        role: "ADMIN",
        avatarUrl: "avatars/default.png",
      }
    })

    if (admin) {
      console.log("Admin creado correctamente")
    }

  } catch (error) {
    console.error(error)
  } finally {
    await prisma.$disconnect()
  }
}

main()
