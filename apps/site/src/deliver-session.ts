export type DeliveryResult = "connected" | "expired" | "no-extension";

export interface DeliverSessionDeps {
	fetchToken: () => Promise<string | null>;
	sendToExtension: (token: string) => Promise<boolean>;
}

export const EXTENSION_TIMEOUT_MS = 3000;

async function withTimeout(
	send: Promise<boolean>,
	ms: number,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([send, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

export async function deliverSession(
	deps: DeliverSessionDeps,
): Promise<DeliveryResult> {
	let token: string | null;
	try {
		token = await deps.fetchToken();
	} catch {
		return "expired";
	}
	if (!token) return "expired";

	try {
		const ok = await withTimeout(
			Promise.resolve().then(() => deps.sendToExtension(token)),
			EXTENSION_TIMEOUT_MS,
		);
		return ok ? "connected" : "no-extension";
	} catch {
		return "no-extension";
	}
}
