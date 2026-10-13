"""Integrations (Brity "Net", "Outlook" and "FTP" libraries): answering emails, chat messages to
Teams / Slack, FTP / FTPS / SFTP file transfer and SSH commands."""

from __future__ import annotations

import contextlib
import fnmatch
import ftplib
import posixpath
from collections.abc import Iterator
from pathlib import Path
from typing import Any, Literal

from ..catalog import OutputDef, Param, Params, activity
from ..errors import ActivityError
from ..runtime.context import RunContext
from ..values import to_text
from .email import E, _addresses, _files, _message

# -- answering emails (Exchange) ----------------------------------------------------------------------


class AnswerParams(Params):
    message: Any = Param(title="Message", ui="variable", description='A row from "Read emails" (e.g. the loop item).')
    body: str = Param("", title="Message", ui="multiline")


class ReplyParams(AnswerParams):
    everyone: bool = Param(False, title="Reply to everyone")


@activity(
    "email.reply",
    title="Reply to email",
    category=E,
    icon="reply",
    sentence="Reply to {message}",
    description="Answer an email read with 'Read emails' (Brity ReplyMail). The original is quoted below.",
    params=ReplyParams,
)
def reply(ctx: RunContext, p: ReplyParams) -> None:
    item = _message(ctx, p.message)
    subject = item.subject or ""
    subject = subject if subject.lower().startswith("re:") else f"RE: {subject}"
    try:
        (item.reply_all if p.everyone else item.reply)(subject=subject, body=to_text(p.body))
    except Exception as exc:
        raise ActivityError(f"Exchange did not send the reply: {exc}") from None


class ForwardParams(AnswerParams):
    to: Any = Param(title="To", placeholder="name@company.com")


@activity(
    "email.forward",
    title="Forward email",
    category=E,
    icon="forward",
    sentence="Forward {message} to {to}",
    description="Forward an email read with 'Read emails', with its attachments (Brity ForwardMail).",
    params=ForwardParams,
)
def forward(ctx: RunContext, p: ForwardParams) -> None:
    item = _message(ctx, p.message)
    to = _addresses(p.to)
    if not to:
        raise ActivityError("There is nobody to forward to.", "Enter at least one email address.")
    try:
        item.forward(subject=f"FW: {item.subject or ''}", body=to_text(p.body), to_recipients=to)
    except Exception as exc:
        raise ActivityError(f"Exchange did not forward the email: {exc}") from None


class MarkParams(Params):
    message: Any = Param(title="Message", ui="variable", description='A row from "Read emails".')
    action: Literal["read", "unread", "delete"] = Param(
        "read", title="Do", labels={"read": "Mark as read", "unread": "Mark as unread", "delete": "Move to Deleted Items"},
    )


@activity(
    "email.mark",
    title="Mark or delete email",
    category=E,
    icon="mail-check",
    sentence="{action}: {message}",
    description="Mark an email as read / unread, or move it to Deleted Items (Brity DeleteMail).",
    params=MarkParams,
)
def mark(ctx: RunContext, p: MarkParams) -> None:
    item = _message(ctx, p.message)
    if p.action == "delete":
        item.move_to_trash()
        return
    item.is_read = p.action == "read"
    item.save(update_fields=["is_read"])


# -- chat messages ------------------------------------------------------------------------------------


class ChatParams(Params):
    service: Literal["teams", "slack", "webhook"] = Param(
        "teams", title="Send to", labels={"teams": "Microsoft Teams", "slack": "Slack", "webhook": "Another webhook"},
    )
    webhook: str = Param(title="Webhook", ui="credential",
                         description="A credential whose password is the channel's webhook address (it works like a "
                         "password, so it is kept in Credentials).")
    title: str = Param("", title="Title", placeholder="Invoices processed")
    message: str = Param(title="Message", ui="multiline", placeholder="{{COUNT(rows)}} invoices were entered.")


@activity(
    "web.chat_message",
    title="Send Teams or Slack message",
    category="Web & APIs",
    icon="message-circle",
    sentence="Send {message} to {service}",
    description="Post a message in a Teams or Slack channel, e.g. when a run finishes or needs attention.",
    params=ChatParams,
)
def chat_message(ctx: RunContext, p: ChatParams) -> None:
    import httpx

    url = str(ctx.credential(p.webhook).password).strip()
    local = url.lower().startswith(("http://127.0.0.1", "http://localhost"))
    if not (url.lower().startswith("https://") or local):
        raise ActivityError("The webhook credential's password must be the webhook address (https://...).")
    title, text = to_text(p.title), to_text(p.message)
    if p.service == "teams":
        blocks = ([{"type": "TextBlock", "text": title, "weight": "Bolder", "size": "Medium", "wrap": True}]
                  if title else []) + [{"type": "TextBlock", "text": text, "wrap": True}]
        payload: dict[str, Any] = {"type": "message", "attachments": [{
            "contentType": "application/vnd.microsoft.card.adaptive",
            "content": {"$schema": "http://adaptivecards.io/schemas/adaptive-card.json", "type": "AdaptiveCard",
                        "version": "1.4", "body": blocks},
        }]}
    elif p.service == "slack":
        payload = {"text": f"*{title}*\n{text}" if title else text}
    else:
        payload = {"title": title, "text": text}
    try:
        response = httpx.post(url, json=payload, timeout=30)
    except httpx.HTTPError as exc:
        raise ActivityError(f"Could not reach the webhook: {exc}") from None
    if response.status_code >= 400:
        raise ActivityError(f"The chat service refused the message ({response.status_code}): {response.text[:200]}")


# -- FTP / FTPS / SFTP (Brity FTP library) -------------------------------------------------------------------


F = "FTP & SSH"


class ServerParams(Params):
    protocol: Literal["sftp", "ftps", "ftp"] = Param(
        "sftp", title="Kind of server",
        labels={"sftp": "SFTP (over SSH)", "ftps": "FTPS (FTP with encryption)", "ftp": "FTP (not encrypted)"},
    )
    host: str = Param(title="Server", placeholder="ftp.supplier.com")
    port: int = Param(0, title="Port", ge=0, le=65535, advanced=True, description="0 = the usual one (22 / 21).")
    credential: str = Param(title="Credential", ui="credential")


class _Remote:
    """One way to talk to FTP / FTPS / SFTP servers."""

    def __init__(self, client: Any, sftp: bool):
        self.client, self.sftp = client, sftp

    def list(self, folder: str) -> list[str]:
        if self.sftp:
            return sorted(self.client.listdir(folder or "."))
        return sorted(posixpath.basename(n) for n in self.client.nlst(folder or "."))

    def get(self, remote: str, local: Path) -> None:
        if self.sftp:
            self.client.get(remote, str(local))
        else:
            with local.open("wb") as handle:
                self.client.retrbinary(f"RETR {remote}", handle.write)

    def put(self, local: Path, remote: str) -> None:
        if self.sftp:
            self.client.put(str(local), remote)
        else:
            with local.open("rb") as handle:
                self.client.storbinary(f"STOR {remote}", handle)

    def delete(self, remote: str) -> None:
        if self.sftp:
            self.client.remove(remote)
        else:
            self.client.delete(remote)


@contextlib.contextmanager
def _connect(ctx: RunContext, p: ServerParams) -> Iterator[_Remote]:
    cred = ctx.credential(p.credential)
    host = to_text(p.host).strip()
    if not host:
        raise ActivityError("No server was given.")
    try:
        if p.protocol == "sftp":
            import paramiko

            transport = paramiko.Transport((host, p.port or 22))
            try:
                transport.connect(username=cred.username, password=str(cred.password))
                client = paramiko.SFTPClient.from_transport(transport)
                try:
                    yield _Remote(client, sftp=True)
                finally:
                    client.close()
            finally:
                transport.close()
            return
        ftp = ftplib.FTP_TLS(timeout=60) if p.protocol == "ftps" else ftplib.FTP(timeout=60)
        try:
            ftp.connect(host, p.port or 21)
            ftp.login(cred.username, str(cred.password))
            if isinstance(ftp, ftplib.FTP_TLS):
                ftp.prot_p()
            yield _Remote(ftp, sftp=False)
        finally:
            with contextlib.suppress(Exception):
                ftp.quit()
    except ActivityError:
        raise
    except ftplib.error_perm as exc:
        raise ActivityError(f"The server refused: {exc}") from None
    except Exception as exc:
        name = type(exc).__name__
        if "Authentication" in name:
            raise ActivityError("The server rejected the username or password.", "Check the credential.") from None
        raise ActivityError(f"Could not work with {host}: {exc}",
                            "Check the server name, the kind of server and the port.") from None


class FtpListParams(ServerParams):
    folder: str = Param("", title="Folder on the server", placeholder="/outgoing")
    pattern: str = Param("*", title="Name pattern", placeholder="*.csv")


@activity(
    "ftp.list",
    title="List files on server",
    category=F,
    icon="folder-tree",
    sentence="List {pattern} in {folder} on {host}",
    description="The file names in a folder of an FTP / SFTP server (Brity GetFTPFileList).",
    params=FtpListParams,
    outputs=[OutputDef("files", "Files", "list", default_variable="server_files")],
)
def ftp_list(ctx: RunContext, p: FtpListParams) -> list[str]:
    with _connect(ctx, p) as remote:
        return [n for n in remote.list(to_text(p.folder).strip()) if fnmatch.fnmatch(n.lower(), to_text(p.pattern).lower() or "*")]


class FtpDownloadParams(FtpListParams):
    to_folder: str = Param(title="Save in", ui="folder")
    delete_after: bool = Param(False, title="Delete them from the server afterwards", advanced=True)


@activity(
    "ftp.download",
    title="Download from server",
    category=F,
    icon="download",
    sentence="Download {pattern} from {host}",
    description="Download files from an FTP / SFTP server (Brity DownloadFTPFile).",
    params=FtpDownloadParams,
    outputs=[OutputDef("files", "Files", "list", default_variable="downloaded")],
)
def ftp_download(ctx: RunContext, p: FtpDownloadParams) -> list[str]:
    target = Path(to_text(p.to_folder)).expanduser()
    target.mkdir(parents=True, exist_ok=True)
    folder = to_text(p.folder).strip()
    saved = []
    with _connect(ctx, p) as remote:
        for name in remote.list(folder):
            if not fnmatch.fnmatch(name.lower(), to_text(p.pattern).lower() or "*"):
                continue
            path = posixpath.join(folder, name) if folder else name
            local = target / name
            remote.get(path, local)
            saved.append(str(local))
            if p.delete_after:
                remote.delete(path)
    return saved


class FtpUploadParams(ServerParams):
    files: Any = Param(title="Files", ui="variable", description="A file, or a list of files.")
    folder: str = Param("", title="Folder on the server", placeholder="/incoming")


@activity(
    "ftp.upload",
    title="Upload to server",
    category=F,
    icon="upload",
    sentence="Upload {files} to {host}",
    description="Upload files to an FTP / SFTP server (Brity UploadFTPFile).",
    params=FtpUploadParams,
)
def ftp_upload(ctx: RunContext, p: FtpUploadParams) -> None:
    files = _files(p.files)
    if not files:
        raise ActivityError("There are no files to upload.")
    folder = to_text(p.folder).strip()
    with _connect(ctx, p) as remote:
        for local in files:
            remote.put(local, posixpath.join(folder, local.name) if folder else local.name)


class FtpDeleteParams(ServerParams):
    file: str = Param(title="File on the server", placeholder="/outgoing/report.csv")


@activity(
    "ftp.delete",
    title="Delete file on server",
    category=F,
    icon="trash",
    sentence="Delete {file} on {host}",
    params=FtpDeleteParams,
)
def ftp_delete(ctx: RunContext, p: FtpDeleteParams) -> None:
    with _connect(ctx, p) as remote:
        remote.delete(to_text(p.file).strip())


# -- SSH commands (Brity OpenSSH / SendCommandSSH) -----------------------------------------------------------


class SshParams(Params):
    host: str = Param(title="Server", placeholder="linux01.company.local")
    port: int = Param(22, title="Port", ge=1, le=65535, advanced=True)
    credential: str = Param(title="Credential", ui="credential")
    command: str = Param(title="Command", ui="code", placeholder="df -h /data")
    timeout: float = Param(300, title="Stop it after (seconds)", ge=1, le=86_400, ui="duration", advanced=True)
    fail_on_error: bool = Param(True, title="Fail when it reports an error (exit code not 0)", advanced=True)


@activity(
    "ssh.run",
    title="Run command over SSH",
    category=F,
    icon="terminal",
    sentence="Run {command} on {host}",
    description="Run a command on a Linux / Unix server and keep what it printed. Only administrators can publish "
    "automations with this step.",
    params=SshParams,
    outputs=[
        OutputDef("output", "Output", "text", default_variable="ssh_output"),
        OutputDef("exit_code", "Exit code", "number", default_variable="ssh_exit_code"),
    ],
    requires="scripts",
)
def ssh_run(ctx: RunContext, p: SshParams) -> dict[str, Any]:
    import paramiko

    cred = ctx.credential(p.credential)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.WarningPolicy())
    try:
        client.connect(to_text(p.host).strip(), port=p.port, username=cred.username, password=str(cred.password),
                       timeout=30, allow_agent=False, look_for_keys=False)
        _stdin, stdout, stderr = client.exec_command(to_text(p.command), timeout=p.timeout)
        code = stdout.channel.recv_exit_status()
        output = (stdout.read().decode("utf-8", "replace") + stderr.read().decode("utf-8", "replace")).strip()
    except paramiko.AuthenticationException:
        raise ActivityError("The server rejected the username or password.", "Check the credential.") from None
    except (paramiko.SSHException, OSError) as exc:
        raise ActivityError(f"Could not run the command on {p.host}: {exc}") from None
    finally:
        client.close()
    if p.fail_on_error and code != 0:
        raise ActivityError(f"The command failed (exit code {code}): {output[-500:] or 'no output'}")
    return {"output": output, "exit_code": code}
