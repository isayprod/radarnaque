"""Faux client LLM partagé par les tests de service et de pipeline."""

import asyncio

from pydantic import BaseModel

from radarnaque_api.llm.client import (
    Bilingual,
    LLMAnalysis,
    LLMReason,
    LLMResult,
    SearchRecord,
    StepResult,
)
from radarnaque_api.llm.events import EventSink
from radarnaque_api.llm.providers import ReasoningEffort
from radarnaque_api.llm.tools import WebSearchTool


class FakeLLM:
    """Faux client LLM : compte ses appels, et chaque appel rend un score différent.
    `complete` rend `step_outputs[schema_name]` et note l'appel dans `step_calls` ; une liste y
    donne une sortie par appel, dans l'ordre (la dernière ensuite). `step_errors[schema_name]`
    est levée à la place d'une sortie."""

    def __init__(
        self, *, delay: float = 0.0, error: Exception | None = None, max_images: int | None = None
    ) -> None:
        self.max_images = max_images
        self.delay = delay
        self.error = error
        self.calls: list[dict] = []
        self.providers: list[str] = []
        self.professional = False  # valeur de `professional` des prochaines réponses
        self.searches: list[
            SearchRecord
        ] = []  # recherches web « faites » par les prochaines réponses
        self.step_outputs: dict[str, BaseModel | list[BaseModel]] = {}
        self.step_errors: dict[str, Exception] = {}
        self.step_calls: list[dict] = []

    def llm_for(self, provider: str) -> "FakeLLM":
        self.providers.append(provider)
        return self

    async def analyze(
        self,
        *,
        model: str,
        system_prompt: str,
        messages: list[dict],
        tools: WebSearchTool | None = None,
        on_event: EventSink | None = None,
    ) -> LLMResult:
        self.calls.append(
            {"model": model, "system_prompt": system_prompt, "messages": messages, "tools": tools}
        )
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        n = len(self.calls)
        return LLMResult(
            analysis=LLMAnalysis(
                score=60 + n,
                professional=self.professional,
                summary=Bilingual(fr=f"Résumé {n}", nl=f"Samenvatting {n}"),
                advice=Bilingual(fr=f"Conseil {n}", nl=f"Advies {n}"),
                reasons=[
                    LLMReason(severity="danger", fr=f"Raison A{n}", nl=f"Reden A{n}"),
                    LLMReason(severity="info", fr=f"Raison B{n}", nl=f"Reden B{n}"),
                ][: 1 + n % 2],
            ),
            tokens_in=100 * n,
            tokens_out=10 * n,
            cost_usd_micros=42 * n,
            raw_text=f'{{"score": {60 + n}}}',
            searches=list(self.searches),
        )

    async def complete[T: BaseModel](
        self,
        *,
        model: str,
        system_prompt: str,
        messages: list[dict],
        output: type[T],
        schema_name: str,
        reasoning: ReasoningEffort | None = None,
        on_event: EventSink | None = None,
    ) -> StepResult[T]:
        self.step_calls.append(
            {
                "schema_name": schema_name,
                "model": model,
                "system_prompt": system_prompt,
                "messages": messages,
                "reasoning": reasoning,
            }
        )
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        if schema_name in self.step_errors:
            raise self.step_errors[schema_name]
        prepared = self.step_outputs[schema_name]
        if isinstance(prepared, list):
            seen = sum(c["schema_name"] == schema_name for c in self.step_calls)
            prepared = prepared[min(seen, len(prepared)) - 1]
        n = len(self.step_calls)
        return StepResult(
            output=prepared,  # type: ignore[arg-type]
            tokens_in=100 * n,
            tokens_out=10 * n,
            cost_usd_micros=42 * n,
            raw_text=prepared.model_dump_json(),
            system_prompt=system_prompt,
        )
