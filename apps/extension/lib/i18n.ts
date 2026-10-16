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

	"account.remaining": "Scans restants",
	"account.totalCap": "Scans d'essai restants",
	"action.signOut": "Se déconnecter",

	"plan.trial": "Essai",
	"plan.standard": "Standard",
	"plan.premium": "Premium",
	"plan.none": "Aucun abonnement actif",
	"plan.unlimited": "Administrateur · illimité",

	"scan.text": "Analyses texte",
	"scan.image": "Analyses avec photos",

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

	"account.remaining": "Resterende scans",
	"account.totalCap": "Resterende proefscans",
	"action.signOut": "Afmelden",

	"plan.trial": "Proef",
	"plan.standard": "Standaard",
	"plan.premium": "Premium",
	"plan.none": "Geen actief abonnement",
	"plan.unlimited": "Beheerder · onbeperkt",

	"scan.text": "Tekstanalyses",
	"scan.image": "Analyses met foto's",

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
