// Utilidades de tests. Corren contra DATABASE_URL de .env.test (cargado en jest.setup.ts).
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prismaRoot } from "../config/database.ts";
import { jwtSecret } from "../config/env.ts";
import type { Role } from "../generated/prisma/enums.ts";

// Vacía todas las tablas. Se niega a correr si la URL no apunta a una base "_test":
// un .env mal cargado nunca debe poder borrar la base real.
export async function resetDb() {
  if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("resetDb: DATABASE_URL no es una base de pruebas (_test)");
  }
  const tables = await prismaRoot.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  await prismaRoot.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`
  );
}

let seq = 0;

// Crea un usuario dentro de una empresa y devuelve un token como el del login.
// Sin `companyId` crea una empresa nueva de la que el usuario es dueño.
export async function createUser(role: Role, companyId?: string) {
  const user = await prismaRoot.user.create({
    data: { name: `${role} test ${++seq}`, email: `user${seq}-${Date.now()}@test.com`, passwordHash: await bcrypt.hash("123456", 4) },
  });
  let cid = companyId;
  if (!cid) {
    cid = (await prismaRoot.company.create({ data: { name: `Empresa ${seq}`, ownerId: user.id } })).id;
    await prismaRoot.location.create({ data: { companyId: cid, name: "Sucursal principal", type: "BRANCH", code: "001" } });
  }
  await prismaRoot.membership.create({ data: { userId: user.id, companyId: cid, role } });
  const token = jwt.sign(
    { id: user.id, companyId: cid },
    jwtSecret(),
    { expiresIn: "15m" }
  );
  return { user, companyId: cid, token, auth: { Authorization: `Bearer ${token}` } };
}

// Ubicación principal de una empresa (la crea createUser al crear la empresa)
export async function mainLocationId(companyId: string) {
  return (await prismaRoot.location.findFirstOrThrow({ where: { companyId }, orderBy: { createdAt: "asc" } })).id;
}
