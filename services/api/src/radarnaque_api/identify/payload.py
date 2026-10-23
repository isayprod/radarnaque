"""Messages « user » des trois étapes d'identification.

Les faits de l'annonce sont ceux de `llm.payload` (liste blanche, contacts masqués, vendeur sans
identité), sans les signaux des règles locales. L'étape des critères ne reçoit jamais d'annonce.
Le bloc `<identification>` nourrit ensuite l'analyse de l'arnaque."""

import json
import re
from datetime import date
from urllib.parse import urlsplit

from radarnaque_api.identify.schemas import ReadPhotosObject, StoredCriterion
from radarnaque_api.llm.payload import FACTS_INTRO, _canonical_block, _facts
from radarnaque_api.pages import PageText, neutralize, wrap_page
from radarnaque_api.schemas import IdentificationOut, ListingIn, RulesIn
from radarnaque_api.search import SearchHit

_NO_RULES = RulesIn.model_construct(version=1, signals=[])
_IDENTIFICATION_TAG = re.compile(r"<(?=\s*/?\s*identification)", re.IGNORECASE)


def _listing_block(listing: ListingIn, images_sent: int) -> str:
    # `today` et `signals` ne servent pas à identifier un produit.
    facts = _facts(listing, _NO_RULES, images_sent, date.min)
    facts.pop("signals")
    facts.pop("today")
    return f"{FACTS_INTRO}\n<annonce>\n{_canonical_block(facts)}\n</annonce>"


def _image_parts(images: list[str]) -> list[dict]:
    parts: list[dict] = []
    for n, b64 in enumerate(images, start=1):
        parts.append({"type": "text", "text": f"Photo {n} :"})
        parts.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
    return parts


def _hit_domain(hit: SearchHit) -> str:
    return (urlsplit(hit.url).hostname or "").replace('"', "")


def _wrap_hit(n: int, hit: SearchHit) -> str:
    body = neutralize(f"{hit.title} — {hit.snippet}")
    return f'<page_web n="{n}" domaine="{_hit_domain(hit)}">{body}</page_web>'


def build_read_photos_messages(listing: ListingIn, images: list[str]) -> list[dict]:
    """Faits masqués de l'annonce puis les photos, numérotées de 1 à n."""
    parts: list[dict] = [{"type": "text", "text": _listing_block(listing, len(images))}]
    parts += _image_parts(images)
    return [{"role": "user", "content": parts}]


def build_criteria_messages(
    candidates: list[str], hints: list[str], pages: list[PageText], hits: list[SearchHit]
) -> list[dict]:
    """Candidats, indices à confirmer, pages numérotées de 1 puis extraits à la suite. Aucune
    donnée d'annonce."""
    lines = ["Candidats :", *(f"- {neutralize(c)}" for c in candidates)]
    if hints:
        lines += ["Indices à confirmer (non vérifiés) :", *(f"- {neutralize(h)}" for h in hints)]
    blocks = [wrap_page(n, page) for n, page in enumerate(pages, start=1)]
    blocks += [_wrap_hit(n, hit) for n, hit in enumerate(hits, start=len(pages) + 1)]
    text = "\n".join(lines) + "\n\n" + "\n".join(blocks)
    return [{"role": "user", "content": [{"type": "text", "text": text}]}]


def build_identify_messages(
    listing: ListingIn,
    images: list[str],
    objects: list[ReadPhotosObject],
    criteria: dict[int, list[StoredCriterion]],
    hits: list[SearchHit],
) -> list[dict]:
    """Annonce, objets avec leurs critères `photo` numérotés par objet (clé de `criteria` : numéro
    de l'objet, à partir de 1), photos, puis résultats de recherche numérotés de 1."""
    sections: list[str] = []
    for n, obj in enumerate(objects, start=1):
        lines = [
            f"Objet {n} ({obj.role}, {neutralize(obj.category)}) — candidats : "
            + neutralize(json.dumps(obj.candidates, ensure_ascii=False))
        ]
        shown = [c for c in criteria.get(n, []) if c.kind == "photo"]
        for k, c in enumerate(shown, start=1):
            expected = "; ".join(f"{cand} : {v.get('fr', '')}" for cand, v in c.expected.items())
            clause = f" — attendu : {neutralize(expected)}" if expected else ""
            lines.append(f"  Critère {k} : {neutralize(c.fr)}{clause}")
        sections.append("\n".join(lines))
    text = _listing_block(listing, len(images)) + "\n\n" + "\n\n".join(sections)
    if hits:
        text += "\n\n" + "\n".join(_wrap_hit(n, h) for n, h in enumerate(hits, start=1))
    parts: list[dict] = [{"type": "text", "text": text}]
    parts += _image_parts(images)
    return [{"role": "user", "content": parts}]


def _data(value: str) -> str:
    """Texte du modèle ou du web dans le bloc `<identification>` : sur une ligne (aucune ligne
    forgée), sans balise `<page_web>` ni `<identification>` ouvrable ou fermable."""
    return _IDENTIFICATION_TAG.sub("&lt;", neutralize(" ".join(value.split())))


def format_identification_block(
    identification: IdentificationOut, price_hits: list[SearchHit]
) -> str:
    """Bloc `<identification>` ajouté au message de l'arnaque (spec §3.5) : statut et confiance,
    puis chaque objet (référence, confiance, niveau, candidats restants), les observations sur
    les photos, `title_mismatch` et les résultats de la requête « prix » (titre, domaine,
    extrait). Tout texte venu du modèle ou du web passe par `_data`."""
    lines = [
        "<identification>",
        f"Statut : {identification.status} ; confiance : {identification.confidence}"
        f" ({identification.level})",
    ]
    for n, obj in enumerate(identification.objects, start=1):
        remaining = " | ".join(_data(r) for r in obj.remaining) or "aucun"
        lines.append(
            f"Objet {n} ({obj.role}, {_data(obj.label)}) : référence "
            f"{_data(obj.reference) if obj.reference else 'aucune'} ; confiance {obj.confidence}"
            f" ({obj.level}) ; candidats restants : {remaining}"
        )
    observations = identification.photo_observations
    lines.append("Observations sur les photos :" + ("" if observations else " aucune"))
    for o in observations:
        photo = f"photo {o.photo}" if o.photo is not None else "sans photo"
        lines.append(f"- {photo} ({o.kind}) : {_data(o.note)}")
    mismatch = identification.title_mismatch
    lines.append(f"title_mismatch : {_data(mismatch) if mismatch else 'aucun'}")
    lines.append("Résultats de la requête « prix » :" + ("" if price_hits else " aucun"))
    for h in price_hits:
        lines.append(f"- {_data(h.title)} ({_data(_hit_domain(h))}) : {_data(h.snippet)}")
    lines.append("</identification>")
    return "\n".join(lines)
