/**
 * script.js — VC Finder frontend
 */

const form       = document.getElementById("search-form");
const mainCard   = document.getElementById("main-card");
const loading    = document.getElementById("loading");
const results    = document.getElementById("results");
const cardsGrid  = document.getElementById("investor-cards");
const resetBtn   = document.getElementById("reset-btn");
const submitBtn  = document.getElementById("submit-btn");
const formError  = document.getElementById("form-error");
const template   = document.getElementById("investor-card-template");
const resultCount = document.getElementById("results-count");

const steps = [
  document.getElementById("step-1"),
  document.getElementById("step-2"),
  document.getElementById("step-3"),
];

let lastDescription = "";
let stepTimer = null;

// ── Utilities ─────────────────────────────────────────────────────────────────

function showPanel(panelToShow) {
  [mainCard, loading, results].forEach((el) => {
    el.hidden = el !== panelToShow;
  });
}

function initials(name = "") {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function val(v) {
  return v && v !== "null" && v !== "N/A" && v !== "Unknown Firm" && v !== "Unknown Investor"
    ? v
    : null;
}

// ── Loading step animation ────────────────────────────────────────────────────

function startLoadingSteps() {
  steps.forEach((s) => s.classList.remove("active", "done"));
  let i = 0;
  steps[0].classList.add("active");

  stepTimer = setInterval(() => {
    if (i < steps.length - 1) {
      steps[i].classList.remove("active");
      steps[i].classList.add("done");
      i++;
      steps[i].classList.add("active");
    }
  }, 6000);
}

function stopLoadingSteps() {
  clearInterval(stepTimer);
  steps.forEach((s) => s.classList.remove("active"));
  steps.forEach((s) => s.classList.add("done"));
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderInvestors(investors) {
  cardsGrid.innerHTML = "";
  resultCount.textContent = `${investors.length} investor${investors.length !== 1 ? "s" : ""} found`;

  investors.forEach((inv, idx) => {
    const clone = template.content.cloneNode(true);
    const card = clone.querySelector(".investor-card");

    // Fit tier on card root (drives accent bar color)
    const fit = val(inv.fit);
    if (fit) card.dataset.fit = fit.toLowerCase();

    // ── Avatar ──
    const avatarEl = clone.querySelector(".investor-card__avatar");
    const avatarUrl = val(inv.avatar);
    if (avatarUrl) {
      const img = document.createElement("img");
      img.src = avatarUrl;
      img.alt = `${inv.name} profile photo`;
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => {
        avatarEl.textContent = initials(inv.name);
        avatarEl.classList.remove("investor-card__avatar--image");
        img.remove();
      });
      avatarEl.classList.add("investor-card__avatar--image");
      avatarEl.appendChild(img);
    } else {
      avatarEl.textContent = initials(inv.name);
    }

    // ── Fit dot (indicator overlapping avatar) ──
    const fitDot = clone.querySelector(".investor-card__fit-dot");
    if (fit) {
      fitDot.dataset.fit = fit.toLowerCase();
      fitDot.title = `Crustdata fit: ${fit}`;
    } else {
      fitDot.remove();
    }

    // ── Identity ──
    clone.querySelector(".investor-card__name").textContent = inv.name ?? "Unknown";
    clone.querySelector(".investor-card__role").textContent = val(inv.role) ?? "";

    const headlineEl = clone.querySelector(".investor-card__headline");
    const headlineText = val(inv.headline);
    if (headlineText && headlineText !== inv.role) {
      headlineEl.textContent = headlineText;
    } else {
      headlineEl.hidden = true;
    }

    // ── Rank badge ──
    clone.querySelector(".investor-card__rank").textContent = `#${idx + 1}`;

    // ── Firm chip ──
    const firmName = val(inv.investment_firm) ?? val(inv.company) ?? "Unknown Firm";
    clone.querySelector(".investor-card__firm-name").textContent = firmName;

    // ── Meta ──
    clone.querySelector(".investor-card__location").textContent = val(inv.location) ?? "—";
    clone.querySelector(".investor-card__round").textContent = val(inv.funding_round) ?? "Seed / Series A";

    // ── Fit pill ──
    const fitPill = clone.querySelector(".investor-card__fit-pill");
    if (fit) {
      fitPill.textContent = fit === "strong" ? "✦ Strong fit" : `${fit} fit`;
      fitPill.dataset.fit = fit.toLowerCase();
    } else {
      fitPill.remove();
    }

    // ── Why fit ──
    clone.querySelector(".investor-card__why").textContent = inv.why_fit ?? "";

    // ── LinkedIn button ──
    const liBtn = clone.querySelector(".investor-card__linkedin");
    const liUrl = val(inv.linkedin);
    if (liUrl) {
      liBtn.href = liUrl.startsWith("http") ? liUrl : `https://${liUrl}`;
    } else {
      liBtn.style.display = "none";
    }

    // ── Email / Draft button (always visible — opens mailto or blank compose) ──
    const emailBtn = clone.querySelector(".investor-card__email");
    const emailAddr = val(inv.email);

    emailBtn.addEventListener("click", async () => {
      emailBtn.disabled = true;
      emailBtn.textContent = "Generating…";

      try {
        const res = await fetch("/api/generate-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ investor: inv, startupDescription: lastDescription }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to generate email.");

        window.location.href = buildMailto(emailAddr, data.subject, data.body);
      } catch (err) {
        alert(`Could not generate email draft: ${err.message}`);
      } finally {
        emailBtn.disabled = false;
        emailBtn.innerHTML = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="2" y="4" width="20" height="16" rx="2"/>
            <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
          </svg>
          Draft Email`;
      }
    });

    cardsGrid.appendChild(clone);
  });

  showPanel(results);
}

function buildMailto(email, subject, body) {
  const to   = email ? encodeURIComponent(email) : "";
  const subj = encodeURIComponent(subject ?? "Quick intro");
  const bdy  = encodeURIComponent(body ?? "");
  return `mailto:${to}?subject=${subj}&body=${bdy}`;
}

// ── Form submit ───────────────────────────────────────────────────────────────

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.textContent = "";

  const description = form.description.value.trim();
  const url         = form.url.value.trim();

  if (!description && !url) {
    formError.textContent = "Please add a description or website URL.";
    return;
  }

  lastDescription = description || url;
  submitBtn.disabled = true;
  showPanel(loading);
  startLoadingSteps();

  try {
    const res = await fetch("/api/find-investors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description, url }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);

    stopLoadingSteps();
    renderInvestors(data.investors);
  } catch (err) {
    stopLoadingSteps();
    showPanel(mainCard);
    formError.textContent = err.message || "Something went wrong. Please try again.";
  } finally {
    submitBtn.disabled = false;
  }
});

// ── Reset ─────────────────────────────────────────────────────────────────────

resetBtn.addEventListener("click", () => {
  formError.textContent = "";
  showPanel(mainCard);
  form.reset();
  resultCount.textContent = "";
});
