import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function runTest() {
  console.log("Starting MCP Client Simulator...");

  const serverPath = new URL("../dist/index.js", import.meta.url).pathname;

  // Spawns the local MCP server over stdio
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: {
      ...process.env,
      HUB_URL: "http://localhost:34010/api/ingest",
      SEARCH_URL: "http://localhost:34010/api/search"
    }
  });

  const client = new Client({
    name: "test-client-cursor",
    version: "1.0.0"
  }, {
    capabilities: {}
  });

  try {
    console.log("Connecting to MCP Server...");
    await client.connect(transport);

    console.log("Connected! Fetching tools...");
    const tools = await client.listTools();
    console.log("Available tools:", tools.tools.map(t => t.name));

    console.log("\n--- Executing publish_knowledge ---");
    const submitResult = await client.callTool({
      name: "publish_knowledge",
      arguments: {
        title: "Docker Federation Sync Issue",
        content: "Added docker-compose.yml to spin up Hub-Alpha and Hub-Beta",
        status: "resolved"
      }
    });
    console.log("Result:", submitResult.content[0].text);

    // Give the Hub a second to index
    await new Promise(resolve => setTimeout(resolve, 1000));

    console.log("\n--- Executing search_knowledge ---");
    const queryResult = await client.callTool({
      name: "search_knowledge",
      arguments: {
        query: "Docker Federation"
      }
    });
    console.log("Query Result:\n", queryResult.content[0].text);

  } catch (error) {
    console.error("Test failed:", error);
    process.exit(1);
  } finally {
    // Cleanup
    await client.close();
    process.exit(0);
  }
}

runTest();
