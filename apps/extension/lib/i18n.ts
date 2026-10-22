import type { Locale } from "@radarnaque/shared";

const fr = {
	"app.loading": "Chargement…",
	"app.retry": "Réessayer",
	"app.unavailableTitle": "Service injoignable",
	"app.unavailableText":
		"Impossible de joindre Radarnaque. Vérifiez votre connexion, puis réessayez.",
	"locale.label": "Langue",

	"signin.title": "Repérez les arnaques avant de payer",
	"signin.lead":
		"Connectez-vous pour analyser les annonces de 2ememain, 2dehands et Marketplace.",
	"signin.note":
		"Un lien et un code vous sont envoyés par email. Pas de mot de passe.",

	"email.label": "Adresse email",
	"email.placeholder": "vous@exemple.be",
	"email.submit": "Recevoir mon lien de connexion",
	"email.sending": "Envoi en cours…",

	"code.title": "Vérifiez vos emails",
	"code.instructions":
		"Vérifiez votre boîte mail : cliquez sur le lien ou saisissez le code",
	"code.label": "Code à 6 chiffres",
	"code.sentTo": "Email envoyé à",
	"code.verifying": "Vérification…",
	"code.resend": "Renvoyer l'email",
	"code.resent": "Email renvoyé.",
	"code.changeEmail": "Changer d'adresse",

	"account.scansLabel": "Analyses IA restantes",
	// `{badge}` : la pastille « Analyser » en miniature (nœud React, jamais du HTML).
	"account.how":
		"Ouvrez une annonce sur 2ememain, 2dehands ou Marketplace, puis cliquez sur {badge} à côté du titre.",
	"action.pricing": "Voir les formules",
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
	"footer.pricing": "Formules",

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
	"app.unavailableTitle": "Dienst onbereikbaar",
	"app.unavailableText":
		"Radarnaque is niet bereikbaar. Controleer je verbinding en probeer opnieuw.",
	"locale.label": "Taal",

	"signin.title": "Herken oplichting vóór je betaalt",
	"signin.lead":
		"Meld je aan om advertenties op 2dehands, 2ememain en Marketplace te analyseren.",
	"signin.note": "Je krijgt een link en een code per e-mail. Geen wachtwoord.",

	"email.label": "E-mailadres",
	"email.placeholder": "jij@voorbeeld.be",
	"email.submit": "Ontvang mijn aanmeldlink",
	"email.sending": "Bezig met verzenden…",

	"code.title": "Controleer je e-mail",
	"code.instructions":
		"Controleer je mailbox: klik op de link of voer de code in",
	"code.label": "Code van 6 cijfers",
	"code.sentTo": "E-mail verzonden naar",
	"code.verifying": "Controleren…",
	"code.resend": "E-mail opnieuw verzenden",
	"code.resent": "E-mail opnieuw verzonden.",
	"code.changeEmail": "Ander adres gebruiken",

	"account.scansLabel": "Resterende AI-analyses",
	"account.how":
		"Open een advertentie op 2dehands, 2ememain of Marketplace en klik op {badge} naast de titel.",
	"action.pricing": "Formules bekijken",
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
	"footer.pricing": "Formules",

	"plan.trial": "Proef",
	"plan.standard": "Standard",
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
