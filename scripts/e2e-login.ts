// Test de connexion de bout en bout, contre la stack de dev (voir README, « Démarrer en dev »).
//
//   pnpm e2e:login
//
// Lit PUBLIC_URL et EXTENSION_ID dans infra/.env (ou dans le fichier E2E_ENV_FILE), crée un
// compte neuf à chaque exécution, puis enchaîne : /auth/start → /auth/dev/last-email → /auth/sign-in/email-otp → /auth/token
// → /api/me. Affiche `E2E LOGIN OK` (code 0) ; à la première étape en échec, affiche son
// nom, le statut HTTP et le corps de la réponse (code 1).
import { loadConfig, login, run } from "./e2e-lib.js";

await run(async () => {
	await login(loadConfig());
	console.log("E2E LOGIN OK");
});
