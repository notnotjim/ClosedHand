// lib/mcp.js — MCP server connection and tool dispatch

const fs = require("fs");
const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const ctx = require("./context");

const BOT_DIR = path.resolve(__dirname, "..");
const MCP_CONFIG_PATH = path.join(BOT_DIR, "mcp-library", "servers.json");

async function connectAllMCPServers() {
  if (!fs.existsSync(MCP_CONFIG_PATH)) {
    return; // No MCP servers configured — skip silently
  }

  try {
    const raw = fs.readFileSync(MCP_CONFIG_PATH, "utf-8");
    ctx.mcpConfig = JSON.parse(raw);
  } catch (error) {
    console.error("Could not read MCP config:", error.message);
    return;
  }

  for (const [name, server] of Object.entries(ctx.mcpConfig.servers)) {
    if (server.enabled === false) {
      console.log(`Skipping disabled MCP server: ${name}`);
      continue;
    }

    try {
      console.log(`Connecting to MCP server: ${name}...`);

      const client = new Client({
        name: `closedhand-${name}`,
        version: "1.0.0",
      });

      const command = path.resolve(BOT_DIR, server.command);
      const args = (server.args || []).map((arg) => path.resolve(BOT_DIR, arg));

      const transport = new StdioClientTransport({
        command: command,
        args: args,
      });

      await client.connect(transport);

      const toolsResult = await client.listTools();
      const tools = toolsResult.tools;

      ctx.mcpClients[name] = { client, tools };

      // Tag each tool with its server name AND groups
      for (const tool of tools) {
        ctx.allMcpTools.push({
          ...tool,
          _serverName: name,
          _groups: server.groups || ["general"],
        });
      }

      console.log(`  Connected! Tools: ${tools.map((t) => t.name).join(", ")} [groups: ${(server.groups || ["general"]).join(", ")}]`);
    } catch (error) {
      console.error(`  Failed to connect ${name}: ${error.message}`);
    }
  }

  console.log(`Total MCP tools available: ${ctx.allMcpTools.length}`);
}

async function callMCPTool(toolName, toolInput) {
  const tool = ctx.allMcpTools.find((t) => t.name === toolName);
  if (!tool) {
    return { error: `Unknown tool: ${toolName}` };
  }

  const serverInfo = ctx.mcpClients[tool._serverName];
  if (!serverInfo) {
    return { error: `MCP server not connected: ${tool._serverName}` };
  }

  try {
    const result = await serverInfo.client.callTool({
      name: toolName,
      arguments: toolInput,
    });

    return result;
  } catch (error) {
    return { error: error.message };
  }
}

module.exports = {
  connectAllMCPServers,
  callMCPTool,
};
