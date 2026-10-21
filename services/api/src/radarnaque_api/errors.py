from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DataError


class ApiError(Exception):
    """Erreur applicative rendue au format `{"error": {"code", "message", "details"}}`."""

    def __init__(
        self, status: int, code: str, message: str, details: dict[str, Any] | None = None
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}


def error_body(code: str, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details or {}}}


def validation_issues(exc: RequestValidationError) -> list[dict[str, Any]]:
    """Emplacement, message et type de chaque erreur, jamais la valeur reçue."""
    return [{"loc": list(e["loc"]), "message": e["msg"], "type": e["type"]} for e in exc.errors()]


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status, content=error_body(exc.code, exc.message, exc.details)
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content=error_body(
                "invalid_request", "Requête invalide.", {"errors": validation_issues(exc)}
            ),
        )

    @app.exception_handler(DataError)
    async def _data_error(_request: Request, _exc: DataError) -> JSONResponse:
        # Valeur que Postgres refuse (un caractère NUL, par exemple) : 422, sans jamais renvoyer
        # la valeur reçue ni le texte de Postgres.
        return JSONResponse(
            status_code=422, content=error_body("invalid_request", "Requête invalide.")
        )
