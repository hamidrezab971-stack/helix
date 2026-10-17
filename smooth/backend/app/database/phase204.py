"""Version 204: additive and rollback-compatible; never rewrites user data."""
from sqlalchemy import text
from app.models.conversation_visibility import ConversationVisibility


def migrate_phase204(engine):
    with engine.begin() as connection:
        connection.exec_driver_sql('BEGIN IMMEDIATE')
        ConversationVisibility.__table__.create(connection, checkfirst=True)
        connection.execute(text('CREATE TABLE IF NOT EXISTS smooth_schema_migrations (version INTEGER PRIMARY KEY)'))
        connection.execute(text('INSERT OR IGNORE INTO smooth_schema_migrations(version) VALUES (204)'))
