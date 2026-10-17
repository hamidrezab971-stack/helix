from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database.database import Base


class UserProfilePhoto(Base):
    __tablename__ = 'user_profile_photos'
    __table_args__ = (
        UniqueConstraint('user_id', 'position', name='uq_profile_photo_position'),
        CheckConstraint('position >= 0 AND width = 512 AND height = 512 AND size_bytes > 0'),
    )
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    __mapper_args__ = {'eager_defaults': True}
    # AUTOINCREMENT prevents deleted photo IDs being reused by cached images.
    __table_args__ = (*__table_args__, {'sqlite_autoincrement': True})
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    storage_name: Mapped[str] = mapped_column(String(37), unique=True)
    position: Mapped[int] = mapped_column(Integer)
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    size_bytes: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.current_timestamp())


class ProfileFileGC(Base):
    """Durable deletion queue, committed with photo removal; never shared attachments."""
    __tablename__ = 'profile_file_gc'
    storage_name: Mapped[str] = mapped_column(String(37), primary_key=True)
    available_after: Mapped[int] = mapped_column(Integer, server_default='0')


class AuthChallenge(Base):
    __tablename__ = 'auth_challenges'
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    purpose: Mapped[str] = mapped_column(String(8))
    issued: Mapped[str] = mapped_column(String(4096))
    expires_at: Mapped[int] = mapped_column(Integer, index=True)


class AuthRateBucket(Base):
    __tablename__ = 'auth_rate_buckets'
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    count: Mapped[int] = mapped_column(Integer)
    reset_at: Mapped[int] = mapped_column(Integer, index=True)
    blocked_until: Mapped[int] = mapped_column(Integer, default=0)


class AuthWorkLease(Base):
    __tablename__ = 'auth_work_leases'
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    expires_at: Mapped[int] = mapped_column(Integer, index=True)
