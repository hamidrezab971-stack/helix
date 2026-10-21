"""Version 20: additive, idempotent migration. No table rebuild or data rollback."""
from sqlalchemy import inspect, text
from app.models.profile import UserProfilePhoto, ProfileFileGC, AuthChallenge, AuthRateBucket, AuthWorkLease


def migrate_phase20(engine):
    with engine.begin() as connection:
        connection.exec_driver_sql('BEGIN IMMEDIATE')
        columns = {c['name'] for c in inspect(connection).get_columns('users')}
        if 'biography' not in columns:
            connection.execute(text('ALTER TABLE users ADD COLUMN biography TEXT CHECK (biography IS NULL OR length(biography) <= 1000)'))
        if 'primary_photo_id' not in columns:
            connection.execute(text('ALTER TABLE users ADD COLUMN primary_photo_id INTEGER'))
        if 'profile_version' not in columns:
            connection.execute(text('ALTER TABLE users ADD COLUMN profile_version INTEGER NOT NULL DEFAULT 0'))
        for model in (UserProfilePhoto, ProfileFileGC, AuthChallenge, AuthRateBucket, AuthWorkLease):
            model.__table__.create(connection, checkfirst=True)
        # Triggers apply to both newly created and migrated users tables. The
        # pointer always belongs to this user; first insert and deletion elect
        # exactly one primary. No transient multiple-primary rows exist.
        statements = [
            '''CREATE TRIGGER IF NOT EXISTS profile_version_primary AFTER UPDATE OF primary_photo_id ON users
               WHEN NEW.primary_photo_id IS NOT OLD.primary_photo_id
               BEGIN UPDATE users SET profile_version=profile_version+1 WHERE id=NEW.id; END''',
            '''CREATE TRIGGER IF NOT EXISTS profile_version_bio AFTER UPDATE OF biography ON users
               WHEN NEW.biography IS NOT OLD.biography
               BEGIN UPDATE users SET profile_version=profile_version+1 WHERE id=NEW.id; END''',
            '''CREATE TRIGGER IF NOT EXISTS profile_version_add AFTER INSERT ON user_profile_photos
               BEGIN UPDATE users SET profile_version=profile_version+1 WHERE id=NEW.user_id; END''',
            '''CREATE TRIGGER IF NOT EXISTS profile_version_delete AFTER DELETE ON user_profile_photos
               BEGIN UPDATE users SET profile_version=profile_version+1 WHERE id=OLD.user_id; END''',
            '''CREATE TRIGGER IF NOT EXISTS profile_primary_insert BEFORE INSERT ON users
               WHEN NEW.primary_photo_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'invalid primary photo'); END''',
            '''CREATE TRIGGER IF NOT EXISTS profile_bio_insert BEFORE INSERT ON users
               WHEN length(NEW.biography) > 1000 BEGIN SELECT RAISE(ABORT, 'biography too long'); END''',
            '''CREATE TRIGGER IF NOT EXISTS profile_bio_update BEFORE UPDATE OF biography ON users
               WHEN length(NEW.biography) > 1000 BEGIN SELECT RAISE(ABORT, 'biography too long'); END''',
            '''CREATE TRIGGER IF NOT EXISTS profile_primary_update BEFORE UPDATE OF primary_photo_id ON users
               WHEN (NEW.primary_photo_id IS NOT NULL AND NOT EXISTS
                 (SELECT 1 FROM user_profile_photos WHERE id=NEW.primary_photo_id AND user_id=NEW.id))
                 OR (NEW.primary_photo_id IS NULL AND EXISTS
                 (SELECT 1 FROM user_profile_photos WHERE user_id=NEW.id))
               BEGIN SELECT RAISE(ABORT, 'invalid primary photo'); END''',
            '''CREATE TRIGGER IF NOT EXISTS profile_first AFTER INSERT ON user_profile_photos
               BEGIN UPDATE users SET primary_photo_id=NEW.id WHERE id=NEW.user_id AND primary_photo_id IS NULL; END''',
            '''CREATE TRIGGER IF NOT EXISTS profile_photo_immutable BEFORE UPDATE OF user_id, storage_name ON user_profile_photos
               BEGIN SELECT RAISE(ABORT, 'immutable profile storage'); END''',
            '''CREATE TRIGGER IF NOT EXISTS profile_delete AFTER DELETE ON user_profile_photos
               BEGIN
                 UPDATE users SET primary_photo_id=(SELECT id FROM user_profile_photos
                   WHERE user_id=OLD.user_id ORDER BY position,id LIMIT 1)
                   WHERE id=OLD.user_id AND primary_photo_id=OLD.id;
                 INSERT OR IGNORE INTO profile_file_gc(storage_name) VALUES (OLD.storage_name);
               END''',
        ]
        for statement in statements:
            connection.execute(text(statement))
        connection.execute(text('CREATE TABLE IF NOT EXISTS smooth_schema_migrations (version INTEGER PRIMARY KEY)'))
        connection.execute(text('INSERT OR IGNORE INTO smooth_schema_migrations(version) VALUES (20)'))
