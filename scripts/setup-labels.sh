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
label "community-feedback" "0E8A16" "A real member/admin request; input for research proposals"

echo "Labels created/updated."
