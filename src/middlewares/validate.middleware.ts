import type { NextFunction, Request, Response } from "express";
import { type ZodType } from "zod";

export function validate(schema: ZodType) {
    return (req: Request, res: Response, next: NextFunction) => {
        const result = schema.safeParse(req.body);

        if (!result.success) {
            return res.status(400).json({ 
                error: result.error.issues 
            });
        }

        req.body = result.data;
        next();
    };
}

// Query string (listados, filtros). En Express 5 req.query es de solo lectura: el resultado
// validado queda en res.locals.query.
export function validateQuery(schema: ZodType) {
    return (req: Request, res: Response, next: NextFunction) => {
        const result = schema.safeParse(req.query);
        if (!result.success) {
            return res.status(400).json({ error: result.error.issues });
        }
        res.locals.query = result.data;
        next();
    };
}