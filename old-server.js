/**
 * server.js — VC Finder backend
 *
 * Architecture:
 *  - Groq (OpenAI-compatible Chat Completions) drives the agentic loop with function calling
 *  - Crustdata MCP server handles data fetching via its `execute` tool
 *  - The MCP sandbox uses:  const r = await callTool(toolName, params)
 *  - The model writes the JS scripts; we run them via MCP; results go back to the model
 *  - Loop until the model emits a final JSON answer with no more tool calls
 */

require("dotenv").config();
const express = require("express");
const path = require("path");
const OpenAI = require("openai");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Groq client (OpenAI-compatible) ───────────────────────────────────────────
const groq = new OpenAI({
  apiKey:  process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// Model used for the agentic tool-calling loop and email generation.
const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

// ── MCP client factory ────────────────────────────────────────────────────────
async function createMcpClient() {
  const client    = new Client({ name: "vc-finder", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("https://install.crustdata.com/mcp"),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${process.env.CRUSTDATA_API_KEY}` },
      },
    }
  );
  await client.connect(transport);
  return client;
}

// ── Tool the model can call ───────────────────────────────────────────────────
// The model writes JS; we run it in the Crustdata MCP sandbox.
// The sandbox uses:  const r = await callTool("tool_name", params)
const TOOLS = [
  {
    type: "function",
    function: {
      name: "crustdata_execute",
      description: `Run a JavaScript script in the Crustdata MCP sandbox to fetch investor data.

SANDBOX RULES:
- API calls use:  const r = await callTool("tool_name", params)
- Always check r.ok before using r.data; read data with firstArray(r.data)
- Preloaded helpers (no await needed): eq, ne, gt, gte, lt, lte, in_, nin_, contains,
  and_, or_, not_, between, any_of, firstArray, project, pick, compact,
  profileUrl, businessEmails
- Only await: callTool, sleep, paginate, parallelMap
- Script MUST start with: // user query: <description>  and END with a return statement
- Keep each script SHORT and simple (one logical step).

CRITICAL VALUE RULES (guessed values silently return ZERO rows):
- locations.country MUST be an ISO alpha-3 code: "USA", "GBR", "CAN", "IND", "DEU", etc.
- Categorical columns (basic_info.industries, taxonomy.professional_network_industry)
  MUST be resolved FIRST with company_autocomplete before filtering. Never guess them.

AVAILABLE TOOLS (call via callTool):
  company_autocomplete — resolve exact categorical values. params: { field, query }
    e.g. callTool("company_autocomplete", { field: "taxonomy.professional_network_industry", query: "marketing" })
  company_search — find companies. params: { filters, fields, limit }
    Valid filter columns: basic_info.industries, taxonomy.professional_network_industry,
      taxonomy.categories, basic_info.year_founded, basic_info.employee_count_range,
      headcount.total, locations.country, locations.headquarters,
      funding.last_round_type, funding.total_investment_usd
    Valid fields (groups): basic_info, funding, headcount, locations, taxonomy, revenue
    funding shape: { last_round_type, last_round_amount_usd, last_fundraise_date,
      total_investment_usd, investors: [ ... ] }
  person_search — find people (investors/partners). params: { filters, fields, limit }
    Valid filter columns: basic_profile.name, basic_profile.headline,
      experience.employment_details.company_name, experience.employment_details.title,
      experience.employment_details.seniority_level, basic_profile.location.country
    Valid fields (groups): basic_profile, contact, social_handles, experience
    LinkedIn URL is at: social_handles.professional_network_identifier.profile_url
  person_contact_enrich — get emails. params: { professional_network_profile_urls: [url], fields: ["contact"] }
    returns contact: { business_emails: [...], personal_emails: [...] }

EXAMPLE (industry resolution + company search):
  // user query: find funded marketing-tech companies in the USA
  const ac = await callTool("company_autocomplete", {
    field: "taxonomy.professional_network_industry", query: "marketing"
  });
  const industry = firstArray(ac.data)?.[0]?.value ?? firstArray(ac.data)?.[0];
  const r = await callTool("company_search", {
    filters: and_(
      eq("taxonomy.professional_network_industry", industry),
      eq("locations.country", "USA")
    ),
    fields: ["basic_info", "funding"],
    limit: 5
  });
  if (!r.ok) return { error: r.message };
  return firstArray(r.data).map(c => ({
    name: c.basic_info?.name,
    last_round: c.funding?.last_round_type,
    investors: (c.funding?.investors ?? []).slice(0, 5)
  }));`,
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "JavaScript code for the Crustdata sandbox. Must start with a `// user query:` or `// model query:` comment and end with `return`.",
          },
        },
        required: ["code"],
      },
    },
  },
];

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert venture-capital researcher.
Given a startup description and/or website URL, find the 3 best-fit individual
investors using the crustdata_execute tool. Make ONE tool call per step and inspect
the result before the next step. Never guess categorical or country values.

Workflow — run these steps in order using crustdata_execute:
0. Infer the startup's industry, geography, and funding stage from the input.

1. RESOLVE the industry value with company_autocomplete
   (field: "taxonomy.professional_network_industry", query: <your industry guess>).
   Use the returned exact value in the next step.

2. company_search for 3-5 FUNDED companies similar to the startup, filtering by the
   resolved industry and locations.country (ISO alpha-3, e.g. "USA").
   Request fields: ["basic_info","funding"]. Collect investor names from funding.investors
   and note each company's funding.last_round_type.

3. person_search for those investors as people. Filter by
   experience.employment_details.company_name (their VC firm) and, if helpful,
   experience.employment_details.seniority_level (e.g. "Partner").
   Request fields: ["basic_profile","experience","social_handles","contact"].
   Get the LinkedIn URL from social_handles.professional_network_identifier.profile_url.

4. person_contact_enrich the top 3-4 candidates using their LinkedIn URL
   (professional_network_profile_urls: [url], fields: ["contact"]) to get emails.

5. Rank the 3 best investor matches by relevance to the startup.

If a search returns an empty array, adjust the resolved value or relax a filter and retry
(do not give up after one empty result). If you cannot find an email or LinkedIn, use null.

After ALL tool calls are complete, respond ONLY with this exact JSON (no markdown fences,
no explanation text before or after):
{
  "investors": [
    {
      "name": "string",
      "company": "string",
      "role": "string",
      "linkedin": "string or null",
      "email": "string or null",
      "investment_firm": "string",
      "recent_investment": "string",
      "funding_round": "string",
      "why_fit": "2-3 sentence explanation"
    }
  ]
}`;

// ── Execute code in MCP sandbox ───────────────────────────────────────────────
async function mcpExecute(mcpClient, code) {
  console.log("  → MCP execute:", code.split("\n")[1]?.trim() ?? code.slice(0, 80));
  const result = await mcpClient.callTool({
    name:      "execute",
    arguments: { code },
  });
  const text = (result.content ?? []).map((c) => c.text).join("\n");
  console.log("  ← result:", text.slice(0, 200));
  return text;
}

// ── Parse model JSON output ───────────────────────────────────────────────────
function parseJson(text) {
  const raw   = (text ?? "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Model did not return valid JSON");
  return JSON.parse(match[0]);
}

// ── Agentic loop ──────────────────────────────────────────────────────────────
async function runAgentLoop(userMessage) {
  const mcpClient = await createMcpClient();

  try {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: userMessage },
    ];
    const MAX_ROUNDS = 10; // safety cap
    let toolCallRetries = 0;
    const MAX_TOOL_CALL_RETRIES = 2;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      console.log(`  [round ${round + 1}] calling Groq...`);

      let response;
      try {
        response = await groq.chat.completions.create({
          model:       MODEL,
          messages,
          tools:       TOOLS,
          tool_choice: "auto",
          temperature: 0,
        });
      } catch (err) {
        // Groq returns 400 "Failed to call a function" when the model emits a
        // malformed tool call (invalid JSON args). The raw attempt is in
        // err.error.failed_generation. Log it and nudge the model to retry.
        const failedGeneration =
          err?.error?.failed_generation ??
          err?.response?.data?.error?.failed_generation;
        const isToolCallError =
          err?.status === 400 &&
          /failed to call a function/i.test(err?.message || "");

        if (isToolCallError && toolCallRetries < MAX_TOOL_CALL_RETRIES) {
          toolCallRetries++;
          console.warn(
            `  [round ${round + 1}] Groq rejected a malformed tool call ` +
            `(retry ${toolCallRetries}/${MAX_TOOL_CALL_RETRIES}).`
          );
          if (failedGeneration) {
            console.warn("  failed_generation:", String(failedGeneration).slice(0, 500));
          }
          messages.push({
            role: "user",
            content:
              "Your previous tool call was malformed and could not be parsed. " +
              "When calling crustdata_execute, put the ENTIRE JavaScript program " +
              "into the single `code` string argument as valid, properly escaped " +
              "JSON. Keep the script short and simple. Try again now.",
          });
          round--; // don't consume a round on a malformed-call retry
          continue;
        }
        throw err;
      }

      const message   = response.choices?.[0]?.message;
      const toolCalls = message?.tool_calls ?? [];

      // Add assistant turn to history (must include tool_calls if present)
      messages.push(message);

      // No tool calls → the model finished, return its text
      if (toolCalls.length === 0) {
        console.log(`  [round ${round + 1}] Groq done (no tool calls).`);
        return message?.content ?? "";
      }

      console.log(`  [round ${round + 1}] ${toolCalls.length} tool call(s) requested.`);

      // Execute all tool calls (may be parallel)
      const toolResults = await Promise.all(
        toolCalls.map(async (call) => {
          const name = call.function?.name;
          let resultText;

          if (name === "crustdata_execute") {
            let code = "";
            try {
              code = JSON.parse(call.function.arguments || "{}").code || "";
            } catch (_) {
              code = "";
            }
            resultText = code
              ? await mcpExecute(mcpClient, code)
              : JSON.stringify({ error: "Missing `code` argument." });
          } else {
            resultText = JSON.stringify({ error: `Unknown tool: ${name}` });
          }

          return {
            role:          "tool",
            tool_call_id:  call.id,
            content:       resultText,
          };
        })
      );

      // Feed results back to the model
      messages.push(...toolResults);
    }

    throw new Error("Agent loop reached max rounds without finishing.");
  } finally {
    try { await mcpClient.close(); } catch (_) {}
  }
}

// ── POST /api/find-investors ──────────────────────────────────────────────────
app.post("/api/find-investors", async (req, res) => {
  const { description, url } = req.body;

  if (!description?.trim() && !url?.trim()) {
    return res.status(400).json({ error: "Provide a startup description or website URL." });
  }

  const userMessage = [
    description?.trim() && `Startup description:\n${description.trim()}`,
    url?.trim()         && `Startup website: ${url.trim()}`,
  ].filter(Boolean).join("\n\n");

  try {
    console.log("\n=== /api/find-investors ===");
    console.log("Input:", userMessage.slice(0, 120));

    const finalText = await runAgentLoop(userMessage);
    console.log("Final text from Groq:", finalText.slice(0, 300));

    const parsed = parseJson(finalText);

    if (!Array.isArray(parsed?.investors) || parsed.investors.length === 0) {
      return res.status(500).json({
        error: "No investors found. Try a more detailed description.",
      });
    }

    return res.json({ investors: parsed.investors.slice(0, 3) });
  } catch (err) {
    console.error("Error in find-investors:", err?.message || err);
    return res.status(err?.status || 500).json({
      error: err?.message || "Something went wrong. Please try again.",
    });
  }
});

// ── POST /api/generate-email ──────────────────────────────────────────────────
app.post("/api/generate-email", async (req, res) => {
  const { investor, startupDescription } = req.body;

  if (!investor) {
    return res.status(400).json({ error: "Investor data required." });
  }

  const prompt = `Write a concise, friendly cold outreach email from a founder to this investor.

Investor: ${investor.name} (${investor.role} at ${investor.investment_firm})
Why they fit: ${investor.why_fit}
Recent investment: ${investor.recent_investment} (${investor.funding_round})

Startup context:
${startupDescription || "A promising early-stage startup."}

Rules:
- Subject: under 10 words, intriguing
- Body: 3 short paragraphs, no fluff, 150 words max
- Mention their recent investment naturally
- End with a soft CTA (15-min call)

Respond ONLY with JSON (no markdown):
{ "subject": "...", "body": "..." }`;

  try {
    const response = await groq.chat.completions.create({
      model:           MODEL,
      messages: [
        { role: "system", content: "You are a helpful assistant that writes outreach emails and always responds with valid JSON." },
        { role: "user",   content: prompt },
      ],
      response_format: { type: "json_object" },
    });

    const text = response.choices?.[0]?.message?.content ?? "";
    return res.json(parseJson(text));
  } catch (err) {
    console.error("Error generating email:", err?.message || err);
    return res.status(err?.status || 500).json({ error: "Could not generate email." });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VC Finder running → http://localhost:${PORT}`));
