import { type FormEvent, useEffect, useId, useRef, useState } from "react";

const buttonBase =
	"rounded-lg px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60";

const FOCUSABLE = "button:not(:disabled), input:not(:disabled)";

/**
 * Confirmation modale d'une action. `typedConfirmation` : le bouton reste désactivé tant que
 * la saisie n'est pas identique. Un seul envoi, même en double clic.
 *
 * Clavier : à l'ouverture le focus va à la saisie (sinon à « Annuler ») ; Échap ferme (sauf
 * pendant l'envoi) ; Tab et Maj+Tab restent dans la boîte ; à la fermeture le focus revient
 * à l'élément qui l'avait. `onConfirm` gère ses erreurs lui-même et ferme la boîte en la
 * retirant : une promesse rejetée n'est pas rattrapée ici.
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
	const sending = useRef(false);
	const dialog = useRef<HTMLFormElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const cancel = useRef<HTMLButtonElement>(null);
	// Les écouteurs du document lisent l'état courant sans être réinstallés à chaque frappe.
	const live = useRef({ busy, onCancel: props.onCancel });
	live.current = { busy, onCancel: props.onCancel };
	const titleId = useId();
	const inputId = useId();
	const ready = typedConfirmation === undefined || typed === typedConfirmation;

	useEffect(() => {
		const opener = document.activeElement;
		(input.current ?? cancel.current)?.focus();

		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				if (!live.current.busy) live.current.onCancel();
				return;
			}
			if (event.key !== "Tab" || dialog.current === null) return;
			const items = [
				...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE),
			];
			if (items.length === 0) {
				event.preventDefault();
				return;
			}
			const first = items[0];
			const last = items[items.length - 1];
			const active = document.activeElement;
			const inside = active !== null && dialog.current.contains(active);
			if (event.shiftKey && (!inside || active === first)) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && (!inside || active === last)) {
				event.preventDefault();
				first.focus();
			}
		}

		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
		};
	}, []);

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!ready || sending.current) return;
		sending.current = true;
		setBusy(true);
		try {
			await props.onConfirm();
		} finally {
			sending.current = false;
			setBusy(false);
		}
	}

	return (
		<div className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4">
			<form
				ref={dialog}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				noValidate
				onSubmit={submit}
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
							ref={input}
							id={inputId}
							autoComplete="off"
							value={typed}
							onChange={(event) => setTyped(event.target.value)}
							className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-brand-600"
						/>
					</div>
				)}
				<div className="flex justify-end gap-2">
					<button
						ref={cancel}
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
