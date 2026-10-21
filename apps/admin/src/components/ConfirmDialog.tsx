import { type FormEvent, useId, useRef, useState } from "react";

const buttonBase =
	"rounded-lg px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Confirmation modale d'une action. `typedConfirmation` : le bouton reste désactivé tant que
 * la saisie n'est pas identique. Un seul envoi, même en double clic ; si `onConfirm` échoue,
 * le message s'affiche ici et l'action peut être relancée (l'appelant gère ses propres
 * erreurs et ferme la boîte en retirant le composant).
 */
export function ConfirmDialog(props: {
	title: string;
	message: string;
	confirmLabel: string;
	typedConfirmation?: string;
	onConfirm: () => Promise<void>;
	onCancel: () => void;
}) {
	const { title, message, confirmLabel, typedConfirmation } = props;
	const [typed, setTyped] = useState("");
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const sending = useRef(false);
	const titleId = useId();
	const inputId = useId();
	const ready = typedConfirmation === undefined || typed === typedConfirmation;

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!ready || sending.current) return;
		sending.current = true;
		setBusy(true);
		setFailed(false);
		try {
			await props.onConfirm();
		} catch {
			setFailed(true);
		} finally {
			sending.current = false;
			setBusy(false);
		}
	}

	return (
		<div className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4">
			<form
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				noValidate
				onSubmit={submit}
				onKeyDown={(event) => {
					if (event.key === "Escape" && !busy) props.onCancel();
				}}
				className="w-full max-w-md space-y-4 rounded-xl bg-white p-6 shadow-lg"
			>
				<h2 id={titleId} className="text-lg font-semibold">
					{title}
				</h2>
				<p className="text-sm text-slate-700">{message}</p>
				{typedConfirmation !== undefined && (
					<div className="space-y-1">
						<label className="text-sm font-medium" htmlFor={inputId}>
							Saisissez <strong>{typedConfirmation}</strong> pour confirmer
						</label>
						<input
							id={inputId}
							// biome-ignore lint/a11y/noAutofocus: la saisie est le premier geste de la boîte
							autoFocus
							autoComplete="off"
							value={typed}
							onChange={(event) => setTyped(event.target.value)}
							className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-brand-600"
						/>
					</div>
				)}
				<div aria-live="polite" className="min-h-5 text-sm">
					{failed && (
						<p className="text-red-700">L'action a échoué, réessayez.</p>
					)}
				</div>
				<div className="flex justify-end gap-2">
					<button
						type="button"
						onClick={props.onCancel}
						disabled={busy}
						className={`${buttonBase} border border-slate-300 text-slate-700 hover:bg-slate-100`}
					>
						Annuler
					</button>
					<button
						type="submit"
						disabled={!ready || busy}
						className={`${buttonBase} bg-brand-600 text-white hover:bg-brand-700`}
					>
						{confirmLabel}
					</button>
				</div>
			</form>
		</div>
	);
}
