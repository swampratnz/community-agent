#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Create (or update) the GitHub labels that drive the multi-loop pipeline.
# See docs/PIPELINE.md for what each label means and which loop owns it.
#
# Run locally:      gh auth login && bash scripts/setup-labels.sh
# Or via CI:        Actions → "Setup pipeline labels" → Run workflow
#
# Idempotent: --force updates an existing label instead of erroring.
# Requires the `gh` CLI authenticated with repo issues:write.
# ---------------------------------------------------------------------------
set -euo pipefail

label() {
  gh label create "$1" --color "$2" --description "$3" --force
}

label "proposal"        "1D76DB" "A feature proposal issue"
label "status:draft"    "FBCA04" "Proposal awaiting adversarial review"
label "status:approved" "0E8A16" "Survived adversarial review; ready to build"
label "status:rejected" "E11D21" "Failed adversarial review"
label "status:building" "5319E7" "Claimed by the build loop (WIP=1)"
label "status:built"    "0052CC" "PR open, awaiting review/merge"
label "needs-human"     "D93F0B" "Escalated: a human must decide"
label "no-auto-resolve" "FBCA04" "Pin a PR out of the hourly conflict resolver (e.g. while editing it)"
label "no-auto-merge"   "E99695" "Pin a PR out of the serialized auto-merge loop (a human will merge it)"
label "human-merge-ready" "8250DF" "Fully vetted by auto-merge but touches a governance path; a human must merge"
label "community-feedback" "0E8A16" "A real member/admin request; input for research proposals"

# Theme areas (VISION.md) — one per proposal, so the memoryless research loop can
# rotate for diversity by reading the themes on recent proposals.
label "theme:onboarding"    "C5DEF5" "Theme: onboarding & welcome"
label "theme:knowledge"     "C5DEF5" "Theme: knowledge quality & recall"
label "theme:answer-quality" "C5DEF5" "Theme: answer quality (accuracy, citations, NZ context)"
label "theme:moderation"    "C5DEF5" "Theme: moderation & safety"
label "theme:admin-insight" "C5DEF5" "Theme: admin insight (analytics, digests)"
label "theme:reliability"   "C5DEF5" "Theme: reliability & ops"
label "theme:cost"          "C5DEF5" "Theme: cost efficiency"
label "theme:accessibility" "C5DEF5" "Theme: accessibility & inclusion"

echo "Labels created/updated."
