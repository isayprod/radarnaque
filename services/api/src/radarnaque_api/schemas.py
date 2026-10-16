from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """Modèle de réponse : JSON en camelCase, Python en snake_case."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class QuotaOut(CamelModel):
    scan_kind: str | None
    limit: int
    used: int
    remaining: int


class MeOut(CamelModel):
    user_id: str
    email: str
    role: Literal["user", "admin"]
    plan: str | None
    features: list[str]
    unlimited: bool
    period_start: datetime | None
    quotas: list[QuotaOut]
    total_cap: QuotaOut | None


class BootstrapOut(BaseModel):
    created: bool
