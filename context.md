# Project Overview

Build a simple web application that helps startup founders discover the most relevant investors for their company.

Today, founders spend hours researching investors manually. They search Google, browse LinkedIn, read funding announcements, and try to figure out which partner at a VC firm is actually relevant to contact. This process is slow, repetitive, and often results in generic outreach to investors who are not a good fit.

This application automates that workflow.

The user simply describes their startup or pastes their company website. The application uses an LLM to understand what the company does and identify the important characteristics of the business, such as:

* Industry
* Product category
* Target customers
* Business model (B2B/B2C)
* Geography
* Funding stage
* Keywords that describe the company

The application should **not** rely on predefined rules or hardcoded API sequences. Instead, the LLM should be given access to the Crustdata MCP server so it can intelligently decide which tools to use to answer the user's request.

The overall workflow is:

1. The founder enters a startup description or website URL or both.
2. The LLM analyzes the startup and understands its business.
3. The LLM uses the Crustdata MCP tools to search for companies operating in the same or similar space.
4. For those companies, it retrieves funding history.
5. It identifies which venture capital firms invested in those companies.
6. When possible, it finds the specific investment partner responsible for those investments, along with their professional profile and contact information.
7. The LLM ranks the best investor matches based on relevance instead of simply listing well-known VC firms.
8. The application presents the top three investor matches.
9. For each investor, the application generates a personalized outreach email that the founder can review and send.

Each result should explain *why* the investor was recommended. The reasoning should reference actual evidence, such as similar portfolio companies, investment stage, sector focus, or recent investments.

Each investor card should contain:

* Investor name
* Venture capital firm
* Role
* Email address (if available)
* LinkedIn profile
* Similar portfolio companies
* Funding round and investment details
* A short explanation of why they are a strong match
* A button that opens the user's email client with an AI-generated subject line and personalized email body

The primary objective is not to build another investor directory. The goal is to demonstrate an AI agent that can reason over company information, use Crustdata's MCP tools autonomously, discover evidence-backed investor matches, and produce an actionable output that a founder can immediately use for fundraising.

The application should feel fast, simple, and focused. A founder should be able to go from describing their startup to having three highly relevant investor recommendations and ready-to-send outreach emails in under a minute.
