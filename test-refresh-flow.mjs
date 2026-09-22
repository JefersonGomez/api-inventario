// test-refresh-flow.mjs
//
// Prueba automática del flujo completo de refresh tokens.
// Requiere Node 18+ (usa fetch nativo).
//
// USO:
//   1. En auth.service.ts, bajá temporalmente ACCESS_TOKEN_EXPIRY a algo corto,
//      ej. "20s", y reiniciá el backend.
//   2. Corré: node test-refresh-flow.mjs tu_email@ejemplo.com tu_password
//      (o edita EMAIL/PASSWORD abajo directamente)
//   3. Al terminar, devolvé ACCESS_TOKEN_EXPIRY a "15m".

const BASE_URL = "http://localhost:3000";
const EMAIL = process.argv[2] || "admin@gmail.com";
const PASSWORD = process.argv[3] || "CAMBIAME";
const WAIT_SECONDS = Number(process.argv[4] || 25); // debe ser > que tu ACCESS_TOKEN_EXPIRY de prueba

function log(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

function ok(condition, successMsg, failMsg) {
  if (condition) {
    console.log(`  ✅ ${successMsg}`);
  } else {
    console.log(`  ❌ ${failMsg}`);
    process.exitCode = 1;
  }
}

async function sleep(seconds) {
  for (let i = seconds; i > 0; i--) {
    process.stdout.write(`\r  esperando ${i}s...   `);
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.stdout.write("\r  espera terminada.        \n");
}

async function main() {
  console.log("=== Test de flujo de refresh tokens ===");
  console.log(`Usando ${EMAIL} contra ${BASE_URL}`);
  console.log(
    `⚠️  Asegurate de que ACCESS_TOKEN_EXPIRY esté configurado por debajo de ${WAIT_SECONDS}s para esta prueba.\n`
  );

  // --- Paso 1: login ---
  log("1/6", "Login");
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const loginData = await loginRes.json();

  ok(loginRes.status === 200, "Login exitoso (200)", `Login falló (${loginRes.status}): ${JSON.stringify(loginData)}`);
  if (loginRes.status !== 200) return;

  ok(!!loginData.token, "Recibió access token", "No vino 'token' en la respuesta");
  ok(!!loginData.refreshToken, "Recibió refresh token", "No vino 'refreshToken' en la respuesta — revisá que Login() lo devuelva");

  let accessToken = loginData.token;
  let refreshToken = loginData.refreshToken;
  const oldRefreshToken = refreshToken; // guardamos para probar la revocación al final

  if (!refreshToken) return; // no tiene sentido seguir sin esto

  // --- Paso 2: confirmar que el access token funciona ahora mismo ---
  log("2/6", "Probar el access token recién emitido");
  const meRes = await fetch(`${BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  ok(meRes.status === 200, "Access token válido (200 en /auth/me)", `Falló (${meRes.status}) — revisá que /auth/me exista`);

  // --- Paso 3: esperar a que expire ---
  log("3/6", `Esperando ${WAIT_SECONDS}s a que el access token expire`);
  await sleep(WAIT_SECONDS);

  const expiredRes = await fetch(`${BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  ok(expiredRes.status === 401, "El access token viejo ahora da 401 (expiró como se esperaba)", `Dio ${expiredRes.status} — ¿bajaste ACCESS_TOKEN_EXPIRY y reiniciaste el backend?`);

  // --- Paso 4: refrescar ---
  log("4/6", "Llamando a /auth/refresh con el refresh token");
  const refreshRes = await fetch(`${BASE_URL}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  const refreshData = await refreshRes.json();

  ok(refreshRes.status === 200, "Refresh exitoso (200)", `Refresh falló (${refreshRes.status}): ${JSON.stringify(refreshData)}`);
  if (refreshRes.status !== 200) return;

  ok(!!refreshData.token && refreshData.token !== accessToken, "Nuevo access token recibido (distinto al anterior)", "El access token no cambió o no vino");
  ok(!!refreshData.refreshToken && refreshData.refreshToken !== oldRefreshToken, "Nuevo refresh token recibido (rotación funcionando)", "El refresh token no cambió — revisá la rotación");

  accessToken = refreshData.token;
  refreshToken = refreshData.refreshToken;

  // --- Paso 5: confirmar que el token nuevo sirve ---
  log("5/6", "Probar el access token nuevo");
  const meAfterRefresh = await fetch(`${BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  ok(meAfterRefresh.status === 200, "El access token nuevo funciona (200)", `Falló (${meAfterRefresh.status})`);

  // Confirmar que el refresh token VIEJO ya no sirve (por la rotación)
  const oldRefreshRetry = await fetch(`${BASE_URL}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: oldRefreshToken }),
  });
  ok(oldRefreshRetry.status === 401, "El refresh token viejo ya no sirve (rotación de un solo uso confirmada)", `Dio ${oldRefreshRetry.status}, debería haber dado 401`);

  // --- Paso 6: logout y confirmar revocación ---
  log("6/6", "Logout y confirmar que el refresh token queda revocado");
  const logoutRes = await fetch(`${BASE_URL}/auth/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  ok(logoutRes.status === 204 || logoutRes.status === 200, `Logout respondió ${logoutRes.status}`, `Logout dio ${logoutRes.status}, inesperado`);

  const refreshAfterLogout = await fetch(`${BASE_URL}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  ok(refreshAfterLogout.status === 401, "El refresh token está revocado tras logout (401 al intentar usarlo)", `Dio ${refreshAfterLogout.status}, debería haber dado 401 — revisá que logout() marque revoked: true`);

  console.log("\n=== Fin de la prueba ===");
  console.log("Si todo salió con ✅, el flujo de refresh tokens está funcionando correctamente.");
  console.log("No olvides devolver ACCESS_TOKEN_EXPIRY a \"15m\" en auth.service.ts.");
}

main().catch((err) => {
  console.error("\n💥 Error inesperado corriendo el script:", err);
  process.exitCode = 1;
});
