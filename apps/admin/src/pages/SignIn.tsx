import { type FormEvent, useEffect, useRef, useState } from "react";
import { AuthError, startSignIn, verifyCode } from "../auth";
import { useSession } from "../session";

const primaryButton =
	"w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60";
const linkButton =
	"text-sm font-medium text-brand-600 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60";
const inputClass =
	"w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-brand-600";

const LINK_ERROR = "Lien expiré ou déjà utilisé. Demandez un nouveau code.";

function messageOf(error: unknown): string {
	if (error instanceof AuthError) {
		if (error.code === "rate_limited") {
			return "Trop de demandes, réessayez plus tard.";
		}
		if (error.code === "invalid_code") return "Code invalide ou expiré.";
	}
	return "Service indisponible, réessayez plus tard.";
}

export function SignIn({ linkError }: { linkError: boolean }) {
	const { refresh } = useSession();
	const [email, setEmail] = useState("");
	const [sentTo, setSentTo] = useState<string | null>(null);
	const [code, setCode] = useState("");
	const [error, setError] = useState<string | null>(
		linkError ? LINK_ERROR : null,
	);
	const [busy, setBusy] = useState(false);
	const codeRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (sentTo) codeRef.current?.focus();
	}, [sentTo]);

	async function onSubmitEmail(event: FormEvent) {
		event.preventDefault();
		const normalized = email.trim().toLowerCase();
		if (!normalized || busy) return;
		setBusy(true);
		setError(null);
		try {
			await startSignIn(normalized);
			setSentTo(normalized);
		} catch (e) {
			setError(messageOf(e));
		} finally {
			setBusy(false);
		}
	}

	async function onSubmitCode(event: FormEvent) {
		event.preventDefault();
		if (!sentTo || code.length !== 6 || busy) return;
		setBusy(true);
		setError(null);
		try {
			await verifyCode(sentTo, code);
			await refresh();
		} catch (e) {
			setError(messageOf(e));
			setBusy(false);
		}
	}

	return (
		<main className="mx-auto max-w-sm space-y-4 p-6">
			<h1 className="text-xl font-semibold">Radarnaque, administration</h1>
			{sentTo === null ? (
				<form className="space-y-3" noValidate onSubmit={onSubmitEmail}>
					<div className="space-y-1">
						<label className="text-sm font-medium" htmlFor="email">
							Adresse email
						</label>
						<input
							id="email"
							type="email"
							autoComplete="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							className={inputClass}
						/>
					</div>
					<button type="submit" className={primaryButton} disabled={busy}>
						Recevoir un code
					</button>
				</form>
			) : (
				<form className="space-y-3" noValidate onSubmit={onSubmitCode}>
					<p className="text-sm">
						Un code à 6 chiffres a été envoyé à{" "}
						<strong className="font-semibold">{sentTo}</strong>.
					</p>
					<p className="text-xs text-slate-500">
						Vous pouvez aussi cliquer sur le lien reçu par email.
					</p>
					<div className="space-y-1">
						<label className="text-sm font-medium" htmlFor="code">
							Code à 6 chiffres
						</label>
						<input
							id="code"
							ref={codeRef}
							inputMode="numeric"
							autoComplete="one-time-code"
							maxLength={6}
							value={code}
							onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
							className={`${inputClass} text-center font-mono text-lg tracking-[0.5em]`}
						/>
					</div>
					<button
						type="submit"
						className={primaryButton}
						disabled={busy || code.length !== 6}
					>
						Se connecter
					</button>
					<button
						type="button"
						className={linkButton}
						disabled={busy}
						onClick={() => {
							setSentTo(null);
							setCode("");
							setError(null);
						}}
					>
						Changer d'adresse
					</button>
				</form>
			)}
			<div aria-live="polite" className="min-h-5 text-sm">
				{error && <p className="text-red-700">{error}</p>}
			</div>
		</main>
	);
}
