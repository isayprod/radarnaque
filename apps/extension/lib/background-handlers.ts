import type { AnalysisResult, Locale, Me, ScanIn } from "@radarnaque/shared";
import { accessOf, isDebug } from "./access";
import { ApiRequestError } from "./api-client";
import {
	AuthError,
	type signOutRemote,
	type startSignIn,
	type verifyOtp,
} from "./auth-client";
import { createDebugLog, type DebugSink } from "./debug-log";
import { isValidEmail, normalizeEmail } from "./email";
import type { JwtProvider } from "./jwt-provider";
import {
	type AuthState,
	type BgRequest,
	type BgResponse,
	CONTENT_SCRIPT_MESSAGES,
	type ContentAccess,
	type ScanRequest,
} from "./messages";
import { ScanPayloadError, toScanIn } from "./scan-payload";

/** Ce dont les handlers ont besoin du stockage (`sessionToken` de `storage.ts`). */
export interface SessionTokenStore {
	getValue(): Promise<string | null>;
	setValue(value: string | null): Promise<void>;
}

export interface HandlerDeps {
	sessionToken: SessionTokenStore;
	auth: {
		startSignIn: typeof startSignIn;
		verifyOtp: typeof verifyOtp;
		signOutRemote: typeof signOutRemote;
	};
	jwt: Pick<JwtProvider, "invalidate">;
	api: { getMe(): Promise<Me>; scan(body: ScanIn): Promise<AnalysisResult> };
	/** Ouvre la popup de l'extension (`browser.action.openPopup()` en production). */
	openPopup: () => Promise<void>;
	/** R5 : vide les résultats IA gardés à la déconnexion (`clearAiResults`). */
	clearAiResults: () => Promise<void>;
	/**
	 * Sortie des logs de debug du superuser (`console` par défaut ; un faux dans les
	 * tests). Rien n'y est écrit si le dernier `me` lu n'est pas superuser.
	 */
	debugLog?: DebugSink;
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

function errorCode(error: unknown): string {
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

	/**
	 * Debug du dernier `me` lu (`auth/state` ou `content/access`). Faux au démarrage du
	 * service worker, sans session, après une erreur et à chaque changement de session.
	 */
	let lastAccessDebug = false;
	// Seuls le corps `ScanIn`, le résultat et le code d'erreur y passent : jamais
	// d'en-tête, de JWT, de jeton de session ni de cookie.
	const debugLog = createDebugLog(() => lastAccessDebug, deps.debugLog);

	async function storeSession(token: string | null): Promise<void> {
		lastAccessDebug = false;
		await sessionToken.setValue(token);
		jwt.invalidate();
	}

	/**
	 * `Me` de l'utilisateur connecté, ou `null` sans session (aucun appel réseau) ou si
	 * elle a expiré. Toute autre erreur (réseau, 503 `auth_unavailable`) est propagée.
	 */
	async function currentMe(): Promise<Me | null> {
		if (!(await sessionToken.getValue())) return null;
		try {
			return await api.getMe();
		} catch (error) {
			// L'api client a déjà effacé la session (onUnauthenticated).
			if (error instanceof AuthError && error.code === "session_expired") {
				return null;
			}
			throw error;
		}
	}

	/** `currentMe` qui met aussi à jour `lastAccessDebug` (faux en cas d'erreur). */
	async function trackedMe(): Promise<Me | null> {
		lastAccessDebug = false;
		const me = await currentMe();
		lastAccessDebug = me !== null && isDebug(accessOf(me));
		return me;
	}

	async function state(): Promise<BgResponse<AuthState>> {
		const me = await trackedMe();
		return ok(me ? { status: "signedIn", me } : { status: "signedOut" });
	}

	async function contentAccess(): Promise<BgResponse<ContentAccess>> {
		const me = await trackedMe();
		return ok(me ? accessOf(me) : { status: "signedOut" });
	}

	/**
	 * Scan IA demandé par le content script. La demande vient d'une page web : sa forme
	 * est vérifiée avant `toScanIn`, qui retire l'identité du vendeur et applique les bornes.
	 */
	async function runScan(scan: unknown): Promise<BgResponse<AnalysisResult>> {
		const listing = (scan as { listing?: unknown } | null)?.listing;
		if (typeof scan !== "object" || typeof listing !== "object" || !listing) {
			debugLog.group("scan en erreur", { code: "invalid_listing" });
			return fail("invalid_listing");
		}
		try {
			const body = toScanIn(scan as ScanRequest);
			debugLog.group("scan envoyé", body);
			const result = await api.scan(body);
			debugLog.group("scan reçu", { status: "ok", result });
			return ok(result);
		} catch (error) {
			// Le code seul : jamais le message ni les détails de l'erreur.
			debugLog.group("scan en erreur", {
				code: knownCode(error) ?? "internal_error",
			});
			throw error;
		}
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
			case "scan/run":
				return runScan(req.scan);
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
