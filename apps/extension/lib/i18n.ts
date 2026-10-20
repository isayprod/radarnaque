import type { Locale } from "@radarnaque/shared";

const fr = {
	"app.loading": "Chargement…",
	"app.retry": "Réessayer",
	"locale.label": "Langue",

	"email.label": "Adresse email",
	"email.placeholder": "vous@exemple.be",
	"email.submit": "Recevoir mon lien de connexion",
	"email.sending": "Envoi en cours…",

	"code.instructions":
		"Vérifiez votre boîte mail : cliquez sur le lien ou saisissez le code",
	"code.label": "Code à 6 chiffres",
	"code.sentTo": "Email envoyé à",
	"code.verifying": "Vérification…",
	"code.resend": "Renvoyer l'email",
	"code.resent": "Email renvoyé.",
	"code.changeEmail": "Changer d'adresse",

	"account.scansLeft": "{count} analyses IA restantes",
	"account.scansLeftOne": "{count} analyse IA restante",
	"action.signOut": "Se déconnecter",

	"delete.title": "Supprimer mon compte",
	"delete.explanation":
		"Votre compte, votre abonnement et l'historique de vos analyses seront effacés. Les analyses d'annonces, anonymes, sont conservées.",
	"delete.word": "SUPPRIMER",
	"delete.prompt": "Tapez SUPPRIMER pour confirmer",
	"delete.submit": "Supprimer définitivement",
	"delete.submitting": "Suppression…",
	"delete.success": "Votre compte a été supprimé.",
	"delete.failure":
		"La suppression a échoué, votre compte n'a pas été modifié. Réessayez.",
	"delete.unreachable":
		"Impossible de joindre le serveur. Si votre compte a été supprimé, vous serez déconnecté.",
	"privacy.link": "Confidentialité",

	"plan.trial": "Essai",
	"plan.standard": "Standard",
	"plan.premium": "Premium",
	"plan.none": "Aucun abonnement actif",
	"plan.unlimited": "Administrateur · illimité",
	"plan.superuser": "Superuser (dev)",

	"error.invalid_email": "Adresse email invalide.",
	"error.rate_limited":
		"Trop de tentatives. Patientez quelques minutes avant de réessayer.",
	"error.invalid_otp":
		"Code incorrect ou expiré. Vérifiez-le ou demandez un nouvel email.",
	"error.session_expired": "Votre session a expiré. Reconnectez-vous.",
	"error.unavailable": "Service momentanément indisponible. Réessayez.",
} as const;

export type MessageKey = keyof typeof fr;

const nl: Record<MessageKey, string> = {
	"app.loading": "Laden…",
	"app.retry": "Opnieuw proberen",
	"locale.label": "Taal",

	"email.label": "E-mailadres",
	"email.placeholder": "jij@voorbeeld.be",
	"email.submit": "Ontvang mijn aanmeldlink",
	"email.sending": "Bezig met verzenden…",

	"code.instructions":
		"Controleer je mailbox: klik op de link of voer de code in",
	"code.label": "Code van 6 cijfers",
	"code.sentTo": "E-mail verzonden naar",
	"code.verifying": "Controleren…",
	"code.resend": "E-mail opnieuw verzenden",
	"code.resent": "E-mail opnieuw verzonden.",
	"code.changeEmail": "Ander adres gebruiken",

	"account.scansLeft": "{count} AI-analyses over",
	"account.scansLeftOne": "{count} AI-analyse over",
	"action.signOut": "Afmelden",

	"delete.title": "Mijn account verwijderen",
	"delete.explanation":
		"Jouw account, jouw abonnement en de geschiedenis van je analyses worden gewist. De analyses van advertenties, die anoniem zijn, blijven bewaard.",
	"delete.word": "VERWIJDEREN",
	"delete.prompt": "Typ VERWIJDEREN om te bevestigen",
	"delete.submit": "Definitief verwijderen",
	"delete.submitting": "Verwijderen…",
	"delete.success": "Je account is verwijderd.",
	"delete.failure":
		"Verwijderen is mislukt, je account is niet gewijzigd. Probeer opnieuw.",
	"delete.unreachable":
		"De server is niet bereikbaar. Als je account verwijderd is, word je afgemeld.",
	"privacy.link": "Privacy",

	"plan.trial": "Proef",
	"plan.standard": "Standaard",
	"plan.premium": "Premium",
	"plan.none": "Geen actief abonnement",
	"plan.unlimited": "Beheerder · onbeperkt",
	"plan.superuser": "Superuser (dev)",

	"error.invalid_email": "Ongeldig e-mailadres.",
	"error.rate_limited":
		"Te veel pogingen. Wacht enkele minuten voordat je het opnieuw probeert.",
	"error.invalid_otp":
		"Code onjuist of verlopen. Controleer de code of vraag een nieuwe e-mail aan.",
	"error.session_expired": "Je sessie is verlopen. Meld je opnieuw aan.",
	"error.unavailable": "Dienst tijdelijk niet beschikbaar. Probeer opnieuw.",
};

export const dictionaries: Record<Locale, Record<MessageKey, string>> = {
	fr,
	nl,
};

/** `nl` si la langue du navigateur commence par `nl`, sinon `fr`. */
export function detectLocale(uiLanguage: string): Locale {
	return uiLanguage.toLowerCase().startsWith("nl") ? "nl" : "fr";
}

export function t(locale: Locale, key: MessageKey): string {
	return dictionaries[locale][key];
}

/** Message traduit d'un code d'erreur ; tout code inconnu donne le message générique. */
export function errorMessage(locale: Locale, code: string): string {
	const key = `error.${code}`;
	return key in fr
		? t(locale, key as MessageKey)
		: t(locale, "error.unavailable");
}
