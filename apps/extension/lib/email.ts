/** `trim` + minuscules, comme le service auth avant tout envoi. */
export function normalizeEmail(s: string): string {
	return s.trim().toLowerCase();
}

const EMAIL = /^[^\s@]+@(?:[^\s@.]+\.)+[^\s@.]{2,}$/;

/**
 * Contrôle de forme avant tout appel réseau. Le service auth (zod `z.email()`) reste
 * seul juge : une adresse acceptée ici peut encore y être refusée (`invalid_email`).
 */
export function isValidEmail(s: string): boolean {
	return s.length <= 254 && EMAIL.test(s);
}
