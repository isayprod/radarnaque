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
import { isValidEmail, normalizeEmail } from "../../lib/email";
import { detectLocale, errorMessage, type MessageKey, t } from "../../lib/i18n";
import { type AuthState, sendToBackground } from "../../lib/messages";
import { localePref, sessionToken } from "../../lib/storage";

type View = "loading" | "unavailable" | "signedOut" | "codeSent" | "signedIn";

const OTP_LENGTH = 6;
const LOCALES: readonly Locale[] = ["fr", "nl"];

function browserLocale(): Locale {
	try {
		return detectLocale(browser.i18n.getUILanguage());
	} catch {
		return "fr";
	}
}

const primaryButton =
	"w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60";
const linkButton =
	"text-sm font-medium text-brand-600 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60";
const inputClass =
	"w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-brand-600";

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
	const emailRef = useRef<HTMLInputElement>(null);
	const codeRef = useRef<HTMLInputElement>(null);
	// Seule la dernière demande d'état compte (le watch du stockage en lance aussi).
	const latestState = useRef(0);

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
		return true;
	}

	async function onSubmitEmail(event: FormEvent) {
		event.preventDefault();
		if (busy) return;
		setErrorCode(null);
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
		setErrorCode(null);
		setResent(false);
		setCode("");
		setEmail(sentTo);
		setView("signedOut");
	}

	async function verify(otp: string) {
		setBusy(true);
		setErrorCode(null);
		setResent(false);
		const response = await sendToBackground<null>({
			type: "auth/verify-otp",
			email: sentTo,
			otp,
		});
		if (!response.ok) {
			setBusy(false);
			setCode("");
			fail(response.error.code);
			codeRef.current?.focus();
			return;
		}
		// Le service worker a enregistré le jeton : on lit le compte.
		await refresh();
		setBusy(false);
	}

	function onChangeCode(event: ChangeEvent<HTMLInputElement>) {
		if (busy) return;
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
		setMe(null);
		setEmail("");
		setView("signedOut");
	}

	function chooseLocale(next: Locale) {
		setLocale(next);
		void localePref.setValue(next);
	}

	const tr = (key: MessageKey) => t(locale, key);

	let status: ReactNode = null;
	if (errorCode) {
		status = (
			<span className="text-red-700">{errorMessage(locale, errorCode)}</span>
		);
	} else if (resent) {
		status = <span className="text-emerald-700">{tr("code.resent")}</span>;
	}

	let content: ReactNode;
	switch (view) {
		case "loading":
			content = <p className="text-sm text-slate-500">{tr("app.loading")}</p>;
			break;
		case "unavailable":
			content = (
				<button
					type="button"
					className={linkButton}
					onClick={() => {
						setErrorCode(null);
						setView("loading");
						void refresh();
					}}
				>
					{tr("app.retry")}
				</button>
			);
			break;
		case "signedOut":
			content = (
				<form className="space-y-3" noValidate onSubmit={onSubmitEmail}>
					<div className="space-y-1">
						<label className="text-sm font-medium" htmlFor="email">
							{tr("email.label")}
						</label>
						<input
							ref={emailRef}
							id="email"
							type="email"
							autoComplete="email"
							inputMode="email"
							className={inputClass}
							placeholder={tr("email.placeholder")}
							value={email}
							onChange={(event) => setEmail(event.target.value)}
						/>
					</div>
					<button type="submit" className={primaryButton} disabled={busy}>
						{busy ? tr("email.sending") : tr("email.submit")}
					</button>
				</form>
			);
			break;
		case "codeSent":
			content = (
				<div className="space-y-3">
					<p className="text-sm">{tr("code.instructions")}</p>
					<p className="text-xs text-slate-500">
						{tr("code.sentTo")}{" "}
						<strong className="font-semibold text-slate-700">{sentTo}</strong>
					</p>
					<div className="space-y-1">
						<label className="text-sm font-medium" htmlFor="code">
							{tr("code.label")}
						</label>
						<input
							ref={codeRef}
							id="code"
							type="text"
							inputMode="numeric"
							autoComplete="one-time-code"
							pattern="[0-9]*"
							maxLength={OTP_LENGTH}
							readOnly={busy}
							className={`${inputClass} text-center font-mono text-lg tracking-[0.5em]`}
							value={code}
							onChange={onChangeCode}
						/>
					</div>
					{busy && (
						<p className="text-xs text-slate-500">{tr("code.verifying")}</p>
					)}
					<div className="flex items-center justify-between">
						<button
							type="button"
							className={linkButton}
							disabled={busy}
							onClick={onResend}
						>
							{tr("code.resend")}
						</button>
						<button
							type="button"
							className={linkButton}
							disabled={busy}
							onClick={onChangeAddress}
						>
							{tr("code.changeEmail")}
						</button>
					</div>
				</div>
			);
			break;
		case "signedIn":
			content = me ? (
				<Account me={me} locale={locale} busy={busy} onSignOut={onSignOut} />
			) : null;
			break;
	}

	return (
		<main className="space-y-4 p-4">
			<header className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<img src="/icon-with-shadow.svg" alt="" width={28} height={28} />
					<h1 className="text-base font-semibold">Radarnaque</h1>
				</div>
				<fieldset className="m-0 flex overflow-hidden rounded-md border border-slate-300 p-0 text-xs font-semibold">
					<legend className="sr-only">{tr("locale.label")}</legend>
					{LOCALES.map((option) => (
						<button
							key={option}
							type="button"
							aria-pressed={locale === option}
							className={`px-2 py-1 focus-visible:outline-2 focus-visible:outline-brand-600 ${
								locale === option
									? "bg-brand-600 text-white"
									: "bg-white text-slate-700 hover:bg-slate-100"
							}`}
							onClick={() => chooseLocale(option)}
						>
							{option.toUpperCase()}
						</button>
					))}
				</fieldset>
			</header>
			{content}
			<div aria-live="polite" className="min-h-5 text-sm">
				{status}
			</div>
		</main>
	);
}

function planName(me: Me, locale: Locale): string {
	if (me.unlimited) return t(locale, "plan.unlimited");
	switch (me.plan) {
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

function Account({
	me,
	locale,
	busy,
	onSignOut,
}: {
	me: Me;
	locale: Locale;
	busy: boolean;
	onSignOut: () => void;
}) {
	const rows: Array<{ label: string; remaining: number }> = me.unlimited
		? []
		: me.quotas.map((quota) => ({
				label: t(
					locale,
					quota.scanKind === "image" ? "scan.image" : "scan.text",
				),
				remaining: quota.remaining,
			}));
	if (!me.unlimited && me.totalCap) {
		rows.push({
			label: t(locale, "account.totalCap"),
			remaining: me.totalCap.remaining,
		});
	}

	return (
		<div className="space-y-4">
			<div className="space-y-1">
				<p className="break-all text-sm text-slate-600">{me.email}</p>
				<p className="inline-block rounded-full bg-brand-50 px-3 py-1 text-sm font-semibold text-brand-700">
					{planName(me, locale)}
				</p>
			</div>
			{rows.length > 0 && (
				<section aria-labelledby="remaining-title" className="space-y-2">
					<h2 id="remaining-title" className="text-sm font-semibold">
						{t(locale, "account.remaining")}
					</h2>
					<ul className="divide-y divide-slate-200 rounded-lg border border-slate-200">
						{rows.map((row) => (
							<li
								key={row.label}
								className="flex items-center justify-between px-3 py-2 text-sm"
							>
								<span>{row.label}</span>
								<strong className="tabular-nums">{row.remaining}</strong>
							</li>
						))}
					</ul>
				</section>
			)}
			<button
				type="button"
				className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60"
				disabled={busy}
				onClick={onSignOut}
			>
				{t(locale, "action.signOut")}
			</button>
		</div>
	);
}
