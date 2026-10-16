import { Resend } from "resend";

export interface MailMessage {
	to: string;
	subject: string;
	html: string;
	text: string;
}

export interface Mailer {
	send(msg: MailMessage): Promise<void>;
}

/** Envoi réel via Resend. */
export class ResendMailer implements Mailer {
	readonly #client: Resend;
	readonly #from: string;

	constructor(apiKey: string, from: string) {
		this.#client = new Resend(apiKey);
		this.#from = from;
	}

	async send(msg: MailMessage): Promise<void> {
		const { error } = await this.#client.emails.send({
			from: this.#from,
			to: msg.to,
			subject: msg.subject,
			html: msg.html,
			text: msg.text,
		});
		if (error)
			throw new Error(
				`Resend: échec de l'envoi (${error.name}: ${error.message})`,
			);
	}
}

/** Développement : affiche l'email dans les logs au lieu de l'envoyer. */
export class ConsoleMailer implements Mailer {
	async send(msg: MailMessage): Promise<void> {
		console.info(`[mail] à ${msg.to} — ${msg.subject}\n${msg.text}`);
	}
}

/** Tests et route de dev : conserve les messages envoyés. */
export class MemoryMailer implements Mailer {
	readonly messages: MailMessage[] = [];

	async send(msg: MailMessage): Promise<void> {
		this.messages.push(msg);
	}

	/** Dernier message envoyé à `to` (comparaison insensible à la casse). */
	last(to: string): MailMessage | undefined {
		const target = to.trim().toLowerCase();
		return this.messages.findLast((m) => m.to.toLowerCase() === target);
	}
}
