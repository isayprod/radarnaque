import type { components } from "@radarnaque/shared";
import { formatUsd } from "../format";

type DailyPoint = components["schemas"]["DailyPointOut"];

const WIDTH = 760;
const HEIGHT = 280;
const MARGIN = { top: 12, right: 64, bottom: 28, left: 40 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;

// Couleurs distinctes aussi sans la teinte (cache clair, appel foncé, échec rouge, coût ambre).
const COLORS = {
	fromCache: "#38bdf8",
	llm: "#4338ca",
	failed: "#dc2626",
	cost: "#b45309",
};

const SERIES = [
	{ key: "fromCache", label: "Depuis le cache" },
	{ key: "llm", label: "Avec appel au modèle" },
	{ key: "failed", label: "En échec" },
] as const;

/** « 2026-10-21 » → « 21/10 ». */
function shortDate(date: string): string {
	const [, month, day] = date.split("-");
	return `${day}/${month}`;
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count > 1 ? "s" : ""}`;
}

function barTitle(point: DailyPoint): string {
	return `${shortDate(point.date)} : ${point.fromCache} cache, ${plural(point.llm, "appel")}, ${plural(point.failed, "échec")}, ${formatUsd(point.costUsd)}`;
}

/** Plus petit nombre pair au moins égal à `value` (au moins 2) : l'axe se coupe en deux sans fraction. */
function evenCeil(value: number): number {
	return Math.max(2, Math.ceil(value / 2) * 2);
}

/**
 * Analyses par jour en barres empilées (cache, appel, échec) et coût du jour en ligne sur l'axe
 * de droite. Un scan sans issue compte dans la carte « Analyses » mais dans aucune série : une
 * barre peut donc être plus courte que le total du jour. Le SVG est une image pour les lecteurs
 * d'écran : les valeurs par jour sont aussi dans un tableau repliable.
 */
export function DailyChart({ points }: { points: DailyPoint[] }) {
	const count = Math.max(points.length, 1);
	const band = PLOT_WIDTH / count;
	const barWidth = band * 0.7;
	const maxTotal = evenCeil(
		Math.max(0, ...points.map((p) => p.fromCache + p.llm + p.failed)),
	);
	const maxCost = Math.max(0.01, ...points.map((p) => p.costUsd));
	const y = (value: number, max: number) =>
		MARGIN.top + PLOT_HEIGHT * (1 - value / max);
	const centerX = (index: number) => MARGIN.left + band * (index + 0.5);
	const ticks = [0, 0.5, 1];

	return (
		<div className="space-y-2">
			<svg
				viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
				role="img"
				aria-label="Analyses par jour, 30 derniers jours"
				className="h-auto w-full max-w-3xl"
			>
				{ticks.map((tick) => {
					const line = y(tick * maxTotal, maxTotal);
					return (
						<g key={tick}>
							<line
								x1={MARGIN.left}
								x2={WIDTH - MARGIN.right}
								y1={line}
								y2={line}
								stroke="#e2e8f0"
							/>
							<text
								x={MARGIN.left - 6}
								y={line + 4}
								textAnchor="end"
								fontSize="11"
								fill="#64748b"
							>
								{tick * maxTotal}
							</text>
							<text
								x={WIDTH - MARGIN.right + 6}
								y={line + 4}
								fontSize="11"
								fill={COLORS.cost}
							>
								{formatUsd(tick * maxCost)}
							</text>
						</g>
					);
				})}

				{points.map((point, index) => {
					let top = MARGIN.top + PLOT_HEIGHT;
					const x = centerX(index) - barWidth / 2;
					return (
						<g key={point.date} data-day={point.date}>
							<title>{barTitle(point)}</title>
							<rect
								x={MARGIN.left + band * index}
								y={MARGIN.top}
								width={band}
								height={PLOT_HEIGHT}
								fill="transparent"
							/>
							{SERIES.map(({ key }) => {
								const height = (PLOT_HEIGHT * point[key]) / maxTotal;
								top -= height;
								return height > 0 ? (
									<rect
										key={key}
										x={x}
										y={top}
										width={barWidth}
										height={height}
										fill={COLORS[key]}
									/>
								) : null;
							})}
						</g>
					);
				})}

				<polyline
					points={points
						.map((p, i) => `${centerX(i)},${y(p.costUsd, maxCost)}`)
						.join(" ")}
					fill="none"
					stroke={COLORS.cost}
					strokeWidth="2"
					pointerEvents="none"
				/>

				{points.map((point, index) =>
					index % 5 === 0 || index === points.length - 1 ? (
						<text
							key={point.date}
							x={centerX(index)}
							y={HEIGHT - 8}
							textAnchor="middle"
							fontSize="11"
							fill="#64748b"
						>
							{shortDate(point.date)}
						</text>
					) : null,
				)}
			</svg>

			<ul
				aria-label="Légende"
				className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
			>
				{SERIES.map(({ key, label }) => (
					<li key={key} className="flex items-center gap-1.5">
						<span
							aria-hidden="true"
							className="inline-block size-3 rounded-sm"
							style={{ backgroundColor: COLORS[key] }}
						/>
						{label}
					</li>
				))}
				<li className="flex items-center gap-1.5">
					<span
						aria-hidden="true"
						className="inline-block h-0.5 w-4"
						style={{ backgroundColor: COLORS.cost }}
					/>
					Coût IA du jour
				</li>
			</ul>

			<details className="text-sm">
				<summary className="cursor-pointer text-slate-600">
					Voir les données
				</summary>
				<div className="mt-2 max-h-80 overflow-auto">
					<table className="w-full text-left text-xs">
						<thead className="text-slate-500">
							<tr>
								<th className="py-1 pr-4 font-medium">Date</th>
								<th className="py-1 pr-4 font-medium">Depuis le cache</th>
								<th className="py-1 pr-4 font-medium">Avec appel</th>
								<th className="py-1 pr-4 font-medium">En échec</th>
								<th className="py-1 font-medium">Coût</th>
							</tr>
						</thead>
						<tbody>
							{points.map((point) => (
								<tr key={point.date} className="border-t border-slate-100">
									<td className="py-1 pr-4">{shortDate(point.date)}</td>
									<td className="py-1 pr-4">{point.fromCache}</td>
									<td className="py-1 pr-4">{point.llm}</td>
									<td className="py-1 pr-4">{point.failed}</td>
									<td className="py-1">{formatUsd(point.costUsd)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</details>
		</div>
	);
}
