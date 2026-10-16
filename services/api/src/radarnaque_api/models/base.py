from sqlalchemy import MetaData, Text
from sqlalchemy.orm import DeclarativeBase

APP_SCHEMA = "app"


class Base(DeclarativeBase):
    """Base déclarative : toutes les tables vivent dans le schéma `app`."""

    metadata = MetaData(schema=APP_SCHEMA)
    type_annotation_map = {str: Text}
