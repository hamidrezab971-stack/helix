"""Additive SQLite migrations. Never rebuild an existing application table."""
from sqlalchemy import text

from app.models.conversation_event import ConversationEvent, ConversationSyncState
from app.services.sync import TIMESTAMP_SQL


def migrate_phase17(engine):
    # Explicitly create additive tables and indexes on old tables: create_all
    # alone does not add an index to an already existing messages table.
    with engine.begin() as connection:
        ConversationEvent.__table__.create(connection, checkfirst=True)
        ConversationSyncState.__table__.create(connection, checkfirst=True)
        connection.execute(text('CREATE INDEX IF NOT EXISTS ix_messages_history ON messages (conversation_id, created_at, id)'))
        connection.execute(text(f'CREATE INDEX IF NOT EXISTS ix_messages_timeline ON messages (conversation_id, ({TIMESTAMP_SQL}), id)'))
        connection.execute(text('CREATE INDEX IF NOT EXISTS ix_receipts_unread ON message_receipts (recipient_id, read_at, message_id)'))
        connection.execute(text('CREATE TABLE IF NOT EXISTS smooth_schema_migrations (version INTEGER PRIMARY KEY)'))
        connection.execute(text('INSERT OR IGNORE INTO smooth_schema_migrations (version) VALUES (17)'))
