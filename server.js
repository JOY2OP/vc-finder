/**
 * server.js — VC Finder Backend (v4.0: Semantic Investor Search)
 *
 * Architecture:
 * - Groq extracts startup profile (industry, niche, stage).
 * - Crustdata /person/search with semantic `search.query` finds niche-relevant
 *   investors dynamically — no hardcoded firm names, different results per startup.
 * - Groq ranks the returned candidates and generates why_fit explanations.
 * - Strict filter builder prevents malformed Crustdata API requests.
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
const MIN_INVESTOR_RESULTS = 15;
const CRUSTDATA_INVESTOR_LIMIT = Math.min(
  Math.max(Number(process.env.CRUSTDATA_INVESTOR_LIMIT) || 50, MIN_INVESTOR_RESULTS),
  1000
);
const GOOD_FIT_TIERS = new Set(["strong"]);
const REVIEWABLE_FIT_TIERS = new Set(["strong", "possible"]);
const INVESTOR_SIGNAL_RE = /\b(vc|venture|ventures|venture capital|capital|investor|investment|investing|investments|fund|funding|general partner|managing partner|venture partner|investment partner|founding partner|principal)\b/i;
const INVESTOR_TITLE_RE = /\b(vc|venture capital|investor|investment|investing|general partner|managing partner|venture partner|investment partner|founding partner|managing director|principal)\b/i;
const INVESTMENT_FIRM_RE = /\b(vc|venture|ventures|capital|invest|investment|investments|fund|partners)\b/i;
const NON_INVESTOR_SIGNAL_RE = /\b(project leader|product manager|engineer|engineering|designer|marketing|sales|recruiter|talent|human resources|consultant|student|intern)\b/i;

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
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
      ],
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

// ── Step 3: Crustdata Semantic Investor Search ────────────────────────────────
// Uses /person/search with a natural-language `search.query` so results are
// driven by the startup's niche — completely different per submission.
// No hardcoded firm names. One API call. No double-billing fallback loop.
async function getInvestorContacts(analysis) {
  // Build a niche-specific semantic query from the startup profile
  const semanticQuery = [
    "venture capital investor or VC partner",
    analysis.primary_niche && `invests in ${analysis.primary_niche}`,
    ...( analysis.sub_niches || []),
    analysis.industry && `sector: ${analysis.industry}`,
    analysis.business_model && `business model: ${analysis.business_model}`,
    analysis.target_customer && `target customer: ${analysis.target_customer}`,
    analysis.geography && `geography: ${analysis.geography}`,
    analysis.funding_stage && `${analysis.funding_stage} stage startups`,
  ].filter(Boolean).join(", ");

  console.log(`[Crustdata] Semantic investor search: "${semanticQuery}"`);

  // Hard filter: must currently hold an investor title
  const titleFilter = filterGroup("or", [
    filterLeaf("experience.employment_details.current.title", "(.)", "Venture"),
    filterLeaf("experience.employment_details.current.title", "(.)", "Investment"),
    filterLeaf("experience.employment_details.current.title", "(.)", "Managing Director"),
    filterLeaf("experience.employment_details.current.title", "(.)", "Investor"),
    filterLeaf("experience.employment_details.current.title", "(.)", "General Partner"),
    filterLeaf("experience.employment_details.current.title", "(.)", "Managing Partner"),
    filterLeaf("experience.employment_details.current.title", "(.)", "Founding Partner"),
  ]);

  try {
    const { data } = await crustdata.post("/person/search", {
      search: {
        query: semanticQuery,
        mode: "hybrid",   // keyword + semantic — best recall
      },
      mode: "exact",      // enforce explicit filters as hard constraints
      filters: titleFilter,
      limit: CRUSTDATA_INVESTOR_LIMIT,
      fields: [
        "fit",
        "basic_profile",
        "experience.employment_details.current",
        "social_handles",
      ],
    });

    console.log("crustdata data flag===== RAW /person/search RESPONSE START");
    console.log(JSON.stringify(data, null, 2));
    console.log("crustdata data flag===== RAW /person/search RESPONSE END");

    const profiles = data?.profiles || [];
    console.log(
      `[Crustdata] Semantic search returned ${profiles.length} investor profiles ` +
      `(total_count=${data?.total_count ?? "unknown"}, relation=${data?.total_count_relation ?? "unknown"}).`
    );

    return profiles.map((person) => {
      const current = person.experience?.employment_details?.current;
      const currentJob = (Array.isArray(current) ? current[0] : current) || {};
      const basic = person.basic_profile || {};
      const linkedin = person.social_handles?.professional_network_identifier?.profile_url || null;
      const avatar = firstTruthy(
        basic.profile_picture_url,
        basic.profile_picture_permalink,
        basic.profile_image_url,
        basic.image_url,
        person.profile_picture_url,
        currentJob.company_profile_picture_permalink,
        currentJob.company_logo_url
      );
      const location = typeof basic.location === "string"
        ? basic.location
        : basic.location?.full_location || [basic.location?.city, basic.location?.state, basic.location?.country].filter(Boolean).join(", ") || null;

      return {
        fit: person.fit || null,
        name: basic.name || "Unknown Investor",
        company: currentJob.name || currentJob.company_name || "Unknown Firm",
        role: basic.current_title || currentJob.title || "Partner",
        headline: basic.headline || null,
        location,
        avatar,
        linkedin,
        email: null,
        investment_firm: currentJob.name || currentJob.company_name || "Unknown Firm",
        recent_investment: "Undisclosed Portfolio Company",
        funding_round: "Seed/Series A",
      };
    }).filter((person) => person.name !== "Unknown Investor");
  } catch (err) {
    if (err.isFatal) throw err;
    console.warn(`[Crustdata] Semantic search failed: ${err.message}`);
    return [];
  }
}

function firstTruthy(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) || null;
}

function selectInvestorsToExplain(candidates) {
  const primaryMatches = candidates.filter(isLikelyInvestorContact);
  const subnicheFallbacks = candidates.filter(isSameSearchInvestorFallback);
  const pool = uniqueCandidates([...primaryMatches, ...subnicheFallbacks]);
  const goodFits = pool.filter((candidate) => GOOD_FIT_TIERS.has(candidate.fit));

  // If we have enough strong fits, return all of them (no artificial cap)
  if (goodFits.length >= MIN_INVESTOR_RESULTS) return goodFits;

  // Otherwise, pad with remaining pool candidates to reach MIN_INVESTOR_RESULTS
  const selected = [...goodFits];
  const seen = new Set(goodFits.map((c) => c.linkedin || `${c.name}|${c.investment_firm}`));

  for (const candidate of pool) {
    if (selected.length >= MIN_INVESTOR_RESULTS) break;
    const key = candidate.linkedin || `${candidate.name}|${candidate.investment_firm}`;
    if (seen.has(key)) continue;
    selected.push(candidate);
    seen.add(key);
  }

  return selected;
}

function isLikelyInvestorContact(candidate) {
  if (!REVIEWABLE_FIT_TIERS.has(candidate.fit)) return false;
  const evidence = getCandidateEvidence(candidate);
  const role = candidate.role || "";
  const firmEvidence = [candidate.company, candidate.investment_firm, candidate.headline].filter(Boolean).join(" ");

  if (NON_INVESTOR_SIGNAL_RE.test(evidence)) return false;
  if (!INVESTOR_SIGNAL_RE.test(evidence)) return false;
  return INVESTOR_TITLE_RE.test(role) || INVESTMENT_FIRM_RE.test(firmEvidence);
}

function isSameSearchInvestorFallback(candidate) {
  if (!REVIEWABLE_FIT_TIERS.has(candidate.fit)) return false;

  const evidence = getCandidateEvidence(candidate);
  if (NON_INVESTOR_SIGNAL_RE.test(evidence)) return false;

  // These are still from the same Crustdata semantic/subniche response.
  // Use them only to satisfy the minimum result count after stricter matches.
  return INVESTOR_SIGNAL_RE.test(evidence);
}

function getCandidateEvidence(candidate) {
  return [
    candidate.role,
    candidate.headline,
    candidate.company,
    candidate.investment_firm,
  ].filter(Boolean).join(" ");
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = candidate.linkedin || `${candidate.name}|${candidate.investment_firm}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Step 7: Groq Final Ranking & Explanation ──────────────────────────────────
async function explainInvestorsWithGroq(startupAnalysis, candidates) {
  console.log("[Groq] Generating 'why_fit' explanations for selected candidates...");
  const prompt = `You are a venture capital expert. Explain why each selected investor fits the startup profile below.
  
Startup Profile:
${JSON.stringify(startupAnalysis, null, 2)}

Selected Investor Candidates (Verified Data from Crustdata):
${JSON.stringify(candidates, null, 2)}

Task:
1. Return exactly one item for every selected candidate, in the same order.
2. For each investor, write a specific 2-3 sentence "why_fit" explaining why their role, firm, headline, location, and Crustdata fit tier align with the startup's niche (${startupAnalysis.primary_niche}).
3. NEVER invent investor names, emails, firms, portfolio companies, or funding rounds. Use ONLY the provided candidate data.

Respond ONLY with a JSON object matching this schema:
{
  "investors": [
    {
      "name": "string",
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

  const parsed = parseJson(response.choices[0].message.content);
  const explanations = Array.isArray(parsed.investors) ? parsed.investors : [];

  return {
    investors: candidates.map((candidate, index) => ({
      ...candidate,
      why_fit: explanations[index]?.why_fit ||
        `${candidate.name} appears relevant based on Crustdata's ${candidate.fit || "semantic"} fit signal and current role at ${candidate.investment_firm}. Review their profile before outreach to confirm sector and stage alignment.`,
    })),
  };
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

    // Step 3: Semantic investor search — niche-driven, different results per startup
    const rawCandidates = await getInvestorContacts(startupAnalysis);
    
    if (rawCandidates.length === 0) {
      return res.status(404).json({ 
        error: "Could not find investor contact profiles matching this niche in Crustdata." 
      });
    }

    const selectedCandidates = selectInvestorsToExplain(rawCandidates);
    console.log(
      `[Pipeline] Candidate quality: raw=${rawCandidates.length}, ` +
      `likely_investor=${rawCandidates.filter(isLikelyInvestorContact).length}, ` +
      `same_search_fallback=${rawCandidates.filter(isSameSearchInvestorFallback).length}.`
    );
    console.log(
      `[Pipeline] Explaining ${selectedCandidates.length} investors ` +
      `(${rawCandidates.filter((candidate) => GOOD_FIT_TIERS.has(candidate.fit)).length} strong fits from Crustdata).`
    );

    // Step 7: LLM formats explanations without changing verified candidate fields
    const finalOutput = await explainInvestorsWithGroq(startupAnalysis, selectedCandidates);

    console.log(`[Pipeline] Successfully matched ${finalOutput.investors?.length || 0} investors.`);
    return res.json({ investors: finalOutput.investors || [] });

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
