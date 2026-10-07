"""Web services (REST APIs) and SQL databases."""

from __future__ import annotations

import json
from typing import Any, Literal

from ..catalog import OutputDef, Param, Params, activity
from ..errors import ActivityError
from ..runtime.context import RunContext
from ..values import Table, to_text

W = "Web & APIs"
D = "Database"


class RequestParams(Params):
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"] = Param("GET", title="Method")
    url: str = Param(title="Address", ui="url", placeholder="https://api.example.com/orders")
    query: dict[str, Any] = Param(default_factory=dict, title="Query values", ui="key_values")
    headers: dict[str, Any] = Param(default_factory=dict, title="Headers", ui="key_values", advanced=True)
    body: Any = Param(None, title="Body (JSON)", ui="code", placeholder='{"customer": "{{customer}}"}')
    credential: str = Param("", title="Sign in with credential (basic auth)", ui="credential", advanced=True)
    bearer_token: str = Param("", title="Bearer token", advanced=True)
    timeout: float = Param(30, title="Wait up to (seconds)", ge=1, le=600, advanced=True)
    fail_on_error: bool = Param(True, title="Fail when the server answers with an error (4xx/5xx)")


@activity(
    "http.request",
    title="Call web service (API)",
    category=W,
    icon="plug",
    sentence="{method} {url}",
    description="Send a request to a REST API and use the answer. JSON answers become records and tables.",
    params=RequestParams,
    outputs=[
        OutputDef("response", "Response body", "any", default_variable="response"),
        OutputDef("status", "Status code", "number", default_variable="status_code"),
    ],
)
def request(ctx: RunContext, p: RequestParams) -> dict[str, Any]:
    import httpx

    auth = None
    if p.credential:
        cred = ctx.credential(p.credential)
        auth = (cred.username, str(cred.password))
    headers = {k: to_text(v) for k, v in p.headers.items()}
    if p.bearer_token:
        headers["Authorization"] = f"Bearer {p.bearer_token}"
    body = p.body
    if isinstance(body, str) and body.strip():
        try:
            body = json.loads(body)
        except json.JSONDecodeError:
            raise ActivityError("The body is not valid JSON.", 'Example: {"name": "Acme"}') from None
    try:
        response = httpx.request(
            p.method, to_text(p.url).strip(), params={k: to_text(v) for k, v in p.query.items()},
            headers=headers, json=body if body not in (None, "") else None, auth=auth, timeout=p.timeout,
        )
    except httpx.ConnectError:
        raise ActivityError(f"Could not connect to {p.url}.", "Check the address and the network.") from None
    except httpx.TimeoutException:
        raise ActivityError(f"{p.url} did not answer within {p.timeout:g} seconds.") from None
    try:
        data: Any = response.json()
    except ValueError:
        data = response.text
    if isinstance(data, list) and data and all(isinstance(r, dict) for r in data):
        data = Table(rows=data)
    if p.fail_on_error and response.status_code >= 400:
        detail = data if isinstance(data, str) else json.dumps(data, default=str)[:300]
        raise ActivityError(f"The server answered {response.status_code}: {detail[:300]}")
    return {"response": data, "status": response.status_code}


# -- databases ----------------------------------------------------------------------------


class QueryParams(Params):
    connection: str = Param(
        title="Database", ui="multiline",
        placeholder="mssql+pyodbc://server/db?driver=ODBC+Driver+18+for+SQL+Server&trusted_connection=yes",
        description="A connection string. Ask IT for it. Use a credential below instead of a password inside it.",
    )
    credential: str = Param("", title="Sign in with credential", ui="credential")
    sql: str = Param(title="SQL", ui="code", placeholder="SELECT * FROM orders WHERE status = :status")
    parameters: dict[str, Any] = Param(default_factory=dict, title="Values for :names in the SQL", ui="key_values")


def _engine(ctx: RunContext, p: QueryParams):
    from sqlalchemy import create_engine
    from sqlalchemy.engine import make_url

    try:
        url = make_url(to_text(p.connection).strip())
    except Exception:
        raise ActivityError("The database connection string is not valid.") from None
    if p.credential:
        cred = ctx.credential(p.credential)
        url = url.set(username=cred.username, password=str(cred.password))
    return create_engine(url, pool_pre_ping=True)


def _run_sql(ctx: RunContext, p: QueryParams, fetch: bool) -> Any:
    from sqlalchemy import text
    from sqlalchemy.exc import SQLAlchemyError

    engine = _engine(ctx, p)
    try:
        with engine.begin() as conn:
            result = conn.execute(text(p.sql), dict(p.parameters))
            if fetch:
                columns = list(result.keys())
                return Table(columns, [dict(zip(columns, row, strict=True)) for row in result.fetchall()])
            return result.rowcount
    except SQLAlchemyError as exc:
        message = str(getattr(exc, "orig", exc)).splitlines()[0][:300]
        raise ActivityError(f"The database reported: {message}") from None
    finally:
        engine.dispose()


@activity(
    "db.query",
    title="Read from database",
    category=D,
    icon="database",
    sentence="Run query on database",
    description="Run a SELECT query and get the rows as a table.",
    params=QueryParams,
    outputs=[OutputDef("table", "Rows", "table", default_variable="query_rows")],
)
def query(ctx: RunContext, p: QueryParams) -> Table:
    return _run_sql(ctx, p, fetch=True)


@activity(
    "db.execute",
    title="Change data in database",
    category=D,
    icon="database-zap",
    sentence="Run SQL on database",
    description="Run INSERT, UPDATE or DELETE. Changes are saved only if the statement succeeds.",
    params=QueryParams,
    advanced=True,
    outputs=[OutputDef("count", "Rows changed", "number", default_variable="rows_changed")],
)
def execute(ctx: RunContext, p: QueryParams) -> int:
    return _run_sql(ctx, p, fetch=False)
