// Utilidades de tests. Corren contra DATABASE_URL de .env.test (cargado en jest.setup.ts).
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "../config/database.ts";

// Vacía todas las tablas. Se niega a correr si la URL no apunta a una base "_test":
// un .env mal cargado nunca debe poder borrar la base real.
export async function resetDb() {
  if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("resetDb: DATABASE_URL no es una base de pruebas (_test)");
  }
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`
  );
}

// Crea un usuario y devuelve un token de acceso firmado igual que el login
export async function createUser(role: "ADMIN" | "EMPLOYE", email = `${role.toLowerCase()}-${Date.now()}-${Math.random()}@test.com`) {
  const user = await prisma.user.create({
    data: { name: `${role} test`, email, role, passwordHash: await bcrypt.hash("123456", 4) },
  });
  const token = jwt.sign(
    { id: user.id, role: user.role },
    process.env.JWT_SECRET_KEY || "clave_secreta_por_defecto_desarrollo",
    { expiresIn: "15m" }
  );
  return { user, token, auth: { Authorization: `Bearer ${token}` } };
}
