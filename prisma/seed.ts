// Crea el primer admin con su empresa si la base está vacía. Corre con tsx, fuera de server.ts.
import "dotenv/config"
import { prismaRoot as prisma } from "../src/config/database.ts"
import bcrypt from "bcrypt"

async function main() {
  try {
    if (await prisma.user.count() > 0) {
      console.log("Ya hay usuarios, no se creó nada")
      return
    }
    const passwordHash = await bcrypt.hash(process.env.ADMIN_INITIAL_PASSWORD!, 10)
    await prisma.$transaction(async (tx) => {
      const admin = await tx.user.create({
        data: { name: "Admin", email: "admin@gmail.com", passwordHash },
      })
      const company = await tx.company.create({ data: { name: "Mi empresa", ownerId: admin.id } })
      await tx.membership.create({ data: { userId: admin.id, companyId: company.id, role: "ADMIN" } })
      await tx.user.update({ where: { id: admin.id }, data: { lastCompanyId: company.id } })
    })
    console.log("Admin y empresa creados correctamente")
  } catch (error) {
    console.error(error)
  } finally {
    await prisma.$disconnect()
  }
}

main()
