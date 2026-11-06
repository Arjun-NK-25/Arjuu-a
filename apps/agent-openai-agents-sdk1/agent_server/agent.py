import logging
from contextlib import AsyncExitStack
from datetime import datetime
from typing import AsyncGenerator

import mlflow
from agents import Agent, Runner, function_tool, set_default_openai_api, set_default_openai_client
from agents.tracing import set_trace_processors
from databricks.sdk import WorkspaceClient
from databricks_openai import AsyncDatabricksOpenAI
from databricks_openai.agents import McpServer
from mlflow.genai.agent_server import invoke, stream
from mlflow.types.responses import (
    ResponsesAgentRequest,
    ResponsesAgentResponse,
    ResponsesAgentStreamEvent,
)

from agent_server.history import normalize_history_items
from agent_server.utils import (
    build_mcp_url,
    get_session_id,
    get_user_workspace_client,
    process_agent_stream_events,
)

logger = logging.getLogger(__name__)

# NOTE: this will work for all databricks models OTHER than GPT-OSS, which uses a slightly different API
set_default_openai_client(AsyncDatabricksOpenAI())
set_default_openai_api("chat_completions")
set_trace_processors([])  # only use mlflow for trace processing
mlflow.openai.autolog()
logging.getLogger("mlflow.utils.autologging_utils").setLevel(logging.ERROR)


@function_tool
def get_current_time() -> str:
    """Get the current date and time."""
    return datetime.now().isoformat()


async def init_mcp_server(workspace_client: WorkspaceClient):
    return McpServer(
        url=build_mcp_url("/api/2.0/mcp/functions/system/ai", workspace_client=workspace_client),
        name="system.ai UC function MCP server",
        workspace_client=workspace_client,
    )


async def connect_healthy_mcp_servers(
    stack: AsyncExitStack, servers: list[McpServer]
) -> tuple[list[McpServer], list[str]]:
    """Connect each MCP server and verify it can actually list its tools.

    The Agents SDK lists each server's tools lazily inside ``Runner.run``, so a server that
    connects but fails at list time (e.g. an unauthorized Genie space) would otherwise crash
    the whole request — including unrelated turns. We list tools here, per server: healthy
    servers are kept; any that fails to connect OR to list is dropped and its name returned,
    so the agent runs with whatever is available instead of erroring out.

    Returns (healthy_servers, unavailable_names).
    """
    healthy: list[McpServer] = []
    unavailable: list[str] = []
    for server in servers:
        name = getattr(server, "name", "MCP server")
        try:
            connected = await stack.enter_async_context(server)
            await connected.list_tools()  # forces the connectivity + authorization check now
            healthy.append(connected)
        except Exception:
            logger.warning("MCP server %r unavailable; continuing without it.", name, exc_info=True)
            unavailable.append(name)
    return healthy, unavailable


JARVIS_INSTRUCTIONS = """You are JARVIS, the AI assistant modelled after Tony Stark's JARVIS in the Iron Man films, running as a data & analytics assistant on Databricks.

Personality:
- Polished, understated British-butler elegance. Address the user as "sir" (adjust immediately if they prefer otherwise).
- Dry wit and subtle playful humour - never sycophantic, never over the top.
- Composed, confident, reassuring. Acknowledge mistakes gracefully ("my apologies, sir") and always suggest the next step.
- Proactive: anticipate what the user may need next and offer a follow-up.

Behaviour:
- Lead with the answer and keep it crisp; add a short flourish only when it fits.
- Be precise: use your tools (such as get_current_time) rather than guessing facts.
- Your domain of mastery is data and analytics: tables, queries, dashboards, Python, and the Databricks platform.
- Never claim abilities you do not have (no suit controls, home automation, or real-time systems). You have exactly the tools provided, nothing more.
- When a request is ambiguous, make the most reasonable assumption, state it briefly, and proceed.
"""


def create_agent(mcp_servers: list[McpServer] | None = None) -> Agent:
    return Agent(
        name="JARVIS",
        instructions=JARVIS_INSTRUCTIONS,
        model="databricks-llama-4-maverick",
        tools=[get_current_time],
        mcp_servers=mcp_servers or [],
    )


@invoke()
async def invoke_handler(request: ResponsesAgentRequest) -> ResponsesAgentResponse:
    if session_id := get_session_id(request):
        mlflow.update_current_trace(metadata={"mlflow.trace.session": session_id})
    # The agent runs inside an AsyncExitStack so any MCP servers stay open for the whole
    # request. To give the agent MCP tools, connect them with connect_healthy_mcp_servers,
    # which health-checks each server so one unavailable server can't crash the request
    # (the Agents SDK lists each server's tools lazily inside Runner.run):
    #   servers, unavailable = await connect_healthy_mcp_servers(
    #       stack, [await init_mcp_server(WorkspaceClient())])
    #   agent = create_agent(mcp_servers=servers)
    # WorkspaceClient() uses service principal credentials; use get_user_workspace_client()
    # for on-behalf-of user authentication.
    async with AsyncExitStack() as stack:
        agent = create_agent()
        messages = normalize_history_items([i.model_dump() for i in request.input])
        result = await Runner.run(agent, messages)
        return ResponsesAgentResponse(output=[item.to_input_item() for item in result.new_items])


@stream()
async def stream_handler(
    request: ResponsesAgentRequest,
) -> AsyncGenerator[ResponsesAgentStreamEvent, None]:
    if session_id := get_session_id(request):
        mlflow.update_current_trace(metadata={"mlflow.trace.session": session_id})
    # The agent runs inside an AsyncExitStack so any MCP servers stay open for the whole
    # request. To give the agent MCP tools, connect them with connect_healthy_mcp_servers,
    # which health-checks each server so one unavailable server can't crash the request
    # (the Agents SDK lists each server's tools lazily inside Runner.run):
    #   servers, unavailable = await connect_healthy_mcp_servers(
    #       stack, [await init_mcp_server(WorkspaceClient())])
    #   agent = create_agent(mcp_servers=servers)
    # WorkspaceClient() uses service principal credentials; use get_user_workspace_client()
    # for on-behalf-of user authentication.
    async with AsyncExitStack() as stack:
        agent = create_agent()
        messages = normalize_history_items([i.model_dump() for i in request.input])
        result = Runner.run_streamed(agent, input=messages)

        async for event in process_agent_stream_events(result.stream_events()):
            yield event
