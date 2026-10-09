import { Server } from "socket.io";
import type { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { prisma } from "../config/database.ts";
import type { AuthPayload } from "../types/express.d.ts";

// El socket no transporta datos: solo avisa "esto cambió" y el cliente vuelve a pedirlo por la API normal.
// Los topics son las raíces de las queryKey de react-query del frontend.
let io: Server | null = null;

export const ADMINS = "role:ADMIN";
export const EVERYONE = ["role:ADMIN", "role:EMPLOYE"];
export const userRoom = (id: string) => `user:${id}`;

// lo que cambia cuando se mueve el stock o el catálogo
export const STOCK_TOPICS = [
  "products",
  "movements",
  "reports",
  "stock-forecast",
  "inventory-value-breakdown",
  "notifications",
];
export const REQUEST_TOPICS = ["purchase-requests", "purchase-request-alerts", "notifications"];

export function initRealtime(httpServer: HttpServer) {
  io = new Server(httpServer, { cors: { origin: "http://localhost:5173" } });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const clave = process.env.JWT_SECRET_KEY || "clave_secreta_por_defecto_desarrollo";
      const payload = jwt.verify(token, clave) as AuthPayload;
      const user = await prisma.user.findUnique({ where: { id: payload.id } });
      if (!user || !user.isActive) return next(new Error("unauthorized"));
      socket.data.user = { id: user.id, role: user.role };
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const { id, role } = socket.data.user;
    socket.join([`role:${role}`, userRoom(id)]);
  });
}

// Nunca debe romper la petición que lo llama: si el socket falla, la API sigue respondiendo.
export function emit(rooms: string | string[], topics: string[]) {
  try {
    io?.to(rooms).emit("invalidate", topics);
  } catch (error) {
    console.error("realtime emit falló:", error);
  }
}
