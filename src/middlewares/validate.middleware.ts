import type { NextFunction, Request, Response } from "express";
import { type ZodType } from "zod"

export function validate(schema:ZodType ) {
    return (req: Request, res: Response, next: NextFunction) => {
        const result = schema.safeParse(req.body);

        if (!result.success) {
            // Retornamos para detener la ejecución y enviamos los errores formateados de Zod
            return res.status(400).json({ 
                error: result.error.flatten() // o result.error.format()
            });
        }

        // Si fue exitoso, asignamos los datos parseados/transformados
        req.body = result.data;
        next();
    };
}