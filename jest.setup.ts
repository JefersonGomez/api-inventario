import dotenv from "dotenv"
dotenv.config({path:".env.test"})
// los tests no dependen del .env del desarrollador
process.env.JWT_SECRET_KEY ??= "clave-solo-para-pruebas-jest"
process.env.RATE_LIMIT_OFF = "1"