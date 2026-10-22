import { useEffect, useRef, useState } from "react";

/** Sans nouvel événement pendant ce délai, la ligne d'état montre des points animés. */
export const WAITING_MS = 4_000;

/** La région `aria-live` est mise à jour au plus une fois par intervalle. */
export const ANNOUNCE_MS = 2_000;

/** Icône qui tourne (analyse en cours) ; fixe si l'utilisateur réduit les animations. */
export function Spinner({ size = 12 }: { size?: number }) {
	return (
		<svg
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			className="radarnaque-spin shrink-0 text-slate-600"
		>
			<circle
				cx="8"
				cy="8"
				r="6"
				stroke="currentColor"
				strokeOpacity="0.25"
				strokeWidth="2"
			/>
			<path
				d="M14 8a6 6 0 0 0-6-6"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
			/>
		</svg>
	);
}

/**
 * Vrai quand aucun événement n'est arrivé depuis `WAITING_MS` (`lastAt` : heure du
 * dernier événement, ou du départ). Un nouvel événement le remet à faux aussitôt.
 */
export function useWaiting(lastAt: number, active: boolean): boolean {
	const [waitingSince, setWaitingSince] = useState<number | null>(null);
	useEffect(() => {
		if (!active) return;
		const delay = Math.max(0, lastAt + WAITING_MS - Date.now());
		const timer = setTimeout(() => setWaitingSince(lastAt), delay);
		return () => clearTimeout(timer);
	}, [lastAt, active]);
	return active && waitingSince === lastAt;
}

/**
 * `text`, mis à jour au plus une fois toutes les `ms` : le premier changement passe
 * aussitôt, les suivants attendent la fin de l'intervalle et seul le plus récent est
 * rendu. Pour un `aria-live` qui ne doit pas inonder un lecteur d'écran.
 */
export function useThrottled(text: string, ms = ANNOUNCE_MS): string {
	const [shown, setShown] = useState(text);
	const lastRef = useRef(Number.NEGATIVE_INFINITY);
	useEffect(() => {
		if (text === shown) return;
		const apply = () => {
			lastRef.current = Date.now();
			setShown(text);
		};
		const wait = lastRef.current + ms - Date.now();
		if (wait <= 0) {
			apply();
			return;
		}
		const timer = setTimeout(apply, wait);
		return () => clearTimeout(timer);
	}, [text, shown, ms]);
	return shown;
}

/**
 * Ligne d'état visible : un fondu à chaque nouveau texte, et des points de suspension
 * animés (`is-waiting`) pendant une attente. Masquée aux lecteurs d'écran, qui ont
 * leur propre région `aria-live` ralentie.
 */
export function LiveLine({
	text,
	waiting,
}: {
	text: string;
	waiting: boolean;
}) {
	return (
		<span
			aria-hidden="true"
			className={`radarnaque-status inline-flex min-w-0 max-w-[340px] items-baseline font-normal text-slate-700${waiting ? " is-waiting" : ""}`}
		>
			{/* Nouvelle clé à chaque texte : le fondu rejoue. */}
			<span key={text} className="radarnaque-fade truncate">
				{text}
			</span>
		</span>
	);
}
