import {
	type ChangeEvent,
	type RefObject,
	type SyntheticEvent,
	useState,
} from "react";

const CELLS = 6;

/** Case du code : 44 × 52 px, chiffre en serif 28 px. */
const CELL_CLASS =
	"flex h-13 w-11 items-center justify-center rounded-sm border border-border-default bg-bg-1 font-serif text-[28px] leading-none text-text-1 tabular-nums";

/** Case courante quand le champ a le focus : anneau de focus des tokens. */
const CURRENT_CELL_CLASS = "border-transparent shadow-[var(--focus-ring)]";

/**
 * Le champ étant invisible, un clic ou une flèche pourrait placer le curseur au
 * milieu du code : un chiffre tapé s'insérerait alors sans que les cases le
 * montrent à sa place. Le curseur est ramené en fin de saisie (au focus, au clic,
 * à chaque changement de sélection), sauf si la sélection couvre tout le code :
 * « tout sélectionner » puis taper, coller ou effacer doit remplacer le code, pas
 * s'y ajouter (un code collé à la suite serait tronqué à 6 chiffres, donc faux).
 */
function caretToEnd(event: SyntheticEvent<HTMLInputElement>) {
	const input = event.currentTarget;
	const end = input.value.length;
	const { selectionStart: start, selectionEnd: stop } = input;
	if (end > 0 && start === 0 && stop === end) return;
	// Condition nécessaire : `setSelectionRange` émet lui-même un `select`.
	if (start !== end || stop !== end) input.setSelectionRange(end, end);
}

/**
 * Code à 6 chiffres en six cases. C'est un habillage : un seul `<input>` (celui que
 * l'étiquette nomme) reçoit la frappe, le collage et le remplissage automatique ; il
 * couvre les cases, invisible (opacité nulle : ni texte, ni curseur, ni le fond que
 * le navigateur donne à un champ rempli automatiquement), mais focalisable. Les cases, décoratives
 * (`aria-hidden`), affichent `value[i]` ; la case courante (`value.length`, bornée
 * à la dernière) porte l'anneau de focus tant que le champ a le focus.
 * Pas de `maxLength` : « 123 456 » collé serait tronqué avant que `onChange` n'en
 * extraie les chiffres.
 */
export function CodeInput({
	id,
	value,
	busy,
	onChange,
	inputRef,
}: {
	id: string;
	value: string;
	busy: boolean;
	onChange(event: ChangeEvent<HTMLInputElement>): void;
	inputRef: RefObject<HTMLInputElement | null>;
}) {
	const [focused, setFocused] = useState(false);
	const current = Math.min(value.length, CELLS - 1);

	return (
		<div className="relative w-fit">
			<div aria-hidden="true" className="flex gap-2">
				{Array.from({ length: CELLS }, (_, index) => (
					<span
						// Positions fixes : l'index est la clé.
						// biome-ignore lint/suspicious/noArrayIndexKey: six cases immuables
						key={index}
						data-code-cell=""
						className={
							focused && index === current
								? `${CELL_CLASS} ${CURRENT_CELL_CLASS}`
								: CELL_CLASS
						}
					>
						{value[index] ?? ""}
					</span>
				))}
			</div>
			<input
				ref={inputRef}
				id={id}
				type="text"
				inputMode="numeric"
				autoComplete="one-time-code"
				pattern="[0-9]*"
				readOnly={busy}
				className="absolute inset-0 h-full w-full cursor-text appearance-none border-0 p-0 opacity-0 outline-hidden"
				value={value}
				onChange={onChange}
				onFocus={(event) => {
					setFocused(true);
					caretToEnd(event);
				}}
				onBlur={() => setFocused(false)}
				onClick={caretToEnd}
				onSelect={caretToEnd}
			/>
		</div>
	);
}
