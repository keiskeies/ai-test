"""测试用的 stdio MCP server：两个工具，其中 echo 带必填参数。"""

from mcp.server.mcpserver import MCPServer

server = MCPServer("fake-tools")


@server.tool(name="echo", description="回显文本")
def echo(text: str) -> str:
    return "echo:" + text


@server.tool(name="add", description="两数相加")
def add(a: int, b: int) -> int:
    return a + b


if __name__ == "__main__":
    server.run("stdio")
