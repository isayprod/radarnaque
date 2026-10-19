/** Un événement Server-Sent Events : son nom (`message` par défaut) et ses données brutes. */
export interface SseMessage {
	event: string;
	data: string;
}

/**
 * Lit un flux `text/event-stream` (spec §10.1). Le décodage UTF-8 se fait en flux : un
 * caractère coupé entre deux morceaux réseau est reconstitué. Lignes `event:` et `data:`
 * (plusieurs `data:` sont joints par `\n`), fins de ligne LF, CR ou CRLF ; un commentaire
 * (`: ping`) et les autres champs sont ignorés. Un événement sans `data:`, ou inachevé à la
 * fin du flux, n'est pas rendu. Arrêter la lecture (ou une erreur) annule le flux.
 */
export async function* readSse(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage, void, undefined> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let event = "";
	let data: string[] = [];

	/** Traite une ligne complète ; rend l'événement qu'une ligne vide termine. */
	function line(text: string): SseMessage | null {
		if (text === "") {
			const message =
				data.length > 0
					? { event: event || "message", data: data.join("\n") }
					: null;
			event = "";
			data = [];
			return message;
		}
		if (text.startsWith(":")) return null;
		const colon = text.indexOf(":");
		const field = colon < 0 ? text : text.slice(0, colon);
		let value = colon < 0 ? "" : text.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") event = value;
		else if (field === "data") data.push(value);
		return null;
	}

	try {
		for (;;) {
			const { value, done } = await reader.read();
			buffer += done
				? decoder.decode()
				: decoder.decode(value, { stream: true });
			for (;;) {
				const end = buffer.search(/[\r\n]/);
				if (end < 0) break;
				// Un CR en fin de morceau peut être suivi d'un LF dans le suivant.
				if (buffer[end] === "\r" && end === buffer.length - 1 && !done) break;
				const width = buffer.startsWith("\r\n", end) ? 2 : 1;
				const message = line(buffer.slice(0, end));
				buffer = buffer.slice(end + width);
				if (message) yield message;
			}
			if (done) return;
		}
	} finally {
		// Lecture arrêtée avant la fin (ou en erreur) : la requête est abandonnée.
		await reader.cancel().catch(() => {});
	}
}
