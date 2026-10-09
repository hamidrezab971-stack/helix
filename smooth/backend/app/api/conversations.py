from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Path, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased

from app.core.auth import get_current_user
from app.database.database import get_db
from app.models.conversation import Conversation
from app.models.conversation_member import ConversationMember
from app.models.message import Message
from app.models.message_edit import MessageEdit
from app.models.message_receipt import MessageReceipt
from app.models.user import User
from app.realtime.manager import manager
from app.schemas.auth import UserResponse
from app.services.messages import allocate_message_id, effective_message
from app.schemas.conversations import (
    ConversationResponse,
    MessageRequest,
    MessageResponse,
    LastMessageResponse,
    RecentConversationResponse,
)

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


@router.get("", response_model=list[RecentConversationResponse])
def list_conversations(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[RecentConversationResponse]:
    other_member = aliased(ConversationMember)
    unread = (
        select(Message.conversation_id, func.count(MessageReceipt.id).label("count"))
        .join(MessageReceipt, MessageReceipt.message_id == Message.id)
        .where(
            MessageReceipt.recipient_id == user.id,
            MessageReceipt.read_at.is_(None),
            Message.sender_id != user.id,
        )
        .group_by(Message.conversation_id)
        .subquery()
    )
    latest_message_id = (
        select(Message.id)
        .where(Message.conversation_id == Conversation.id)
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(1)
        .correlate(Conversation)
        .scalar_subquery()
    )
    rows = db.execute(
        select(Conversation, User, Message, MessageEdit, func.coalesce(unread.c.count, 0))
        .select_from(Conversation)
        .join(ConversationMember, (
            (ConversationMember.conversation_id == Conversation.id)
            & (ConversationMember.user_id == user.id)
        ))
        .join(other_member, (
            (other_member.conversation_id == Conversation.id)
            & (other_member.user_id != user.id)
        ))
        .join(User, User.id == other_member.user_id)
        .outerjoin(Message, Message.id == latest_message_id)
        .outerjoin(MessageEdit, MessageEdit.message_id == Message.id)
        .outerjoin(unread, unread.c.conversation_id == Conversation.id)
        .order_by(
            Message.created_at.is_(None), Message.created_at.desc(),
            Message.id.desc(), Conversation.id.desc(),
        )
        .limit(50)
    )
    return [RecentConversationResponse(
        id=conversation.id,
        other_user=UserResponse.model_validate(other_user),
        last_message=LastMessageResponse.model_validate(message).model_copy(update={"content": edit.content if edit else message.content}) if message else None,
        updated_at=message.created_at if message else conversation.created_at,
        unread_count=unread_count,
    ) for conversation, other_user, message, edit, unread_count in rows]


@router.post("/with/{user_id}", response_model=ConversationResponse)
def get_or_create_conversation(
    user_id: Annotated[int, Path(gt=0, lt=2**63)],
    response: Response,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> ConversationResponse:
    if user_id == user.id:
        raise HTTPException(status_code=400, detail="Choose another user")
    other_user = db.get(User, user_id)
    if other_user is None:
        raise HTTPException(status_code=404, detail="User not found")

    low_id, high_id = sorted((user.id, user_id))
    query = select(Conversation).where(
        Conversation.user_low_id == low_id, Conversation.user_high_id == high_id
    )
    conversation = db.scalar(query)
    if conversation is None:
        conversation = Conversation(user_low_id=low_id, user_high_id=high_id)
        db.add(conversation)
        try:
            db.flush()
            db.add_all(
                [
                    ConversationMember(conversation_id=conversation.id, user_id=low_id),
                    ConversationMember(conversation_id=conversation.id, user_id=high_id),
                ]
            )
            # Commit the conversation and both members in the same transaction.
            db.commit()
            response.status_code = status.HTTP_201_CREATED
        except IntegrityError:
            db.rollback()
            # A simultaneous request may have already committed this pair.
            conversation = db.scalar(query)
            if conversation is None:
                raise

    return ConversationResponse(
        id=conversation.id,
        created_at=conversation.created_at,
        other_user=UserResponse.model_validate(other_user),
    )


def require_membership(conversation_id: int, user_id: int, db: Session) -> None:
    member_id = db.scalar(
        select(ConversationMember.id).where(
            ConversationMember.conversation_id == conversation_id,
            ConversationMember.user_id == user_id,
        )
    )
    if member_id is None:
        # Use the same response for nonexistent and inaccessible conversations.
        raise HTTPException(status_code=404, detail="Conversation not found")


@router.get("/{conversation_id}/messages", response_model=list[MessageResponse])
def get_messages(
    conversation_id: Annotated[int, Path(gt=0, lt=2**63)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[MessageResponse]:
    require_membership(conversation_id, user.id, db)
    return [
        effective_message(message, receipt, edit)
        for message, receipt, edit in db.execute(
            select(Message, MessageReceipt, MessageEdit)
            .outerjoin(MessageReceipt, MessageReceipt.message_id == Message.id)
            .outerjoin(MessageEdit, MessageEdit.message_id == Message.id)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.asc(), Message.id.asc())
        )
    ]


@router.post(
    "/{conversation_id}/messages",
    response_model=MessageResponse,
    status_code=status.HTTP_201_CREATED,
)
def send_message(
    conversation_id: Annotated[int, Path(gt=0, lt=2**63)],
    data: MessageRequest,
    background_tasks: BackgroundTasks,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MessageResponse:
    require_membership(conversation_id, user.id, db)
    member_ids = list(db.scalars(select(ConversationMember.user_id).where(
        ConversationMember.conversation_id == conversation_id,
    )))
    recipient_ids = [member_id for member_id in member_ids if member_id != user.id]
    if len(recipient_ids) != 1:
        raise HTTPException(status_code=404, detail="Conversation not found")
    message = Message(
        id=allocate_message_id(db), conversation_id=conversation_id, sender_id=user.id, content=data.content
    )
    db.add(message)
    db.flush()
    db.add(MessageReceipt(message_id=message.id, recipient_id=recipient_ids[0]))
    db.commit()
    db.refresh(message)
    saved = MessageResponse.model_validate(message)
    background_tasks.add_task(
        manager.broadcast, member_ids,
        {"type": "message:new", "data": saved.model_dump(mode="json")},
    )
    return saved
