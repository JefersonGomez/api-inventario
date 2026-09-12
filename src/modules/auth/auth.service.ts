import { prisma } from "../../config/database.ts";
import bcrypt from "bcrypt";
import jwt, { type SignOptions } from "jsonwebtoken";

export async function Register(name: string, email: string, password: string) {
  const existingUser = await prisma.user.findUnique({
    where: { email: email },
  });

  if (existingUser) {
    throw new Error("El usuario ya existe");
  }

  const passwordHashed = await bcrypt.hash(password, 10);

  const newUser = await prisma.user.create({
    data: {
      name: name,
      email: email,
      passwordHash: passwordHashed,
      role: "EMPLOYE",
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      avatarUrl: true,
    },
  });

  return newUser;
}

export async function Login(email: string, password: string) {
  const existUser = await prisma.user.findUnique({
    where: { email: email },
  });

  if (!existUser) {
    throw new Error("Credenciales invalidas");
  }

  const coinciden = await bcrypt.compare(password, existUser.passwordHash);

  if (!coinciden) {
    throw new Error("Credenciales invalidas");
  }

  const payload = {
    id: existUser.id,
    role: existUser.role,
  };

  const opciones: SignOptions = {
    expiresIn: "2h",
  };

  const clave = process.env.JWT_SECRET_KEY || "clave_secreta_por_defecto_desarrollo";

  const token = jwt.sign(payload, clave, opciones);

  return {
    token,
    user: {
      id: existUser.id,
      name: existUser.name,
      email: existUser.email,
      role: existUser.role,
      avatarUrl: existUser.avatarUrl,
    },
  };
}