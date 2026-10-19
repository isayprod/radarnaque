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
	/**
	 * Build de dev (`import.meta.env.DEV`). R5 : faux en production, `content/debug`
	 * répond faux et `scan/run` ne lit jamais `me` pour le debug (aucun échange de
	 * JWT ni `/api/me` de plus par réveil du service worker).
	 */
	devBuild: boolean;
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
	 * Debug du dernier `me` lu, lié au jeton de session utilisé pour le lire (R3). Un
	 * changement de jeton, quelle qu'en soit la cause (OTP, lien magique, déconnexion,
	 * `onUnauthenticated`), coupe les logs sans remise à zéro explicite.
	 */
	let debugFor: { token: string; debug: boolean } | null = null;
	/** Jeton lu juste avant chaque groupe de log : `enabled()` est synchrone. */
	let tokenForLog: string | null = null;
	// Seuls le corps `ScanIn`, le résultat et le code d'erreur y passent : jamais
	// d'en-tête, de JWT, de jeton de session ni de cookie.
	const debugLog = createDebugLog(
		() =>
			debugFor?.debug === true &&
			tokenForLog !== null &&
			debugFor.token === tokenForLog,
		deps.debugLog,
	);

	/** Écrit un groupe seulement si le jeton courant est celui du superuser vu. */
	async function logGroup(title: string, data: unknown): Promise<void> {
		// Compte ordinaire : pas même une lecture du stockage.
		if (!debugFor?.debug) return;
		try {
			tokenForLog = await sessionToken.getValue();
		} catch {
			tokenForLog = null;
		}
		debugLog.group(title, data);
	}

	async function storeSession(token: string | null): Promise<void> {
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

	/**
	 * `currentMe` qui met aussi à jour `debugFor`. Le jeton est lu avant l'appel ; si
	 * la session a changé pendant l'appel (déconnexion, nouveau jeton), le résultat
	 * n'est pas retenu pour le debug.
	 */
	async function trackedMe(): Promise<Me | null> {
		const token = await sessionToken.getValue();
		const me = await currentMe();
		const after = await sessionToken.getValue();
		if (token && after === token) {
			debugFor = me ? { token, debug: isDebug(accessOf(me)) } : null;
		}
		return me;
	}

	/**
	 * Après un réveil du service worker (ou un changement de session), `debugFor` ne
	 * correspond pas au jeton courant : une seule lecture de `me`, et seulement quand
	 * un scan est demandé. Un échec laisse les logs coupés.
	 */
	async function ensureDebugKnown(): Promise<void> {
		try {
			const token = await sessionToken.getValue();
			if (!token || debugFor?.token === token) return;
			await trackedMe();
		} catch {
			// Logs coupés ; le scan continue normalement.
		}
	}

	/**
	 * Drapeau des logs de debug de la page : le mécanisme des logs du service worker
	 * (`debugFor` lié au jeton courant, `me` lu au besoin par `ensureDebugKnown`).
	 * Sans session : faux, sans appel réseau.
	 */
	async function contentDebug(): Promise<BgResponse<boolean>> {
		// R5 : build de production, aucune lecture (ni stockage ni réseau).
		if (!deps.devBuild) return ok(false);
		await ensureDebugKnown();
		let token: string | null;
		try {
			token = await sessionToken.getValue();
		} catch {
			return ok(false);
		}
		return ok(
			token !== null && debugFor?.token === token && debugFor.debug === true,
		);
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
		// R5 : lecture paresseuse de `me` en dev seulement. En production, les logs
		// restent liés à un `me` superuser déjà lu pour une autre raison.
		if (deps.devBuild) await ensureDebugKnown();
		const listing = (scan as { listing?: unknown } | null)?.listing;
		if (typeof scan !== "object" || typeof listing !== "object" || !listing) {
			await logGroup("scan en erreur", { code: "invalid_listing" });
			return fail("invalid_listing");
		}
		try {
			const body = toScanIn(scan as ScanRequest);
			await logGroup("scan envoyé", body);
			const result = await api.scan(body);
			await logGroup("scan reçu", { outcome: "ok", result });
			return ok(result);
		} catch (error) {
			// Le code seul : jamais le message ni les détails de l'erreur.
			await logGroup("scan en erreur", {
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
			case "content/debug":
				return contentDebug();
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
