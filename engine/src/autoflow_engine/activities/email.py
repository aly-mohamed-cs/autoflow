"""Email through Exchange on-premise (EWS) or any SMTP server."""

from __future__ import annotations

import fnmatch
import smtplib
from email.message import EmailMessage
from pathlib import Path
from typing import Any, Literal

from ..catalog import OutputDef, Param, Params, activity
from ..errors import ActivityError
from ..runtime.context import RunContext
from ..values import Table, to_text

E = "Email"


def _addresses(value: Any) -> list[str]:
    if isinstance(value, list | tuple):
        items = [to_text(v) for v in value]
    else:
        items = to_text(value).replace(";", ",").split(",")
    return [a.strip() for a in items if a.strip()]


def _files(value: Any) -> list[Path]:
    if value in (None, ""):
        return []
    items = value if isinstance(value, list | tuple) else [v for v in to_text(value).split(",")]
    files = [Path(to_text(v).strip()) for v in items if to_text(v).strip()]
    for f in files:
        if not f.is_file():
            raise ActivityError(f"The attachment '{f}' does not exist.")
    return files


class ExchangeParams(Params):
    server: str = Param(title="Exchange server", placeholder="mail.company.local",
                        description="The Exchange server name (ask IT). Autoflow connects to its EWS service.")
    credential: str = Param(title="Mailbox credential", ui="credential",
                            description="Username as COMPANY\\user or user@company.local.")
    mailbox: str = Param("", title="Mailbox address", placeholder="(the credential's own mailbox)", advanced=True)


def _mailbox_address(mailbox: str, username: str) -> str:
    address = to_text(mailbox).strip() or (username if "@" in username else "")
    if not address:
        raise ActivityError("Enter the mailbox address (e.g. robot@company.com) under More options.")
    return address


def connect(server: str, username: str, password: str, mailbox: str) -> Any:
    """Sign in to an Exchange mailbox (EWS). Also used by robots watching a mailbox (email triggers)."""
    from exchangelib import DELEGATE, Account, Configuration, Credentials
    from exchangelib.errors import EWSError, UnauthorizedError

    try:
        config = Configuration(server=to_text(server).strip(), credentials=Credentials(username, password))
        account = Account(_mailbox_address(mailbox, username), config=config, autodiscover=False,
                          access_type=DELEGATE)
        account.root  # noqa: B018 - connects and checks the sign-in
    except UnauthorizedError:
        raise ActivityError("Exchange rejected the username or password.", "Check the credential.") from None
    except (EWSError, OSError) as exc:
        raise ActivityError(f"Could not connect to Exchange at {server}: {exc}",
                            "Check the server name, and that the robot can reach it.") from None
    return account


def _account(ctx: RunContext, p: ExchangeParams) -> Any:
    cred = ctx.credential(p.credential)
    key = f"ews:{p.server}:{_mailbox_address(p.mailbox, cred.username)}"
    if key not in ctx.resources:
        ctx.resources[key] = connect(p.server, cred.username, str(cred.password), p.mailbox)
    return ctx.resources[key]


# -- sending ----------------------------------------------------------------------------------


class SendParams(Params):
    to: Any = Param(title="To", placeholder="name@company.com, other@company.com")
    cc: Any = Param("", title="Cc", advanced=True)
    subject: str = Param(title="Subject")
    body: str = Param("", title="Message", ui="multiline")
    attachments: Any = Param(None, title="Attachments", ui="variable", description="A file, or a list of files.")
    via: Literal["exchange", "smtp"] = Param("exchange", title="Send with")
    server: str = Param(title="Mail server", placeholder="mail.company.local")
    credential: str = Param("", title="Credential", ui="credential",
                            description="Exchange: the mailbox to send from. SMTP: leave empty if the server needs no sign-in.")
    sender: str = Param("", title="From address (SMTP)", advanced=True)
    port: int = Param(25, title="SMTP port", advanced=True)
    use_tls: bool = Param(True, title="Encrypt (STARTTLS) when the server supports it", advanced=True)


@activity(
    "email.send",
    title="Send email",
    category=E,
    icon="send",
    sentence="Send email {subject} to {to}",
    description="Send an email, optionally with attachments such as a report.",
    params=SendParams,
)
def send(ctx: RunContext, p: SendParams) -> None:
    to, cc = _addresses(p.to), _addresses(p.cc)
    if not to:
        raise ActivityError("No recipient was given.")
    attachments = _files(p.attachments)
    if p.via == "exchange":
        from exchangelib import FileAttachment, HTMLBody, Mailbox, Message

        account = _account(ctx, ExchangeParams(server=p.server, credential=p.credential, mailbox=p.sender))
        message = Message(
            account=account, subject=to_text(p.subject), body=HTMLBody(_html(p.body)),
            to_recipients=[Mailbox(email_address=a) for a in to], cc_recipients=[Mailbox(email_address=a) for a in cc],
        )
        for f in attachments:
            message.attach(FileAttachment(name=f.name, content=f.read_bytes()))
        message.send_and_save()
        return
    msg = EmailMessage()
    sender = to_text(p.sender).strip()
    if not sender and p.credential:
        sender = ctx.credential(p.credential).username
    if not sender or "@" not in sender:
        raise ActivityError("Enter the From address (SMTP) under More options.")
    msg["From"], msg["To"], msg["Subject"] = sender, ", ".join(to), to_text(p.subject)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg.set_content(to_text(p.body))
    for f in attachments:
        msg.add_attachment(f.read_bytes(), maintype="application", subtype="octet-stream", filename=f.name)
    try:
        with smtplib.SMTP(to_text(p.server).strip(), p.port, timeout=30) as smtp:
            smtp.ehlo()
            if p.use_tls and smtp.has_extn("starttls"):
                smtp.starttls()
                smtp.ehlo()
            if p.credential:
                cred = ctx.credential(p.credential)
                smtp.login(cred.username, str(cred.password))
            smtp.send_message(msg, to_addrs=to + cc)
    except smtplib.SMTPAuthenticationError:
        raise ActivityError("The mail server rejected the username or password.") from None
    except (smtplib.SMTPException, OSError) as exc:
        raise ActivityError(f"Could not send through {p.server}: {exc}") from None


def _html(text: str) -> str:
    from html import escape

    return "<div style='font-family:Segoe UI,Arial,sans-serif'>" + escape(to_text(text)).replace("\n", "<br>") + "</div>"


# -- reading (Exchange) ------------------------------------------------------------------------


class ReadParams(ExchangeParams):
    folder: str = Param("Inbox", title="Folder", placeholder="Inbox, or Inbox/Invoices")
    unread_only: bool = Param(True, title="Only unread messages")
    from_contains: str = Param("", title="From contains")
    subject_contains: str = Param("", title="Subject contains")
    max_count: int = Param(50, title="At most", ge=1, le=1000)
    mark_as_read: bool = Param(False, title="Mark them as read")
    message_id: str = Param(
        "", title="Only this message", advanced=True, placeholder='{{trigger_email["id"]}}',
        description="The id of one email, e.g. the one that started this run (email trigger). "
        "The other filters are then ignored.",
    )


def _folder(account: Any, path: str) -> Any:
    folder = account.inbox if path.strip().lower() in ("", "inbox") else account.root / "Top of Information Store"
    parts = [x for x in path.replace("\\", "/").split("/") if x]
    if parts and parts[0].lower() == "inbox":
        folder = account.inbox
        parts = parts[1:]
    for part in parts:
        try:
            folder = folder / part
        except Exception:
            raise ActivityError(f"The mail folder '{path}' was not found.") from None
    return folder


@activity(
    "email.read",
    title="Read emails",
    category=E,
    icon="mail-open",
    sentence="Read emails in {folder}",
    description="Get messages from an Exchange mailbox as a table (from, subject, received, text).",
    params=ReadParams,
    outputs=[OutputDef("messages", "Messages", "table", default_variable="emails")],
)
def read(ctx: RunContext, p: ReadParams) -> Table:
    account = _account(ctx, p)
    cache: dict[str, Any] = ctx.resources.setdefault("ews_messages", {})
    table = Table(["id", "from", "subject", "received", "text", "attachments"])
    if to_text(p.message_id).strip():
        items = [_fetch(account, to_text(p.message_id).strip())]
    else:
        items = find_messages(account, p.folder, unread_only=p.unread_only, subject_contains=p.subject_contains,
                              from_contains=p.from_contains, max_count=p.max_count)
    for item in items:
        cache[item.id] = item
        table.append(describe(item))
        if p.mark_as_read and not item.is_read:
            item.is_read = True
            item.save(update_fields=["is_read"])
    return table


def find_messages(account: Any, folder: str, *, unread_only: bool, subject_contains: str, from_contains: str,
                  max_count: int, since: Any = None) -> list[Any]:
    """Newest messages first. Also used by robots watching a mailbox (email triggers)."""
    query = _folder(account, folder).all()
    if unread_only:
        query = query.filter(is_read=False)
    if subject_contains:
        query = query.filter(subject__icontains=subject_contains)
    if since is not None:
        query = query.filter(datetime_received__gte=since)
    found: list[Any] = []
    wanted_from = from_contains.strip().casefold()
    # Exchange can't search inside sender addresses, so that filter is applied here.
    for item in query.order_by("-datetime_received")[: max_count * (5 if wanted_from else 1)]:
        sender = item.sender
        sender_text = f"{getattr(sender, 'name', '') or ''} {getattr(sender, 'email_address', '') or ''}".casefold()
        if wanted_from and wanted_from not in sender_text:
            continue
        if len(found) >= max_count:
            break
        found.append(item)
    return found


def describe(item: Any) -> dict[str, Any]:
    """An email as a row of 'Read emails' (and as the start value of an email trigger's run)."""
    return {
        "id": item.id,
        "from": getattr(item.sender, "email_address", "") if item.sender else "",
        "subject": item.subject or "",
        "received": item.datetime_received,
        "text": (item.text_body or "").strip(),
        "attachments": ", ".join(a.name for a in item.attachments or []),
    }


def _fetch(account: Any, message_id: str) -> Any:
    # As (id, changekey): exchangelib would turn a bare string into one id per character.
    item = next(iter(account.fetch(ids=[(message_id, None)])), None)
    if item is None or isinstance(item, Exception) or not hasattr(item, "subject"):
        raise ActivityError("That email was not found in the mailbox.", "It may have been moved or deleted.")
    return item


class AttachmentParams(Params):
    message: Any = Param(title="Message", ui="variable", description='A row from "Read emails" (e.g. the loop item).')
    folder: str = Param(title="Save to folder", ui="folder")
    pattern: str = Param("*", title="Only files named", placeholder="*.pdf")


@activity(
    "email.save_attachments",
    title="Save email attachments",
    category=E,
    icon="paperclip",
    sentence="Save attachments of {message} to {folder}",
    params=AttachmentParams,
    outputs=[OutputDef("files", "Saved files", "list", default_variable="attachment_files")],
)
def save_attachments(ctx: RunContext, p: AttachmentParams) -> list[str]:
    from exchangelib import FileAttachment

    item = _message(ctx, p.message)
    folder = Path(to_text(p.folder).strip())
    folder.mkdir(parents=True, exist_ok=True)
    saved = []
    for attachment in item.attachments or []:
        if isinstance(attachment, FileAttachment) and fnmatch.fnmatch(attachment.name.lower(), p.pattern.lower()):
            target = folder / Path(attachment.name).name
            target.write_bytes(attachment.content)
            saved.append(str(target))
    return saved


class MoveParams(Params):
    message: Any = Param(title="Message", ui="variable")
    folder: str = Param(title="Move to folder", placeholder="Inbox/Processed")


@activity(
    "email.move",
    title="Move email",
    category=E,
    icon="folder-input",
    sentence="Move {message} to {folder}",
    params=MoveParams,
)
def move(ctx: RunContext, p: MoveParams) -> None:
    item = _message(ctx, p.message)
    item.move(_folder(item.account, p.folder))


def _message(ctx: RunContext, value: Any) -> Any:
    message_id = value.get("id") if isinstance(value, dict) else to_text(value)
    item = ctx.resources.get("ews_messages", {}).get(message_id)
    if item is None:
        raise ActivityError("That email is not available.", 'Use a message from a "Read emails" step in this run.')
    return item
