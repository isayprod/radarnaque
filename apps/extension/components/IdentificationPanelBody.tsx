import { useId } from "react";
import type { IdentifyState } from "../lib/content/ai-client";
import { identificationHeadline } from "../lib/content/identification-headline";
import { statusLine } from "../lib/content/scan-progress";
import { contentText } from "../lib/content-i18n";
import {
	type AccessActionsProps,
	AccessBody,
	ErrorNotice,
	hasOwnAction,
	SECONDARY_PILL_CLASS,
	STATE_TITLE_CLASS,
	WHITE_PILL_CLASS,
} from "./AiSection";
import { LiveLine, useWaiting } from "./LiveStatus";

export interface IdentificationPanelBodyProps extends AccessActionsProps {
	identification: IdentifyState;
	onIdentify(): void;
}

/**
 * Contenu provisoire du panneau Identification : les états d'accès de la
 * section IA, la ligne d'état pendant l'identification, puis le titre du
 * résultat (référence, glyphe, niveau, pourcentage). Mêmes props que la section
 * complète qui le remplacera. Composant contrôlé : l'état vient du parent ;
 * tout texte de l'API est rendu en nœuds texte.
 */
export function IdentificationPanelBody(props: IdentificationPanelBodyProps) {
	const titleId = useId();
	const { locale, identification } = props;
	return (
		<section aria-labelledby={titleId}>
			{/* Le panneau a son en-tête visible : ce titre ne sert qu'aux lecteurs d'écran. */}
			<h3 id={titleId} className="sr-only">
				{contentText(locale, "identify.title")}
			</h3>
			{identification.status === "done" ? (
				<Headline {...props} identification={identification} />
			) : (
				<AccessBody {...props}>
					<IdentifyBlock {...props} />
				</AccessBody>
			)}
		</section>
	);
}

/** Le résultat, quel que soit l'accès : référence en serif, puis glyphe, niveau et pourcentage. */
function Headline({
	locale,
	identification,
}: IdentificationPanelBodyProps & {
	identification: Extract<IdentifyState, { status: "done" }>;
}) {
	const headline = identificationHeadline(identification.result, locale);
	if (!headline)
		return (
			<p className={STATE_TITLE_CLASS}>
				{contentText(locale, "identify.none")}
			</p>
		);
	return (
		<div className="flex flex-col gap-2">
			<p className={`${STATE_TITLE_CLASS} break-words`}>{headline.reference}</p>
			<p className="m-0 flex items-center gap-1.5 text-text-2">
				<span aria-hidden="true">{headline.glyph}</span>
				<span>{headline.level}</span>
				<span className="tabular-nums">{headline.percent}</span>
			</p>
		</div>
	);
}

/**
 * Accès actif : l'erreur de la dernière identification, le bouton « Identifier
 * le produit », et la ligne d'état pendant l'identification (la pilule l'annonce).
 */
function IdentifyBlock(props: IdentificationPanelBodyProps) {
	const { locale, identification } = props;
	const progress =
		identification.status === "loading" ? identification.progress : null;
	const waiting = useWaiting(progress?.lastAt ?? 0, progress !== null);
	// L'erreur affichée a déjà sa pilule blanche (connexion, formules).
	const errorHasAction =
		identification.status === "error" && hasOwnAction(identification.code);
	return (
		<div className="flex flex-col items-start gap-3">
			{/* Région présente avant l'erreur, pour qu'elle soit annoncée. */}
			<div aria-live="polite" className="w-full">
				{identification.status === "error" && (
					<ErrorNotice {...props} code={identification.code} />
				)}
			</div>
			<button
				type="button"
				disabled={progress !== null}
				aria-busy={progress !== null}
				onClick={() => props.onIdentify()}
				className={errorHasAction ? SECONDARY_PILL_CLASS : WHITE_PILL_CLASS}
			>
				{contentText(locale, "identify.launch")}
			</button>
			{progress && (
				<LiveLine text={statusLine(progress, locale)} waiting={waiting} />
			)}
		</div>
	);
}
