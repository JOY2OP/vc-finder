/**
 * server.js — VC Finder Backend (v3.1: Deterministic Pipeline with Fixed Syntax)
 *
 * Architecture:
 * - Deterministic, backend-controlled execution flow (No LLM tool routing).
 * - Puppeteer for lightweight homepage scraping (no Crustdata Web APIs used).
 * - Groq used strictly for: (1) Startup text analysis, (2) Final investor ranking.
 * - Strict error boundaries: Aborts immediately on Crustdata 400/401/403 errors.
 * - Corrected Crustdata screener filter syntax (filter_type, type, value).
 */

require("dotenv").config();
const express = require("express");
const path = require("path");
const axios = require("axios");
const OpenAI = require("openai");
const puppeteer = require("puppeteer");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Clients ───────────────────────────────────────────────────────────────────
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});
const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const crustdata = axios.create({
  baseURL: "https://api.crustdata.com",
  headers: {
    Authorization: `Bearer ${process.env.CRUSTDATA_API_KEY}`,
    "Content-Type": "application/json",
    "x-api-version": "2025-11-01",
  },
  timeout: 25000,
});

// Intercept responses to immediately abort on schema/auth errors
crustdata.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    if ([400, 401, 403, 422].includes(status)) {
      const errMessage = JSON.stringify(error.response?.data || error.message);
      const fatalError = new Error(`Crustdata API Fatal Error (${status}): ${errMessage}`);
      fatalError.isFatal = true;
      throw fatalError;
    }
    throw error;
  }
);

// ── Crustdata Filter Builder ──────────────────────────────────────────────────
// Enforces the exact Crustdata v2 filter schema at construction time.
// Two valid shapes:
//   Leaf:  { field, type, value }
//   Group: { op: "and"|"or", conditions: [leaf|group, ...] }
// Throws locally before any request is made if shape is wrong.

const VALID_LEAF_OPERATORS = new Set(["=", "!=", "<", "=<", ">", "=>", "in", "not_in", "(.)", "(!)", "[.]", "geo_distance", "geo_exclude"]);

function filterLeaf(field, type, value) {
  if (!field || typeof field !== "string") throw new Error(`[FilterBuilder] 'field' must be a non-empty string, got: ${JSON.stringify(field)}`);
  if (!VALID_LEAF_OPERATORS.has(type)) throw new Error(`[FilterBuilder] Invalid operator '${type}'. Must be one of: ${[...VALID_LEAF_OPERATORS].join(", ")}`);
  if (value === undefined || value === null) throw new Error(`[FilterBuilder] 'value' is required for field '${field}'`);
  if ((type === "in" || type === "not_in") && !Array.isArray(value)) throw new Error(`[FilterBuilder] Operator '${type}' requires an array value for field '${field}'`);
  if ((type === "in" || type === "not_in") && value.length === 0) throw new Error(`[FilterBuilder] Operator '${type}' requires a non-empty array for field '${field}'`);
  return { field, type, value };
}

function filterGroup(op, conditions) {
  if (op !== "and" && op !== "or") throw new Error(`[FilterBuilder] Group 'op' must be "and" or "or", got: ${JSON.stringify(op)}`);
  if (!Array.isArray(conditions) || conditions.length === 0) throw new Error(`[FilterBuilder] Group 'conditions' must be a non-empty array`);
  return { op, conditions };
}


// ── Helper: Safe JSON Parsing ─────────────────────────────────────────────────
function parseJson(text) {
  const raw = (text ?? "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
  const match = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error("Model did not return valid JSON");
  return JSON.parse(match[0]);
}

// ── Step 1: Puppeteer Homepage Scraper ────────────────────────────────────────
async function scrapeHomepage(url) {
  console.log(`[Scraper] Launching Puppeteer for: ${url}`);
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "true",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    
    // Block images/stylesheets for fast scraping
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["image", "stylesheet", "font", "media"].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    const text = await page.evaluate(() => document.body.innerText || "");
    return text.slice(0, 4000); // Limit context window size
  } catch (err) {
    console.warn(`[Scraper] Failed to scrape URL. Falling back to raw URL string. Error: ${err.message}`);
    return `Website URL provided: ${url}. (Could not scrape content directly).`;
  } finally {
    if (browser) await browser.close();
  }
}

// ── Valid Crustdata Taxonomy Map (Fallback Normalizer) ────────────────────────
const TAXONOMY_MAP = {
  "fintech": "Financial Services",
  "healthtech": "Hospital & Health Care",
  "health tech": "Hospital & Health Care",
  "healthcare": "Hospital & Health Care",
  "edtech": "E-Learning",
  "ed tech": "E-Learning",
  "saas": "Computer Software",
  "software": "Computer Software",
  "software development": "Computer Software",
  "ai": "Information Technology and Services",
  "artificial intelligence": "Information Technology and Services",
  "machine learning": "Information Technology and Services",
  "crypto": "Financial Services",
  "cryptocurrency": "Financial Services",
  "web3": "Information Technology and Services",
  "blockchain": "Financial Services",
  "e-commerce": "Retail",
  "ecommerce": "Retail",
  "biotech": "Biotechnology",
  "cleantech": "Renewables & Environment",
  "clean tech": "Renewables & Environment",
  "adtech": "Marketing and Advertising",
  "ad tech": "Marketing and Advertising",
  "proptech": "Real Estate",
  "prop tech": "Real Estate",
  "legaltech": "Legal Services",
  "legal tech": "Legal Services",
  "insurtech": "Insurance",
  "insur tech": "Insurance",
};

function normalizeIndustry(rawIndustry) {
  if (!rawIndustry) return "Computer Software";
  const lower = rawIndustry.toLowerCase().trim();
  if (TAXONOMY_MAP[lower]) {
    console.log(`[Taxonomy] Normalized "${rawIndustry}" -> "${TAXONOMY_MAP[lower]}"`);
    return TAXONOMY_MAP[lower];
  }
  return rawIndustry;
}

// ── Step 2: Groq Startup Analysis ─────────────────────────────────────────────
async function analyzeStartupWithGroq(startupContext) {
  console.log("[Groq] Analyzing startup business model & niche...");
  const prompt = `Analyze the following startup context and extract structured profile data.
  
Startup Context:
${startupContext}

Respond ONLY with a valid JSON object matching this schema:
{
  "industry": "Must be EXACTLY one of these strings: 'Computer Software', 'Financial Services', 'Information Technology and Services', 'Internet', 'Hospital & Health Care', 'E-Learning', 'Retail', 'Biotechnology', 'Telecommunications', 'Marketing and Advertising', 'Renewables & Environment', 'Real Estate', 'Insurance', 'Legal Services'",
  "primary_niche": "Specific niche (e.g. 'AI Agent Development', 'Personal Finance Management', 'B2B Payments')",
  "sub_niches": ["sub-niche 1", "sub-niche 2"],
  "business_model": "B2B, B2C, SaaS, Marketplace, etc.",
  "target_customer": "Who they sell to",
  "geography": "Primary region (e.g. 'United States', 'India', 'Global')",
  "funding_stage": "Estimated stage (e.g. 'Seed', 'Series A', 'Bootstrapped')"
}`;

  const response = await groq.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: "You are an expert startup analyst. Output strictly JSON." },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
    temperature: 0.1,
  });

  const analysis = parseJson(response.choices[0].message.content);
  // Normalize the industry string before returning to ensure Crustdata taxonomy compliance
  analysis.industry = normalizeIndustry(analysis.industry);
  return analysis;
}

// ── Step 3: Get Relevant VC Firms via Groq ────────────────────────────────────
// Ask Groq for well-known VC firms that invest in this niche.
// This is more reliable than trying to extract investor names from Crustdata
// enrichment, which often returns small/obscure firms with few indexed partners.
async function getRelevantVCFirms(analysis) {
  console.log(`[Groq] Identifying VC firms for niche: "${analysis.primary_niche}"...`);

  const prompt = `You are a venture capital database expert.

Startup Profile:
- Industry: ${analysis.industry}
- Niche: ${analysis.primary_niche}
- Sub-niches: ${analysis.sub_niches?.join(", ")}
- Business Model: ${analysis.business_model}
- Stage: ${analysis.funding_stage}

List exactly 6 real, well-known VC firms that are known to actively invest in this specific niche at the ${analysis.funding_stage} stage. Prioritize firms that have made multiple investments in this space and have partners with public LinkedIn profiles.

Respond ONLY with a JSON object:
{ "firms": ["Firm Name 1", "Firm Name 2", "Firm Name 3", "Firm Name 4", "Firm Name 5", "Firm Name 6"] }`;

  const response = await groq.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: "You are a VC database expert. Output strictly JSON." },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  const result = parseJson(response.choices[0].message.content);
  const firms = result?.firms;
  if (!Array.isArray(firms) || firms.length === 0) {
    console.warn("[Groq] No firms returned, using hardcoded fallback.");
    return ["Sequoia Capital", "Andreessen Horowitz", "Accel", "Y Combinator", "Bessemer Venture Partners", "Lightspeed Venture Partners"];
  }

  console.log(`[Groq] Identified VC firms: ${JSON.stringify(firms)}`);
  return firms;
}


// ── Step 5: Crustdata Person Search ───────────────────────────────────────────
async function getInvestorContacts(vcFirms, _region) {
  console.log(`[Crustdata] Searching partners at firms: ${JSON.stringify(vcFirms)}`);

  const searchFilter = filterGroup("and", [
    filterLeaf("experience.employment_details.current.company_name", "in", vcFirms),
    filterLeaf("experience.employment_details.current.title", "in", [
      "Partner",
      "General Partner",
      "Managing Director",
      "Principal",
      "Managing Partner",
      "Venture Partner",
      "Investment Partner",
      "Founding Partner",
    ]),
  ]);

  let profiles = [];
  try {
    const { data: personResults } = await crustdata.post("/person/search", {
      filters: searchFilter,
      limit: 10,
      fields: ["basic_profile", "experience", "contact", "social_handles"],
    });
    profiles = personResults?.profiles || [];
  } catch (err) {
    if (err.isFatal) throw err;
    console.warn(`[Crustdata] Person search failed: ${err.message}`);
    return [];
  }

  console.log(`[Crustdata] Found ${profiles.length} investor profiles.`);

  // If strict title filter yields < 3, retry with just the company filter
  if (profiles.length < 3) {
    console.log(`[Crustdata] Only ${profiles.length} profiles with strict titles. Retrying with company-only filter...`);
    try {
      const { data: fallbackResults } = await crustdata.post("/person/search", {
        filters: filterLeaf("experience.employment_details.current.company_name", "in", vcFirms),
        limit: 10,
        fields: ["basic_profile", "experience", "contact", "social_handles"],
      });
      const fallback = fallbackResults?.profiles || [];
      // Merge, deduplicate by name
      const seen = new Set(profiles.map((p) => p.basic_profile?.name));
      for (const p of fallback) {
        if (!seen.has(p.basic_profile?.name)) {
          profiles.push(p);
          seen.add(p.basic_profile?.name);
        }
      }
      console.log(`[Crustdata] After fallback: ${profiles.length} total profiles.`);
    } catch (err) {
      if (err.isFatal) throw err;
      console.warn(`[Crustdata] Company-only fallback search failed: ${err.message}`);
    }
  }

  return profiles.slice(0, 6).map((person) => {
    const currentJob = person.experience?.employment_details?.current?.[0] || {};
    const basic = person.basic_profile || {};
    const linkedin = person.social_handles?.professional_network_identifier?.profile_url || null;

    return {
      name: basic.name || "Unknown Investor",
      company: currentJob.name || currentJob.company_name || vcFirms[0],
      role: basic.current_title || currentJob.title || "Partner",
      linkedin,
      email: null,
      investment_firm: currentJob.name || currentJob.company_name || vcFirms[0],
      recent_investment: "Undisclosed Portfolio Company",
      funding_round: "Seed/Series A",
    };
  });
}

// ── Step 7: Groq Final Ranking & Explanation ──────────────────────────────────
async function rankInvestorsWithGroq(startupAnalysis, candidates) {
  console.log("[Groq] Ranking candidates and generating 'why_fit' explanations...");
  const prompt = `You are a venture capital expert. Match the startup profile below with the extracted investor candidates.
  
Startup Profile:
${JSON.stringify(startupAnalysis, null, 2)}

Investor Candidates (Verified Data from Crustdata):
${JSON.stringify(candidates, null, 2)}

Task:
1. Select EXACTLY 3 best-fit investors from the candidates list (use all 3 slots — do not return fewer than 3 unless there are fewer than 3 candidates).
2. For each selected investor, write a compelling 2-3 sentence "why_fit" explaining why their firm and background align with the startup's specific niche (${startupAnalysis.primary_niche}).
3. NEVER invent or hallucinate investor names, emails, or firms. Use ONLY the provided candidate data.

Respond ONLY with a JSON object matching this schema:
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

  const response = await groq.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: "You are a helpful VC assistant. Output valid JSON only." },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
  });

  return parseJson(response.choices[0].message.content);
}

// ── Master Route: /api/find-investors ─────────────────────────────────────────
app.post("/api/find-investors", async (req, res) => {
  const { description, url } = req.body;

  if (!description?.trim() && !url?.trim()) {
    return res.status(400).json({ error: "Please provide a startup description or website URL." });
  }

  try {
    console.log("\n================ /api/find-investors ================");
    
    // Step 1: Scrape if URL is provided
    let startupContext = description || "";
    if (url?.trim()) {
      const scrapedText = await scrapeHomepage(url.trim());
      startupContext = `Website Content:\n${scrapedText}\n\nAdditional Description:\n${startupContext}`;
    }

    // Step 2: LLM extracts startup profile
    const startupAnalysis = await analyzeStartupWithGroq(startupContext);
    console.log("[Pipeline] Analyzed Profile:", JSON.stringify(startupAnalysis));

    // Step 3: Groq identifies relevant VC firms by niche (more reliable than enrichment)
    const vcFirms = await getRelevantVCFirms(startupAnalysis);

    // Step 4: Crustdata person search for partners at those firms
    const rawCandidates = await getInvestorContacts(vcFirms, startupAnalysis.geography);
    
    if (rawCandidates.length === 0) {
      return res.status(404).json({ 
        error: "Could not find investor contact profiles matching this niche in Crustdata." 
      });
    }

    // Step 7: LLM ranks and formats final JSON
    const finalOutput = await rankInvestorsWithGroq(startupAnalysis, rawCandidates);

    console.log(`[Pipeline] Successfully matched ${finalOutput.investors?.length || 0} investors.`);
    return res.json({ investors: (finalOutput.investors || []).slice(0, 3) });

  } catch (err) {
    console.error("Fatal Pipeline Error:", err?.message || err);
    const status = err.isFatal ? 502 : 500;
    return res.status(status).json({
      error: err?.message || "An unexpected error occurred while processing your request.",
    });
  }
});

// ── Route: /api/generate-email ────────────────────────────────────────────────
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
      model: MODEL,
      messages: [
        { role: "system", content: "You are a helpful assistant that writes outreach emails and always responds with valid JSON." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    });

    const text = response.choices?.[0]?.message?.content ?? "";
    return res.json(parseJson(text));
  } catch (err) {
    console.error("Error generating email:", err?.message || err);
    return res.status(500).json({ error: "Could not generate email." });
  }
});

// ── Start Server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VC Finder running → http://localhost:${PORT}`));