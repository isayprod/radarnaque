import type { Locale, Me } from "@radarnaque/shared";
import {
	type ChangeEvent,
	type FormEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { browser } from "wxt/browser";
import { Logo } from "../../components/Logo";
import { accessOf } from "../../lib/access";
import { PUBLIC_URL } from "../../lib/config";
import { isValidEmail, normalizeEmail } from "../../lib/email";
import { detectLocale, errorMessage, type MessageKey, t } from "../../lib/i18n";
import { type AuthState, sendToBackground } from "../../lib/messages";
import { localePref, pendingSignIn, sessionToken } from "../../lib/storage";
import { CodeInput } from "./CodeInput";

type View = "loading" | "unavailable" | "signedOut" | "codeSent" | "signedIn";

const OTP_LENGTH = 6;
/** Durée de validité du lien et du code (600 s). */
const PENDING_TTL_MS = 10 * 60_000;
const LOCALES: readonly Locale[] = ["fr", "nl"];

function browserLocale(): Locale {
	try {
		return detectLocale(browser.i18n.getUILanguage());
	} catch {
		return "fr";
	}
}

/**
 * Pilule blanche, action principale de la popup (DESIGN.md, boutons « Primary ») :
 * 44 px, texte sombre, ombre de la pilule, soulevée de 1 px au survol (sauf mouvement
 * réduit). Sans largeur : `w-full` à l'usage quand elle occupe toute la ligne.
 */
export const WHITE_PILL_CLASS =
	"inline-flex h-11 cursor-pointer items-center justify-center rounded-pill bg-white px-5 text-sm font-semibold whitespace-nowrap text-text-on-light no-underline shadow-[var(--shadow-pill)] transition-transform duration-[var(--dur-fast)] hover:-translate-y-px focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 motion-reduce:transition-none motion-reduce:hover:translate-y-0";

/** Champ de 36 px sur `--bg-1`, bordure `--border-default`, anneau de focus des tokens. */
export const INPUT_CLASS =
	"h-9 w-full rounded-sm border border-border-default bg-bg-1 px-3 text-sm text-text-1 placeholder:text-text-3 focus:shadow-[var(--focus-ring)] focus:outline-hidden read-only:opacity-60";

/** Lien ou bouton d'action secondaire : texte souligné `--text-1`. */
export const LINK_CLASS =
	"cursor-pointer rounded-xs text-[13px] font-medium text-text-1 underline underline-offset-2 hover:text-text-2 focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-60";

/** Étiquette au-dessus d'un champ. */
const LABEL_CLASS = "block text-xs font-medium text-text-2";

/** Titre d'écran : Instrument Serif 22 px (`display-s`). */
const TITLE_CLASS =
	"font-serif text-[22px] leading-[1.15] font-normal text-text-1";

/** Phrase d'accompagnement du titre. */
const LEAD_CLASS = "text-[13px] leading-[1.45] text-text-2";

/** Message de la zone `aria-live` : erreur ou confirmation. */
const MESSAGE_CLASS =
	"rounded-sm px-3 py-2 text-[13px] leading-[1.45] text-text-1";

export default function App() {
	const [locale, setLocale] = useState<Locale>(browserLocale);
	const [view, setView] = useState<View>("loading");
	const [me, setMe] = useState<Me | null>(null);
	const [email, setEmail] = useState("");
	const [sentTo, setSentTo] = useState("");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [errorCode, setErrorCode] = useState<string | null>(null);
	const [resent, setResent] = useState(false);
	// Compte supprimé : le message reste affiché sur l'écran de connexion.
	const [deleted, setDeleted] = useState(false);
	const emailRef = useRef<HTMLInputElement>(null);
	const codeRef = useRef<HTMLInputElement>(null);
	// Seule la dernière demande d'état compte (le watch du stockage en lance aussi).
	const latestState = useRef(0);
	// Garde synchrone : deux changements d'état avant le rendu ne doivent pas envoyer deux fois.
	const verifying = useRef(false);

	const refresh = useCallback(async () => {
		const id = ++latestState.current;
		const response = await sendToBackground<AuthState>({ type: "auth/state" });
		if (id !== latestState.current) return;
		if (!response.ok) {
			setErrorCode(response.error.code);
			setView("unavailable");
			return;
		}
		setErrorCode(null);
		if (response.data.status === "signedIn") {
			void pendingSignIn.setValue(null);
			setMe(response.data.me);
			setView("signedIn");
		} else {
			setMe(null);
			setView((current) => (current === "codeSent" ? current : "signedOut"));
		}
	}, []);

	useEffect(() => {
		let active = true;
		void (async () => {
			const preferred = await localePref.getValue();
			if (!active) return;
			if (preferred) setLocale(preferred);
			const pending = await pendingSignIn.getValue();
			if (!active) return;
			if (pending && Date.now() - pending.sentAt < PENDING_TTL_MS) {
				// Popup rouverte après être allé lire l'email : on reprend à l'étape du code.
				setEmail(pending.email);
				setSentTo(pending.email);
				setView("codeSent");
			} else if (pending) {
				void pendingSignIn.setValue(null);
			}
			await refresh();
		})();
		// La page de retour du lien magique enregistre le jeton pendant que la popup est ouverte.
		const unwatch = sessionToken.watch((token) => {
			if (token) {
				void refresh();
			} else {
				latestState.current++;
				setMe(null);
				setView((current) => (current === "signedIn" ? "signedOut" : current));
			}
		});
		return () => {
			active = false;
			unwatch();
		};
	}, [refresh]);

	useEffect(() => {
		if (view === "signedOut") emailRef.current?.focus();
		if (view === "codeSent") codeRef.current?.focus();
	}, [view]);

	function fail(code: string) {
		setErrorCode(code);
		if (code === "session_expired") {
			void pendingSignIn.setValue(null);
			setMe(null);
			setCode("");
			setView("signedOut");
		}
	}

	async function requestLink(address: string): Promise<boolean> {
		setBusy(true);
		const response = await sendToBackground<null>({
			type: "auth/start",
			email: address,
			locale,
		});
		setBusy(false);
		if (!response.ok) {
			fail(response.error.code);
			return false;
		}
		await pendingSignIn.setValue({ email: address, sentAt: Date.now() });
		return true;
	}

	async function onSubmitEmail(event: FormEvent) {
		event.preventDefault();
		if (busy) return;
		setErrorCode(null);
		setDeleted(false);
		const address = normalizeEmail(email);
		if (!isValidEmail(address)) {
			setErrorCode("invalid_email");
			return;
		}
		if (await requestLink(address)) {
			setEmail(address);
			setSentTo(address);
			setCode("");
			setResent(false);
			setView("codeSent");
		}
	}

	async function onResend() {
		if (busy) return;
		setErrorCode(null);
		setResent(false);
		setResent(await requestLink(sentTo));
	}

	function onChangeAddress() {
		void pendingSignIn.setValue(null);
		setErrorCode(null);
		setResent(false);
		setCode("");
		setEmail(sentTo);
		setView("signedOut");
	}

	async function verify(otp: string) {
		if (verifying.current) return;
		verifying.current = true;
		setBusy(true);
		setErrorCode(null);
		setResent(false);
		const response = await sendToBackground<null>({
			type: "auth/verify-otp",
			email: sentTo,
			otp,
		});
		if (!response.ok) {
			verifying.current = false;
			setBusy(false);
			setCode("");
			fail(response.error.code);
			codeRef.current?.focus();
			return;
		}
		// Le service worker a enregistré le jeton : on lit le compte.
		await refresh();
		verifying.current = false;
		setBusy(false);
	}

	function onChangeCode(event: ChangeEvent<HTMLInputElement>) {
		if (busy || verifying.current) return;
		const digits = event.target.value.replace(/\D/g, "").slice(0, OTP_LENGTH);
		setCode(digits);
		if (digits.length === OTP_LENGTH) void verify(digits);
	}

	async function onSignOut() {
		if (busy) return;
		setBusy(true);
		setErrorCode(null);
		const response = await sendToBackground<null>({ type: "auth/sign-out" });
		setBusy(false);
		if (!response.ok) {
			fail(response.error.code);
			return;
		}
		latestState.current++;
		void pendingSignIn.setValue(null);
		setMe(null);
		setEmail("");
		setView("signedOut");
	}

	async function onDeleted() {
		latestState.current++;
		void pendingSignIn.setValue(null);
		setMe(null);
		setEmail("");
		setErrorCode(null);
		setDeleted(true);
		setView("signedOut");
		// Relit l'état comme après une déconnexion (le service worker a déjà tout nettoyé).
		await refresh();
	}

	function chooseLocale(next: Locale) {
		setLocale(next);
		void localePref.setValue(next);
	}

	const tr = (key: MessageKey) => t(locale, key);

	let status: ReactNode = null;
	if (errorCode) {
		status = (
			<p className={`${MESSAGE_CLASS} bg-danger-soft`}>
				{errorMessage(locale, errorCode)}
			</p>
		);
	} else if (resent) {
		status = (
			<p className={`${MESSAGE_CLASS} bg-success-soft`}>{tr("code.resent")}</p>
		);
	}

	let content: ReactNode;
	switch (view) {
		case "loading":
			content = (
				<>
					{/* Squelette : ligne courte, panneau de 96 px, ligne longue. */}
					<div aria-hidden="true" className="space-y-3.5">
						<div className="rq-skeleton h-3 w-2/5 rounded-xs bg-bg-3" />
						<div className="rq-skeleton h-24 rounded-md bg-bg-3" />
						<div className="rq-skeleton h-3 w-4/5 rounded-xs bg-bg-3" />
					</div>
					<p className="sr-only">{tr("app.loading")}</p>
				</>
			);
			break;
		case "unavailable":
			content = (
				<>
					<div className="space-y-1.5">
						<h2 className={TITLE_CLASS}>{tr("app.unavailableTitle")}</h2>
						<p className={LEAD_CLASS}>{tr("app.unavailableText")}</p>
					</div>
					<button
						type="button"
						className={`${WHITE_PILL_CLASS} w-full`}
						onClick={() => {
							setErrorCode(null);
							setView("loading");
							void refresh();
						}}
					>
						{tr("app.retry")}
					</button>
				</>
			);
			break;
		case "signedOut":
			content = (
				<>
					<div className="space-y-1.5">
						<h2 className={TITLE_CLASS}>{tr("signin.title")}</h2>
						<p className={LEAD_CLASS}>{tr("signin.lead")}</p>
					</div>
					<form className="space-y-3.5" noValidate onSubmit={onSubmitEmail}>
						<div className="space-y-1.5">
							<label className={LABEL_CLASS} htmlFor="email">
								{tr("email.label")}
							</label>
							<input
								ref={emailRef}
								id="email"
								type="email"
								autoComplete="email"
								inputMode="email"
								className={INPUT_CLASS}
								placeholder={tr("email.placeholder")}
								value={email}
								onChange={(event) => setEmail(event.target.value)}
							/>
						</div>
						<button
							type="submit"
							className={`${WHITE_PILL_CLASS} w-full`}
							disabled={busy}
						>
							{busy ? tr("email.sending") : tr("email.submit")}
						</button>
						<p className="text-xs leading-[1.45] text-text-2">
							{tr("signin.note")}
						</p>
					</form>
				</>
			);
			break;
		case "codeSent":
			content = (
				<>
					<div className="space-y-1.5">
						<h2 className={TITLE_CLASS}>{tr("code.title")}</h2>
						<p className={LEAD_CLASS}>{tr("code.instructions")}</p>
					</div>
					<p className="text-xs text-text-2">
						{tr("code.sentTo")}{" "}
						<strong className="font-semibold break-all text-text-1">
							{sentTo}
						</strong>
					</p>
					<div className="space-y-1.5">
						<label className={LABEL_CLASS} htmlFor="code">
							{tr("code.label")}
						</label>
						<CodeInput
							id="code"
							value={code}
							busy={busy}
							onChange={onChangeCode}
							inputRef={codeRef}
						/>
					</div>
					{busy && (
						<p className="text-xs text-text-2">{tr("code.verifying")}</p>
					)}
					<div className="flex items-center justify-between">
						<button
							type="button"
							className={LINK_CLASS}
							disabled={busy}
							onClick={onResend}
						>
							{tr("code.resend")}
						</button>
						<button
							type="button"
							className={LINK_CLASS}
							disabled={busy}
							onClick={onChangeAddress}
						>
							{tr("code.changeEmail")}
						</button>
					</div>
				</>
			);
			break;
		case "signedIn":
			content = me ? (
				<Account
					me={me}
					locale={locale}
					busy={busy}
					onSignOut={onSignOut}
					onDeleted={onDeleted}
					onSessionExpired={() => fail("session_expired")}
				/>
			) : null;
			break;
	}

	// Pied : « Formules » partout, sauf sur l'écran du compte (sa barre d'actions y mène).
	const footerLinks: FooterLink[] = [
		{
			href: `${PUBLIC_URL}/privacy/?lang=${locale}`,
			label: tr("privacy.link"),
		},
	];
	if (view !== "signedIn") {
		footerLinks.push({
			href: `${PUBLIC_URL}/pricing/?lang=${locale}`,
			label: tr("footer.pricing"),
		});
	}

	return (
		<div className="flex max-h-[600px] flex-col">
			<PopupHeader locale={locale} onLocale={chooseLocale} />
			{/* Seule la zone de contenu défile : l'en-tête et le pied restent fixes. */}
			<main className="min-h-0 flex-1 space-y-3.5 overflow-y-auto p-4">
				{content}
				<div aria-live="polite" className="space-y-2">
					{deleted && (
						<p className={`${MESSAGE_CLASS} bg-success-soft`}>
							{tr("delete.success")}
						</p>
					)}
					{status}
				</div>
			</main>
			<PopupFooter links={footerLinks} />
		</div>
	);
}

/**
 * En-tête de 60 px : dégradé compact, logo blanc et « Radarnaque » en serif à gauche,
 * choix FR/NL en contrôle segmenté pilule à droite (`aria-pressed`), filet de 1 px
 * en dégradé dessous.
 */
export function PopupHeader({
	locale,
	onLocale,
}: {
	locale: Locale;
	onLocale: (locale: Locale) => void;
}) {
	return (
		<>
			<header className="flex h-15 shrink-0 items-center justify-between bg-[image:var(--gradient-compact)] px-4">
				<div className="flex items-center gap-2 text-white">
					<Logo size={22} />
					<h1 className="font-serif text-[22px] leading-none font-normal">
						Radarnaque
					</h1>
				</div>
				{/* Fond navy translucide : texte blanc lisible jusque sur le lilas du dégradé. */}
				<fieldset className="m-0 flex gap-0.5 rounded-pill border-0 bg-bg-0/50 p-0.5">
					<legend className="sr-only">{t(locale, "locale.label")}</legend>
					{LOCALES.map((option) => (
						<button
							key={option}
							type="button"
							aria-pressed={locale === option}
							className={`h-7 cursor-pointer rounded-pill px-3 text-xs font-semibold focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-hidden ${
								locale === option
									? "bg-white text-text-on-light"
									: "text-white hover:bg-white/10"
							}`}
							onClick={() => onLocale(option)}
						>
							{option.toUpperCase()}
						</button>
					))}
				</fieldset>
			</header>
			<div
				aria-hidden="true"
				className="h-px shrink-0 bg-[image:var(--gradient-hairline)]"
			/>
		</>
	);
}

export type FooterLink = { href: string; label: string };

/** Pied : liens soulignés en `text-xs`, ouverts dans un nouvel onglet. */
export function PopupFooter({ links }: { links: readonly FooterLink[] }) {
	return (
		<footer className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-3 text-xs">
			{links.map((link) => (
				<a
					key={link.href}
					href={link.href}
					target="_blank"
					rel="noopener noreferrer"
					className="rounded-xs text-text-2 underline underline-offset-2 hover:text-text-1 focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-hidden"
				>
					{link.label}
				</a>
			))}
		</footer>
	);
}

function planName(me: Me, locale: Locale): string {
	// Rôle renvoyé par l'API hors production seulement (sinon `user`). Le superuser
	// y est vu en Premium : son plan suit le rôle.
	if (me.role === "superuser") {
		const superuser = t(locale, "plan.superuser");
		return me.plan === null
			? superuser
			: `${superuser} — ${offerName(me.plan, locale)}`;
	}
	if (me.unlimited) return t(locale, "plan.unlimited");
	return offerName(me.plan, locale);
}

function offerName(plan: string | null, locale: Locale): string {
	switch (plan) {
		case "trial":
			return t(locale, "plan.trial");
		case "standard":
			return t(locale, "plan.standard");
		case "premium":
			return t(locale, "plan.premium");
		default:
			return t(locale, "plan.none");
	}
}

/** « N analyses IA restantes », au singulier selon la langue (« 0 analyse » en FR). */
function scansLeft(count: number, locale: Locale): string {
	const one = new Intl.PluralRules(locale).select(count) === "one";
	return t(locale, one ? "account.scansLeftOne" : "account.scansLeft").replace(
		"{count}",
		String(count),
	);
}

function Account({
	me,
	locale,
	busy,
	onSignOut,
	onDeleted,
	onSessionExpired,
}: {
	me: Me;
	locale: Locale;
	busy: boolean;
	onSignOut: () => void;
	onDeleted: () => void;
	onSessionExpired: () => void;
}) {
	// Suppression en cours : la déconnexion attend (et inversement, `busy`), pour qu'une
	// déconnexion ne passe pas pour un compte supprimé.
	const [deleting, setDeleting] = useState(false);
	// Une seule analyse (`full`) : son quota, limité par le plafond de l'essai ;
	// rien pour un compte illimité (admin, superuser) ou sans abonnement.
	const access = accessOf(me);
	const remaining = access.status === "active" ? access.remaining.scans : null;

	return (
		<div className="space-y-4">
			<div className="space-y-1">
				<p className="break-all text-sm text-slate-600">{me.email}</p>
				<p className="inline-block rounded-full bg-brand-50 px-3 py-1 text-sm font-semibold text-brand-700">
					{planName(me, locale)}
				</p>
			</div>
			{remaining !== null && (
				<p className="rounded-lg border border-slate-200 px-3 py-2 text-sm tabular-nums">
					{scansLeft(remaining, locale)}
				</p>
			)}
			<button
				type="button"
				className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60"
				disabled={busy || deleting}
				onClick={onSignOut}
			>
				{t(locale, "action.signOut")}
			</button>
			<DeleteAccount
				locale={locale}
				disabled={busy}
				onPendingChange={setDeleting}
				onDeleted={onDeleted}
				onSessionExpired={onSessionExpired}
			/>
		</div>
	);
}

/** Message d'échec : serveur injoignable (la suppression a pu avoir lieu), ou refus. */
function deleteFailure(locale: Locale, code: string): string {
	return code === "network" || code === "background_unavailable"
		? t(locale, "delete.unreachable")
		: t(locale, "delete.failure");
}

/**
 * Section repliable « Supprimer mon compte » : confirmation tapée, puis `account/delete`.
 * `disabled` : une déconnexion est en cours.
 */
function DeleteAccount({
	locale,
	disabled,
	onPendingChange,
	onDeleted,
	onSessionExpired,
}: {
	locale: Locale;
	disabled: boolean;
	onPendingChange: (pending: boolean) => void;
	onDeleted: () => void;
	/** Session refusée avant tout envoi : rien n'est supprimé, la popup se déconnecte. */
	onSessionExpired: () => void;
}) {
	const [typed, setTyped] = useState("");
	const [pending, setPending] = useState(false);
	const [failedCode, setFailedCode] = useState<string | null>(null);
	// Garde synchrone : deux clics avant le rendu ne doivent envoyer qu'une demande.
	const sending = useRef(false);

	const confirmed =
		typed.trim().toLocaleUpperCase(locale) === t(locale, "delete.word");

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		if (!confirmed || disabled || sending.current) return;
		sending.current = true;
		setPending(true);
		onPendingChange(true);
		setFailedCode(null);
		const response = await sendToBackground<null>({ type: "account/delete" });
		if (!response.ok) {
			sending.current = false;
			setPending(false);
			onPendingChange(false);
			if (response.error.code === "session_expired") {
				onSessionExpired();
				return;
			}
			setFailedCode(response.error.code);
			return;
		}
		// Le composant disparaît avec l'écran du compte : la garde reste donc fermée.
		onDeleted();
	}

	return (
		<details className="rounded-lg border border-slate-200 px-3 py-2">
			<summary className="cursor-pointer text-sm font-medium text-slate-700">
				{t(locale, "delete.title")}
			</summary>
			<form className="mt-3 space-y-3" noValidate onSubmit={onSubmit}>
				<p className="text-xs text-slate-600">
					{t(locale, "delete.explanation")}
				</p>
				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="delete-confirm">
						{t(locale, "delete.prompt")}
					</label>
					<input
						id="delete-confirm"
						type="text"
						autoComplete="off"
						autoCapitalize="characters"
						spellCheck={false}
						className={INPUT_CLASS}
						value={typed}
						readOnly={pending}
						onChange={(event) => setTyped(event.target.value)}
					/>
				</div>
				<button
					type="submit"
					className="w-full rounded-lg bg-red-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:cursor-not-allowed disabled:opacity-60"
					disabled={!confirmed || pending || disabled}
				>
					{pending
						? t(locale, "delete.submitting")
						: t(locale, "delete.submit")}
				</button>
				{failedCode && (
					<p role="alert" className="text-sm text-red-700">
						{deleteFailure(locale, failedCode)}
					</p>
				)}
			</form>
		</details>
	);
}
