import type { Locale } from "@radarnaque/shared";
import { type ReactNode, type RefObject, useId, useRef } from "react";
import { identificationHeadline } from "../lib/content/identification-headline";
import { statusLine } from "../lib/content/scan-progress";
import type { AiScan } from "../lib/content/use-ai-scan";
import { aiErrorText, contentText } from "../lib/content-i18n";
import {
	ACTION_PILL_CLASS,
	ErrorPill,
	errorAction,
	noScansLeft,
	PillFrame,
	PricingLink,
	useKeepPillFocus,
} from "./BadgePill";
import { LiveLine, useThrottled, useWaiting } from "./LiveStatus";
import { Logo } from "./Logo";

/**
 * La pilule « Identifier » de la fiche (spec §13.1), même forme que « Analyser »
 * et placée avant elle. Selon l'état de l'identification, dans cet ordre :
 * 1. résultat : glyphe de confiance, référence courte, « · », niveau et
 *    pourcentage en chiffres tabulaires ; « A ou B ? » quand deux candidats
 *    restent, « Produit non identifié » quand rien n'est identifiable. Aucune
 *    couleur sémantique du risque. Le nom accessible donne la référence
 *    entière ; le clic ouvre ou ferme le panneau Identification ;
 * 2. en cours (identification seule, ou première phase d'une analyse) : le
 *    logo animé et la ligne d'état, même clic ;
 * 3. erreur : comme l'erreur de l'analyse, l'action étant « Identifier » ;
 * 4. repos : le logo et « Identifier », nommé « Identifier le produit » ; un
 *    lien vers les formules sans abonnement ; grisé sans analyse restante.
 * Rien pendant la lecture du magasin (`restoring`), comme « Analyser ».
 */
export function IdentifyPill({
	scan,
	locale,
	open,
	onToggle,
	onLaunch,
	pillRef,
}: {
	scan: AiScan;
	locale: Locale;
	/** Panneau Identification ouvert : l'erreur y est déjà affichée. */
	open: boolean;
	onToggle(): void;
	onLaunch(): void;
	/** Conteneur de la pilule : la fermeture du panneau y rend le focus (`focusPill`). */
	pillRef?: RefObject<HTMLSpanElement | null>;
}) {
	const ownRef = useRef<HTMLSpanElement>(null);
	const containerRef = pillRef ?? ownRef;
	useKeepPillFocus(containerRef);
	const reasonId = useId();
	const { identification, access } = scan;
	const progress =
		identification.status === "loading" ? identification.progress : null;
	const line = progress ? statusLine(progress, locale) : "";
	const waiting = useWaiting(progress?.lastAt ?? 0, progress !== null);
	const error =
		identification.status === "error" && !open
			? aiErrorText(locale, identification.code)
			: null;
	const announced = useThrottled(line || error || "");
	const launchLabel = contentText(locale, "identify.launch");
	const launchText = contentText(locale, "identify.launchShort");
	const empty = noScansLeft(access);
	const reason = contentText(locale, "ai.noScansLeft");
	const noSubscription =
		access !== "loading" &&
		!("error" in access) &&
		access.status === "noSubscription";

	let pill: ReactNode = null;
	let disabledReason = false;
	if (scan.restoring) {
		// Lecture du magasin en cours : rien à cliquer.
	} else if (identification.status === "done") {
		const headline = identificationHeadline(identification.result, locale);
		const name = headline
			? `${headline.reference} · ${headline.level} ${headline.percent}`
			: contentText(locale, "identify.none");
		pill = (
			<button
				type="button"
				aria-expanded={open}
				aria-label={name}
				onClick={onToggle}
				className={ACTION_PILL_CLASS}
			>
				{headline ? (
					<>
						<span data-glyph="" aria-hidden="true" className="shrink-0">
							{headline.glyph}
						</span>
						<span data-reference="" className="min-w-0 truncate">
							{headline.short}
						</span>
						<span aria-hidden="true" className="shrink-0 text-text-3">
							·
						</span>
						<span data-level="" className="shrink-0 text-text-2">
							{headline.level}{" "}
							<span data-percent="" className="tabular-nums">
								{headline.percent}
							</span>
						</span>
					</>
				) : (
					name
				)}
			</button>
		);
	} else if (progress) {
		pill = (
			<button
				type="button"
				aria-expanded={open}
				aria-busy={true}
				aria-label={launchLabel}
				onClick={onToggle}
				className={ACTION_PILL_CLASS}
			>
				<Logo size={16} animated className="shrink-0" />
				<LiveLine text={line} waiting={waiting} />
			</button>
		);
	} else if (identification.status === "error") {
		pill = (
			<ErrorPill
				error={error}
				action={errorAction({
					code: identification.code,
					empty,
					noSubscription,
					onLaunch,
					pricingUrl: scan.pricingUrl,
					launchLabel,
					launchText,
					locale,
				})}
			/>
		);
	} else if (noSubscription) {
		pill = (
			<PricingLink
				href={scan.pricingUrl}
				label={launchLabel}
				className={ACTION_PILL_CLASS}
			>
				<Logo size={16} className="shrink-0" />
				{launchText}
			</PricingLink>
		);
	} else {
		disabledReason = empty;
		pill = (
			<button
				type="button"
				aria-label={launchLabel}
				aria-disabled={empty ? true : undefined}
				aria-describedby={empty ? reasonId : undefined}
				title={empty ? reason : undefined}
				onClick={onLaunch}
				className={ACTION_PILL_CLASS}
			>
				<Logo size={16} className="shrink-0" />
				{launchText}
			</button>
		);
	}

	return (
		<PillFrame
			name="identify"
			containerRef={containerRef}
			announced={announced}
			hidden={
				disabledReason && (
					<span id={reasonId} className="sr-only">
						{reason}
					</span>
				)
			}
		>
			{pill}
		</PillFrame>
	);
}
