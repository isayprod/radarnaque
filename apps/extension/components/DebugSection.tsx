import type { AnalysisResult, Locale } from "@radarnaque/shared";
import {
	Component,
	Fragment,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { aiErrorText, contentText } from "../lib/content-i18n";

/** Bloc `debug` d'une réponse de scan (superuser hors production). */
export type ScanDebug = NonNullable<AnalysisResult["debug"]>;

/** « Copié » reste affiché 2 s. */
const COPIED_MS = 2_000;

/** Longueur affichée d'une empreinte ; la valeur complète est dans `title`. */
const HASH_CHARS = 12;

const BUTTON_CLASS =
	"inline-flex cursor-pointer items-center justify-center rounded-[6px] border border-slate-300 bg-white px-2 py-1 font-sans text-[12px] leading-[1.4] font-semibold text-slate-900 shadow-sm hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:cursor-default disabled:bg-slate-100 disabled:text-slate-500";

const ms = (value: number | null) => (value === null ? "—" : `${value} ms`);

/** Lignes clé / valeur ; `title` : valeur complète d'une empreinte raccourcie. */
function linesOf(
	debug: ScanDebug,
): Array<{ label: string; value: string; title?: string }> {
	const { timingsMs: t } = debug;
	return [
		{ label: "provider / model", value: `${debug.provider} / ${debug.model}` },
		{
			label: "prompt",
			value: `${debug.promptVersion.scanKind} v${debug.promptVersion.version}`,
		},
		{ label: "llmCalled", value: String(debug.llmCalled) },
		{ label: "rounds", value: String(debug.rounds) },
		{ label: "fromCache", value: String(debug.fromCache) },
		{
			label: "tokens in / out",
			value: `${debug.tokensIn} / ${debug.tokensOut}`,
		},
		// Micro-dollars : 6 décimales, aucun arrondi perdu.
		{ label: "cost", value: `$${(debug.costUsdMicros / 1e6).toFixed(6)}` },
		{
			label: "timings",
			value: `total ${ms(t.total)} · llm ${ms(t.llm)} · images ${ms(t.images)} · search ${ms(t.search)}`,
		},
		{
			label: "inputHash",
			value: debug.inputHash.slice(0, HASH_CHARS),
			title: debug.inputHash,
		},
		{
			label: "contentHash",
			value: debug.contentHash.slice(0, HASH_CHARS),
			title: debug.contentHash,
		},
	];
}

/** Recherches web de l'analyse : aspect, issue, durée, requête puis sortie de l'outil. */
function searchesText(debug: ScanDebug): string {
	return debug.searches
		.map(
			(s, i) =>
				`[${i + 1}] ${s.aspect} · ${s.ok ? "ok" : "failed"} · ${s.ms} ms\nquery: ${s.query}\n${s.output}`,
		)
		.join("\n\n");
}

/** Bloc repliable : un `<pre>` borné en hauteur, avec défilement. */
function Block({ title, text }: { title: string; text: string }) {
	return (
		<details className="mt-2">
			<summary className="cursor-pointer font-sans font-semibold text-slate-700">
				{title}
			</summary>
			<pre className="m-0 mt-1 max-h-[160px] overflow-auto rounded-[4px] bg-slate-50 p-1.5 font-mono text-[11px] leading-[1.4] break-words whitespace-pre-wrap">
				{text}
			</pre>
		</details>
	);
}

/**
 * Section « Debug (superuser) » en bas du panneau : modèle, prompt, tours, coût,
 * durées, et ce qui a été envoyé au LLM et reçu de lui (recherches web et
 * réflexion comprises). Tout est rendu en nœuds texte, jamais en HTML : le prompt,
 * les recherches et la réponse contiennent du texte de l'annonce ou du web.
 */
export function DebugSection({
	locale,
	debug,
	rescanning,
	onRescan,
	error,
}: {
	locale: Locale;
	debug: ScanDebug;
	/** Relance sans cache en cours : le bouton l'indique et se désactive. */
	rescanning: boolean;
	onRescan(): void;
	/** Code d'erreur de la dernière relance ; le résultat affiché est l'ancien. */
	error?: string;
}) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	// Faux après le démontage : une copie terminée ensuite ne fait plus rien.
	const mountedRef = useRef(false);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			clearTimeout(timer.current);
		};
	}, []);

	const copy = () => {
		let pending: Promise<void>;
		try {
			pending = navigator.clipboard.writeText(JSON.stringify(debug, null, 2));
		} catch {
			// Presse-papiers absent : rien à signaler, c'est un outil de développement.
			return;
		}
		pending.then(
			() => {
				if (!mountedRef.current) return;
				setCopied(true);
				clearTimeout(timer.current);
				timer.current = setTimeout(() => setCopied(false), COPIED_MS);
			},
			() => {},
		);
	};

	const messages = debug.messages
		.map((m) => `${m.role}:\n${m.content}`)
		.join("\n\n");

	return (
		<details className="mt-3 border-t border-slate-200 pt-2 font-mono text-[11px] leading-[1.4] text-slate-800">
			<summary className="cursor-pointer font-sans text-[12px] font-semibold text-slate-700">
				{contentText(locale, "debug.title")}
			</summary>
			<dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
				{linesOf(debug).map(({ label, value, title }) => (
					<Fragment key={label}>
						<dt className="text-slate-500">{label}</dt>
						<dd className="m-0 break-all" title={title}>
							{value}
						</dd>
					</Fragment>
				))}
			</dl>
			<Block
				title={contentText(locale, "debug.systemPrompt")}
				text={debug.systemPrompt}
			/>
			<Block title={contentText(locale, "debug.messages")} text={messages} />
			<Block
				title={contentText(locale, "debug.searches")}
				text={searchesText(debug) || "—"}
			/>
			<Block
				title={contentText(locale, "debug.reasoning")}
				text={debug.reasoning || "—"}
			/>
			<Block
				title={contentText(locale, "debug.rawResponse")}
				text={debug.rawResponse ?? "—"}
			/>
			{error !== undefined && (
				<p role="alert" className="m-0 mt-2 font-sans text-[12px] text-red-800">
					{aiErrorText(locale, error)}
				</p>
			)}
			<div className="mt-2 flex flex-wrap gap-2">
				<button type="button" onClick={copy} className={BUTTON_CLASS}>
					{contentText(locale, copied ? "debug.copied" : "debug.copy")}
				</button>
				<button
					type="button"
					disabled={rescanning}
					aria-busy={rescanning}
					onClick={() => onRescan()}
					className={BUTTON_CLASS}
				>
					{contentText(locale, rescanning ? "ai.loading" : "debug.rescan")}
				</button>
			</div>
		</details>
	);
}

/**
 * Isole la section Debug : un bloc `debug` malformé ne doit jamais masquer le
 * verdict IA. En cas d'erreur de rendu, la section disparaît, sans message.
 */
export class DebugBoundary extends Component<
	{ children: ReactNode },
	{ failed: boolean }
> {
	override state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	override componentDidCatch(error: unknown) {
		console.debug(`radarnaque: section Debug indisponible (${String(error)})`);
	}

	override render() {
		return this.state.failed ? null : this.props.children;
	}
}
