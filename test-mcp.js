require("dotenv").config();
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

async function main() {
  const client = new Client({ name: "test", version: "1.0" });
  await client.connect(new StreamableHTTPClientTransport(
    new URL("https://install.crustdata.com/mcp"),
    { requestInit: { headers: { Authorization: "Bearer " + process.env.CRUSTDATA_API_KEY } } }
  ));

  // Test the correct callTool pattern inside the sandbox
  const result = await client.callTool({
    name: "execute",
    arguments: {
      code: `
// user query: find AI startups in USA to discover their investors
const r = await callTool("company_search", {
  filters: and_(
    eq("taxonomy.professional_network_industry", "Artificial Intelligence"),
    eq("locations.country", "USA")
  ),
  fields: ["basic_info", "funding"],
  limit: 3
});
if (!r.ok) return { error: r.message };
return firstArray(r.data).map(c => ({
  name: c.basic_info.name,
  investors: (c.funding?.investors ?? []).slice(0, 2)
}));
`
    }
  });

  console.log("MCP test result:", result.content[0].text.slice(0, 800));
  await client.close();
  process.exit(0);
}

main().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
