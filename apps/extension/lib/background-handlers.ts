import type { Locale, Me } from "@radarnaque/shared";
import { accessOf } from "./access";
import { ApiRequestError } from "./api-client";
import {
	AuthError,
	type signOutRemote,
	type startSignIn,
	type verifyOtp,
} from "./auth-client";
import type { DebugSink } from "./debug-log";
import {
	createDebugState,
	type DebugState,
	type SessionTokenStore,
} from "./debug-state";
import { isValidEmail, normalizeEmail } from "./email";
import type { JwtProvider } from "./jwt-provider";
import {
	type AuthState,
	type BgRequest,
	type BgResponse,
	CONTENT_SCRIPT_MESSAGES,
	type ContentAccess,
} from "./messages";
import { ScanPayloadError } from "./scan-payload";

export type { SessionTokenStore } from "./debug-state";

export interface HandlerDeps {
	sessionToken: SessionTokenStore;
	auth: {
		startSignIn: typeof startSignIn;
		verifyOtp: typeof verifyOtp;
		signOutRemote: typeof signOutRemote;
	};
	jwt: Pick<JwtProvider, "invalidate">;
	api: { getMe(): Promise<Me> };
	/** Ouvre la popup de l'extension (`browser.action.openPopup()` en production). */
	openPopup: () => Promise<void>;
	/** R5 : vide les résultats IA gardés à la déconnexion (`clearAiResults`). */
	clearAiResults: () => Promise<void>;
	/**
	 * Sortie des logs de debug du superuser (`console` par défaut ; un faux dans les
	 * tests). Rien n'y est écrit si le dernier `me` lu n'est pas superuser. Ignorée si
	 * `debug` est fourni.
	 */
	debugLog?: DebugSink;
	/**
	 * Build de dev (`import.meta.env.DEV`). R5 : faux en production, `content/debug`
	 * répond faux sans aucune lecture.
	 */
	devBuild: boolean;
	/**
	 * État du debug du superuser, partagé avec le port `scan/stream` (créé une fois dans
	 * `entrypoints/background.ts`). Absent : un état propre à ces handlers, construit
	 * avec `sessionToken`, `api.getMe`, `debugLog` et `devBuild`.
	 */
	debug?: DebugState;
}

export interface ExternalDeps {
	publicUrl: string;
	sessionToken: SessionTokenStore;
	jwt: Pick<JwtProvider, "invalidate">;
}

const LOCALES: readonly Locale[] = ["fr", "nl"];
const OTP = /^\d{6}$/;

function ok<T>(data: T): BgResponse<T> {
	return { ok: true, data };
}

function fail(code: string): BgResponse<never> {
	return { ok: false, error: { code } };
}

/** Code d'une erreur connue, ou `null` pour une erreur inattendue. */
function knownCode(error: unknown): string | null {
	if (error instanceof AuthError) return error.code;
	if (error instanceof ApiRequestError) return error.body.error.code;
	if (error instanceof ScanPayloadError) return error.code;
	return null;
}

/** Code d'une erreur ; une erreur inattendue est écrite en console et donne `internal_error`. */
export function errorCode(error: unknown): string {
	const code = knownCode(error);
	if (code !== null) return code;
	console.error("[radarnaque] erreur inattendue du service worker", error);
	return "internal_error";
}

/** Email normalisé et valide, ou `null` (aucun appel réseau dans ce cas). */
function emailOf(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const email = normalizeEmail(value);
	return isValidEmail(email) ? email : null;
}

export function createHandlers(
	deps: HandlerDeps,
): (req: BgRequest) => Promise<BgResponse<unknown>> {
	const { sessionToken, auth, jwt, api, openPopup } = deps;
	const debug =
		deps.debug ??
		createDebugState({
			sessionToken,
			getMe: () => api.getMe(),
			debugLog: deps.debugLog,
			devBuild: deps.devBuild,
		});

	async function storeSession(token: string | null): Promise<void> {
		await sessionToken.setValue(token);
		jwt.invalidate();
	}

	/**
	 * Drapeau des logs de debug de la page : le mécanisme des logs du service worker
	 * (`me` retenu lié au jeton courant, lu au besoin par `debug.ensureKnown`).
	 * Sans session : faux, sans appel réseau.
	 */
	async function contentDebug(): Promise<BgResponse<boolean>> {
		// R5 : build de production, aucune lecture (ni stockage ni réseau).
		if (!deps.devBuild) return ok(false);
		await debug.ensureKnown();
		let token: string | null;
		try {
			token = await sessionToken.getValue();
		} catch {
			return ok(false);
		}
		return ok(debug.isOnFor(token));
	}

	async function state(): Promise<BgResponse<AuthState>> {
		const me = await debug.trackedMe();
		return ok(me ? { status: "signedIn", me } : { status: "signedOut" });
	}

	async function contentAccess(): Promise<BgResponse<ContentAccess>> {
		const me = await debug.trackedMe();
		return ok(me ? accessOf(me) : { status: "signedOut" });
	}

	async function openPopupPage(): Promise<BgResponse<null>> {
		try {
			await openPopup();
		} catch {
			// Pas de fenêtre active, ou navigateur sans `action.openPopup`.
			return fail("popup_unavailable");
		}
		return ok(null);
	}

	async function handle(req: BgRequest): Promise<BgResponse<unknown>> {
		switch (req.type) {
			case "auth/start": {
				const email = emailOf(req.email);
				if (!email) return fail("invalid_email");
				const locale = LOCALES.includes(req.locale) ? req.locale : "fr";
				await auth.startSignIn(email, locale);
				return ok(null);
			}
			case "auth/verify-otp": {
				const email = emailOf(req.email);
				if (!email) return fail("invalid_email");
				const otp = typeof req.otp === "string" ? req.otp.trim() : "";
				if (!OTP.test(otp)) return fail("invalid_otp");
				await storeSession(await auth.verifyOtp(email, otp));
				return ok(null);
			}
			case "auth/state":
				return state();
			case "content/access":
				return contentAccess();
			case "content/debug":
				return contentDebug();
			case "ui/open-popup":
				return openPopupPage();
			case "auth/sign-out": {
				const token = await sessionToken.getValue();
				// La déconnexion locale a lieu même si la révocation distante échoue.
				if (token) await auth.signOutRemote(token).catch(() => {});
				await storeSession(null);
				// R5 : les résultats IA gardés ne survivent pas à la déconnexion ; un
				// échec du vidage ne bloque pas la déconnexion.
				await deps.clearAiResults().catch(() => {});
				return ok(null);
			}
			default:
				return fail("unknown_message");
		}
	}

	return async (req) => {
		if (
			typeof req !== "object" ||
			req === null ||
			typeof req.type !== "string"
		) {
			return fail("unknown_message");
		}
		try {
			return await handle(req);
		} catch (error) {
			return fail(errorCode(error));
		}
	};
}

/** Identité de l'extension courante : `browser.runtime.id` et `browser.runtime.getURL("/")`. */
export interface ExtensionSelf {
	id: string;
	baseUrl: string;
}

/** Champs de `runtime.MessageSender` utiles au contrôle de l'émetteur. */
export interface InternalSender {
	id?: string;
	url?: string;
	tab?: unknown;
}

/**
 * Page de cette extension (popup) : même identifiant, URL sous `chrome-extension://<id>/`,
 * et aucun onglet. Un émetteur avec `tab` est un content script ou un contexte web.
 */
export function isOwnExtensionPage(
	sender: InternalSender,
	self: ExtensionSelf,
): boolean {
	return (
		sender.id === self.id &&
		!sender.tab &&
		typeof sender.url === "string" &&
		sender.url.startsWith(self.baseUrl)
	);
}

/** Content script de cette extension, dans un onglet d'un site pris en charge. */
function isOwnContentScript(
	sender: InternalSender,
	self: ExtensionSelf,
	isSupportedPage: (url: URL) => boolean,
): boolean {
	if (sender.id !== self.id || !sender.tab || typeof sender.url !== "string") {
		return false;
	}
	try {
		return isSupportedPage(new URL(sender.url));
	} catch {
		return false;
	}
}

/**
 * Enveloppe le handler interne. Une page de l'extension a droit à tout ; un content
 * script d'un site pris en charge, uniquement à `CONTENT_SCRIPT_MESSAGES` (jamais
 * `auth/*`). Tout autre émetteur ou message répond `forbidden_sender`.
 */
export function guardSender(
	handle: (req: BgRequest) => Promise<BgResponse<unknown>>,
	self: ExtensionSelf,
	isSupportedPage: (url: URL) => boolean,
): (req: BgRequest, sender: InternalSender) => Promise<BgResponse<unknown>> {
	return async (req, sender) => {
		const from = sender ?? {};
		if (isOwnExtensionPage(from, self)) return handle(req);
		const type = (req as { type?: unknown } | null)?.type;
		if (
			typeof type === "string" &&
			CONTENT_SCRIPT_MESSAGES.has(type as BgRequest["type"]) &&
			isOwnContentScript(from, self, isSupportedPage)
		) {
			return handle(req);
		}
		return fail("forbidden_sender");
	};
}

/**
 * Émetteur accepté pour le port `scan/stream` : les mêmes règles que `guardSender`
 * pour un message de la liste blanche (une page de l'extension, ou un content script
 * d'un site pris en charge).
 */
export function portSenderGuard(
	self: ExtensionSelf,
	isSupportedPage: (url: URL) => boolean,
): (sender: InternalSender | undefined) => boolean {
	return (sender) => {
		const from = sender ?? {};
		return (
			isOwnExtensionPage(from, self) ||
			isOwnContentScript(from, self, isSupportedPage)
		);
	};
}

/**
 * Message de la page de retour du lien magique (`/auth/callback`). Accepté uniquement
 * depuis l'origine de PUBLIC_URL et sous la forme `{ type: "radarnaque/session", token }`.
 */
export async function handleExternal(
	message: unknown,
	sender: { url?: string },
	deps: ExternalDeps,
): Promise<{ ok: boolean }> {
	let origin: string;
	try {
		origin = new URL(sender.url ?? "").origin;
	} catch {
		return { ok: false };
	}
	if (origin !== new URL(deps.publicUrl).origin) return { ok: false };
	const { type, token } = (message ?? {}) as {
		type?: unknown;
		token?: unknown;
	};
	if (type !== "radarnaque/session" || typeof token !== "string" || !token) {
		return { ok: false };
	}
	await deps.sessionToken.setValue(token);
	deps.jwt.invalidate();
	return { ok: true };
}

/**
 * Adapte un handler asynchrone à `runtime.onMessage` / `onMessageExternal` : la réponse
 * part par `sendResponse` et le listener renvoie `true` pour garder le canal ouvert.
 * Chrome n'accepte une promesse renvoyée par le listener qu'à partir de la version 148 ;
 * `return true` fonctionne dans toutes les versions.
 */
export function createMessageListener<S>(
	handler: (message: never, sender: S) => Promise<unknown>,
): (
	message: unknown,
	sender: S,
	sendResponse: (response: unknown) => void,
) => true {
	return (message, sender, sendResponse) => {
		handler(message as never, sender).then(sendResponse, (error: unknown) => {
			sendResponse({ ok: false, error: { code: errorCode(error) } });
		});
		return true;
	};
}
