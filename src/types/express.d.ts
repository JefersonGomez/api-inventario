export interface AuthPayload {
  id: string;
  companyId: string;
  role: string; // rol del usuario EN esa empresa (sale de Membership, no del token)
  permissions: string[]; // permisos efectivos en esa empresa: rol + ajustes de la persona
  isPlatformOwner?: boolean;
  locationIds?: string[] | null; // ubicaciones donde trabaja (null = todas)
  activeLocationId?: string | null; // la que eligió en el selector (null = todas las suyas)
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}
