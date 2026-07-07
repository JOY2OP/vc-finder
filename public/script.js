/**
 * script.js — VC Finder frontend
 *
 * Handles form submission, loading state, rendering investor cards,
 * and the mailto: email button (calls backend to generate subject/body).
 */

// ── DOM refs ──────────────────────────────────────────────────────────────────
const form        = document.getElementById("search-form");
const mainCard    = document.getElementById("main-card");
const loading     = document.getElementById("loading");
const results     = document.getElementById("results");
const cardsGrid   = document.getElementById("investor-cards");
const resetBtn    = document.getElementById("reset-btn");
const submitBtn   = document.getElementById("submit-btn");
const formError   = document.getElementById("form-error");
const template    = document.getElementById("investor-card-template");

// ── State ─────────────────────────────────────────────────────────────────────
let lastDescription = "";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Show only the given element; hide the rest of the three panels. */
function showPanel(panelToShow) {
  [mainCard, loading, results].forEach((el) => {
    el.hidden = el !== panelToShow;
  });
}

/** Return initials from a name, e.g. "John Smith" → "JS" */
function initials(name = "") {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

/** Blank out null / undefined / "N/A" values gracefully. */
function val(v) {
  return v && v !== "null" && v !== "N/A" ? v : null;
}

// ── Render investors ──────────────────────────────────────────────────────────

function renderInvestors(investors) {
  cardsGrid.innerHTML = "";

  investors.forEach((inv, idx) => {
    const clone = template.content.cloneNode(true);

    // Avatar initials
    clone.querySelector(".investor-card__avatar").textContent = initials(inv.name);

    // Identity
    clone.querySelector(".investor-card__name").textContent = inv.name ?? "—";
    clone.querySelector(".investor-card__role").textContent = inv.role ?? "";

    // Badge rank
    clone.querySelector(".investor-card__badge").textContent = `#${idx + 1} Match`;

    // Meta
    clone.querySelector(".investor-card__firm").textContent   = val(inv.investment_firm) ?? val(inv.company) ?? "—";
    clone.querySelector(".investor-card__recent").textContent = val(inv.recent_investment) ?? "—";
    clone.querySelector(".investor-card__round").textContent  = val(inv.funding_round) ?? "—";

    // Why fit
    clone.querySelector(".investor-card__why").textContent = inv.why_fit ?? "";

    // LinkedIn button
    const liBtn = clone.querySelector(".investor-card__linkedin");
    const liUrl = val(inv.linkedin);
    if (liUrl) {
      liBtn.href = liUrl.startsWith("http") ? liUrl : `https://${liUrl}`;
    } else {
      liBtn.style.display = "none";
    }

    // Email button → opens mailto via backend-generated subject/body
    const emailBtn = clone.querySelector(".investor-card__email");
    const emailAddr = val(inv.email);

    emailBtn.addEventListener("click", async () => {
      emailBtn.disabled = true;
      emailBtn.textContent = "Generating…";

      try {
        // Ask backend to generate a personalised cold email
        const res = await fetch("/api/generate-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            investor: inv,
            startupDescription: lastDescription,
          }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to generate email.");

        const mailto = buildMailto(emailAddr, data.subject, data.body);
        window.location.href = mailto;
      } catch (err) {
        alert(err.message);
      } finally {
        emailBtn.disabled = false;
        // Restore button content
        emailBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="2" y="4" width="20" height="16" rx="2"/>
            <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
          </svg>
          Email`;
      }
    });

    // Hide email button if no email address
    if (!emailAddr) emailBtn.style.display = "none";

    cardsGrid.appendChild(clone);
  });

  showPanel(results);
}

/** Build a mailto: URI with pre-filled recipient, subject, and body. */
function buildMailto(email, subject, body) {
  const to      = email ? encodeURIComponent(email) : "";
  const subj    = encodeURIComponent(subject ?? "Quick intro");
  const bodyEnc = encodeURIComponent(body ?? "");
  return `mailto:${to}?subject=${subj}&body=${bodyEnc}`;
}

// ── Form submission ───────────────────────────────────────────────────────────

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.textContent = "";

  const description = form.description.value.trim();
  const url         = form.url.value.trim();

  if (!description && !url) {
    formError.textContent = "Please add a description or website URL.";
    return;
  }

  // Save for later email generation
  lastDescription = description || url;

  submitBtn.disabled = true;
  showPanel(loading);

  try {
    const res = await fetch("/api/find-investors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description, url }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `Server error ${res.status}`);
    }

    renderInvestors(data.investors);
  } catch (err) {
    // Show error back on the form
    showPanel(mainCard);
    formError.textContent = err.message || "Something went wrong. Please try again.";
  } finally {
    submitBtn.disabled = false;
  }
});

// ── Reset / search again ──────────────────────────────────────────────────────

resetBtn.addEventListener("click", () => {
  formError.textContent = "";
  showPanel(mainCard);
  form.reset();
});
