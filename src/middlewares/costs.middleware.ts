import type { NextFunction, Request, Response } from "express";

// Sin el permiso costs.view, ninguna respuesta lleva costos: se quitan las claves de costo de todo
// el JSON antes de enviarlo (productos dentro de solicitudes, órdenes, reportes, lo que sea).
// Red de seguridad global: un endpoint nuevo no puede "olvidarse" de ocultarlos.
// Los reportes de valor a costo además piden costs.view en la ruta (403).
const COST_KEYS = new Set(["cost", "unitCost"]);

export function stripCosts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCosts);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !COST_KEYS.has(k)).map(([k, v]) => [k, stripCosts(v)]));
  }
  return value;
}

export function hideCostsWithoutPermission(req: Request, res: Response, next: NextFunction) {
  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    // req.user lo pone Authenticated, que corre después: al responder ya está
    if (req.user && !req.user.permissions.includes("costs.view")) {
      // ida y vuelta por JSON: Decimal y Date quedan como los vería el cliente
      return json(stripCosts(JSON.parse(JSON.stringify(body))));
    }
    return json(body);
  }) as Response["json"];
  next();
}
