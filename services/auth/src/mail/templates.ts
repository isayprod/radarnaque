import type { Locale } from "@radarnaque/shared";

export interface RenderedEmail {
	subject: string;
	html: string;
	text: string;
}

interface Copy {
	subject: string;
	intro: string;
	button: string;
	codeLabel: string;
	validity: string;
	ignore: string;
	/** Séparateur avant une valeur : espace insécable avant « : » en français. */
	colon: string;
}

const COPY: Record<Locale, Copy> = {
	fr: {
		subject: "Votre connexion à Radarnaque",
		intro:
			"Pour vous connecter à Radarnaque, cliquez sur le lien ci-dessous ou saisissez le code dans l'extension.",
		button: "Se connecter",
		codeLabel: "Votre code de connexion",
		validity: "Le lien et le code sont valables 10 minutes.",
		ignore: "Si vous n'avez pas demandé cette connexion, ignorez cet email.",
		colon: "\u00a0:",
	},
	nl: {
		subject: "Uw aanmelding bij Radarnaque",
		intro:
			"Klik op de link hieronder of voer de code in de extensie in om u aan te melden bij Radarnaque.",
		button: "Aanmelden",
		codeLabel: "Uw aanmeldcode",
		validity: "De link en de code zijn 10 minuten geldig.",
		ignore: "Hebt u deze aanmelding niet aangevraagd? Negeer dan deze e-mail.",
		colon: ":",
	},
};

const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** Email de connexion combiné : lien magique + code OTP, en FR ou NL. */
export function renderSignInEmail({
	locale,
	url,
	otp,
}: {
	locale: Locale;
	url: string;
	otp: string;
}): RenderedEmail {
	const c = COPY[locale];
	const u = escapeHtml(url);
	const code = escapeHtml(otp);

	const html = `<!doctype html>
<html lang="${locale}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(c.subject)}</title></head>
<body style="margin:0;padding:24px;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px">
<tr><td style="padding:32px">
<h1 style="margin:0 0 16px;font-size:20px">Radarnaque</h1>
<p style="margin:0 0 24px;line-height:1.5">${escapeHtml(c.intro)}</p>
<p style="margin:0 0 24px"><a href="${u}" style="display:inline-block;padding:12px 20px;background:#1a56db;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold">${escapeHtml(c.button)}</a></p>
<p style="margin:0 0 8px">${escapeHtml(c.codeLabel)}${c.colon}</p>
<p style="margin:0 0 24px;font-size:28px;font-weight:bold;letter-spacing:6px;font-family:'Courier New',monospace">${code}</p>
<p style="margin:0 0 8px;line-height:1.5">${escapeHtml(c.validity)}</p>
<p style="margin:0 0 24px;color:#666666;font-size:13px;line-height:1.5">${escapeHtml(c.ignore)}</p>
<p style="margin:0;color:#666666;font-size:12px;word-break:break-all">${u}</p>
</td></tr>
</table>
</body>
</html>`;

	const text = [
		"Radarnaque",
		"",
		c.intro,
		"",
		`${c.button}${c.colon} ${url}`,
		"",
		`${c.codeLabel}${c.colon} ${otp}`,
		"",
		c.validity,
		c.ignore,
		"",
	].join("\n");

	return { subject: c.subject, html, text };
}

/**
 * Email de repli quand Better Auth envoie le lien ou le code seul (appel direct de ses
 * routes, hors de `/auth/start`) : la langue est inconnue, le texte est donc en FR puis NL.
 */
export function renderStandaloneSignInEmail(
	value: { url: string; otp?: undefined } | { otp: string; url?: undefined },
): RenderedEmail {
	const locales: Locale[] = ["fr", "nl"];
	const sections = locales.map((locale) => {
		const c = COPY[locale];
		if (value.url !== undefined) {
			const u = escapeHtml(value.url);
			return {
				html: `<p style="margin:0 0 8px"><a href="${u}">${escapeHtml(c.button)}</a></p>
<p style="margin:0 0 8px;font-size:12px;word-break:break-all">${u}</p>
<p style="margin:0 0 24px">${escapeHtml(c.validity)}</p>`,
				text: `${c.button}${c.colon} ${value.url}\n${c.validity}`,
			};
		}
		return {
			html: `<p style="margin:0 0 8px">${escapeHtml(c.codeLabel)}${c.colon} <strong style="font-family:'Courier New',monospace;letter-spacing:4px">${escapeHtml(value.otp)}</strong></p>
<p style="margin:0 0 24px">${escapeHtml(c.validity)}</p>`,
			text: `${c.codeLabel}${c.colon} ${value.otp}\n${c.validity}`,
		};
	});

	const subject = `${COPY.fr.subject} / ${COPY.nl.subject}`;
	const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">
<h1 style="font-size:20px">Radarnaque</h1>
${sections.map((s) => s.html).join("\n<hr>\n")}
<p style="color:#666666;font-size:13px">${escapeHtml(COPY.fr.ignore)}<br>${escapeHtml(COPY.nl.ignore)}</p>
</body>
</html>`;
	const text = [
		"Radarnaque",
		"",
		sections[0].text,
		"",
		sections[1].text,
		"",
		COPY.fr.ignore,
		COPY.nl.ignore,
		"",
	].join("\n");
	return { subject, html, text };
}
