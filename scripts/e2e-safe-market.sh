#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI=(npm run -s cli --)

PAYER_DATA_DIR="tmp/agent-a"
WORKER_DATA_DIR="tmp/agent-b"
MARKETPLACE="demo-market"
AMOUNT_SATS="1000"
MILESTONE_ID="m1"
PROOF_TEXT="done"
CONTRACT_DEADLINE_ISO="2026-12-31T23:59:59Z"
INVOICE_EXPIRES_AT=""
RUN_PAYMENT=0

usage() {
  cat <<'EOF'
Usage:
  scripts/e2e-safe-market.sh [options]

Purpose:
  Run a deterministic end-to-end market -> agreement -> contract -> proof flow
  with explicit settlement gating.

  Safety defaults:
  - no lightning refs are attached to offer/agreement objects
  - script asserts payer payment ledger does not advance during acceptance/proof flow
  - no invoice creation or payment occurs unless --pay is provided

Options:
  --payer-data-dir <path>      Default: tmp/agent-a
  --worker-data-dir <path>     Default: tmp/agent-b
  --marketplace <id>           Default: demo-market
  --amount-sats <n>            Default: 1000
  --milestone-id <id>          Default: m1
  --proof-text <text>          Default: done
  --contract-deadline <iso>    Default: 2026-12-31T23:59:59Z
  --invoice-expires-at <iso>   Optional. Defaults to now + 1h when --pay is used
  --pay                        Create invoice on worker and pay from payer after milestone acceptance
  --help                       Show this message

Environment:
  EMPORION_WALLET_KEY should be set when wallet data is encrypted.
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

cli_json() {
  local output
  if ! output="$(cd "$ROOT_DIR" && "${CLI[@]}" "$@" 2>&1)"; then
    echo "$output" >&2
    exit 1
  fi
  printf '%s\n' "$output"
}

require_json_field() {
  local json="$1"
  local jq_expr="$2"
  jq -er "$jq_expr" <<<"$json"
}

payment_count() {
  local json
  json="$(cli_json wallet ledger list --data-dir "$PAYER_DATA_DIR" --kind payment)"
  jq -er '(.entries // []) | length' <<<"$json"
}

assert_equal() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "Assertion failed: $message (expected=$expected actual=$actual)" >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --payer-data-dir)
      PAYER_DATA_DIR="${2:?missing value for --payer-data-dir}"
      shift 2
      ;;
    --worker-data-dir)
      WORKER_DATA_DIR="${2:?missing value for --worker-data-dir}"
      shift 2
      ;;
    --marketplace)
      MARKETPLACE="${2:?missing value for --marketplace}"
      shift 2
      ;;
    --amount-sats)
      AMOUNT_SATS="${2:?missing value for --amount-sats}"
      shift 2
      ;;
    --milestone-id)
      MILESTONE_ID="${2:?missing value for --milestone-id}"
      shift 2
      ;;
    --proof-text)
      PROOF_TEXT="${2:?missing value for --proof-text}"
      shift 2
      ;;
    --contract-deadline)
      CONTRACT_DEADLINE_ISO="${2:?missing value for --contract-deadline}"
      shift 2
      ;;
    --invoice-expires-at)
      INVOICE_EXPIRES_AT="${2:?missing value for --invoice-expires-at}"
      shift 2
      ;;
    --pay)
      RUN_PAYMENT=1
      shift 1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

require_cmd jq
require_cmd npm
require_cmd node
require_cmd shasum
require_cmd awk

if ! [[ "$AMOUNT_SATS" =~ ^[0-9]+$ ]] || [[ "$AMOUNT_SATS" -le 0 ]]; then
  echo "--amount-sats must be a positive integer" >&2
  exit 1
fi

if [[ "$RUN_PAYMENT" -eq 1 && -z "$INVOICE_EXPIRES_AT" ]]; then
  INVOICE_EXPIRES_AT="$(node -e 'const d = new Date(Date.now() + 60 * 60 * 1000); process.stdout.write(d.toISOString())')"
fi

echo "Loading agent identities..."
payer_did="$(require_json_field "$(cli_json agent show --data-dir "$PAYER_DATA_DIR")" '.identity.did')"
worker_did="$(require_json_field "$(cli_json agent show --data-dir "$WORKER_DATA_DIR")" '.identity.did')"

echo "Checking payer payment ledger baseline..."
before_payment_count="$(payment_count)"

request_title="E2E request $(date -u +%Y%m%dT%H%M%SZ)"
echo "Publishing request in marketplace '$MARKETPLACE'..."
request_id="$(
  require_json_field \
    "$(cli_json market request publish --data-dir "$PAYER_DATA_DIR" --marketplace "$MARKETPLACE" --title "$request_title" --amount-sats "$AMOUNT_SATS")" \
    '.objectId'
)"

echo "Submitting offer (simulated worker proposer DID) ..."
offer_id="$(
  require_json_field \
    "$(cli_json market offer submit --data-dir "$PAYER_DATA_DIR" --marketplace "$MARKETPLACE" --target-object-id "$request_id" --amount-sats "$AMOUNT_SATS" --proposer-did "$worker_did")" \
    '.objectId'
)"

echo "Accepting offer..."
cli_json market offer accept --data-dir "$PAYER_DATA_DIR" --id "$offer_id" >/dev/null

after_offer_accept_payment_count="$(payment_count)"
assert_equal "$before_payment_count" "$after_offer_accept_payment_count" \
  "no payment should occur on offer acceptance when no lightning refs are attached"

echo "Creating agreement with no lightning refs..."
agreement_id="$(
  require_json_field \
    "$(cli_json market agreement create --data-dir "$PAYER_DATA_DIR" --source-kind offer --source-id "$offer_id" --deliverable "Deliver proof text: $PROOF_TEXT" --counterparty "$payer_did" --counterparty "$worker_did" --amount-sats "$AMOUNT_SATS")" \
    '.objectId'
)"

echo "Creating contract..."
milestones_json="$(jq -nc --arg milestoneId "$MILESTONE_ID" '[{
  milestoneId:$milestoneId,
  title:"Deliverable",
  deliverableSchema:{kind:"artifact",requiredArtifactKinds:["text-proof"]},
  proofPolicy:{allowedModes:["artifact-verifiable"],verifierRefs:[],minArtifacts:1,requireCounterpartyAcceptance:true},
  settlementAdapters:[]
}]')"
deliverable_schema_json='{"kind":"artifact","requiredArtifactKinds":["text-proof"]}'
proof_policy_json='{"allowedModes":["artifact-verifiable"],"verifierRefs":[],"minArtifacts":1,"requireCounterpartyAcceptance":true}'
resolution_policy_json='{"mode":"mutual","deterministicVerifierIds":[]}'
settlement_policy_json='{"adapters":[],"releaseCondition":"contract-completed"}'
deadline_policy_json="$(jq -nc --arg milestoneId "$MILESTONE_ID" --arg deadline "$CONTRACT_DEADLINE_ISO" '{milestoneDeadlines:{($milestoneId):$deadline}}')"

contract_id="$(
  require_json_field \
    "$(cli_json contract create \
      --data-dir "$PAYER_DATA_DIR" \
      --origin-kind agreement \
      --origin-id "$agreement_id" \
      --party "$payer_did" \
      --party "$worker_did" \
      --scope "E2E safe market proof test" \
      --milestones-json "$milestones_json" \
      --deliverable-schema-json "$deliverable_schema_json" \
      --proof-policy-json "$proof_policy_json" \
      --resolution-policy-json "$resolution_policy_json" \
      --settlement-policy-json "$settlement_policy_json" \
      --deadline-policy-json "$deadline_policy_json")" \
    '.objectId'
)"

echo "Opening milestone '$MILESTONE_ID'..."
cli_json contract open-milestone --data-dir "$PAYER_DATA_DIR" --id "$contract_id" --milestone-id "$MILESTONE_ID" >/dev/null

proof_hash="$(printf '%s' "$PROOF_TEXT" | shasum -a 256 | awk '{print $1}')"
artifact_json="$(jq -nc --arg proofHash "$proof_hash" '[{"artifactId":"proof-artifact","hash":$proofHash}]')"
verifier_json='[{"verifierId":"manual-check","verifierKind":"human-review"}]'

echo "Recording evidence and submitting milestone..."
evidence_id="$(
  require_json_field \
    "$(cli_json evidence record --data-dir "$PAYER_DATA_DIR" --contract-id "$contract_id" --milestone-id "$MILESTONE_ID" --proof-mode artifact-verifiable --artifact-json "$artifact_json" --verifier-json "$verifier_json")" \
    '.objectId'
)"

cli_json contract submit-milestone --data-dir "$PAYER_DATA_DIR" --id "$contract_id" --milestone-id "$MILESTONE_ID" --evidence-bundle-id "$evidence_id" >/dev/null
cli_json contract accept-milestone --data-dir "$PAYER_DATA_DIR" --id "$contract_id" --milestone-id "$MILESTONE_ID" >/dev/null

after_proof_accept_payment_count="$(payment_count)"
assert_equal "$before_payment_count" "$after_proof_accept_payment_count" \
  "no payment should occur before explicit invoice + pay commands"

echo "Flow complete: market->agreement->contract->proof passed with no early payment."
echo "request=$request_id"
echo "offer=$offer_id"
echo "agreement=$agreement_id"
echo "contract=$contract_id"
echo "evidence=$evidence_id"

if [[ "$RUN_PAYMENT" -eq 1 ]]; then
  echo "Creating worker invoice and paying from payer..."
  invoice_json="$(cli_json wallet invoice create --data-dir "$WORKER_DATA_DIR" --amount-sats "$AMOUNT_SATS" --memo "contract:$contract_id:$MILESTONE_ID" --expires-at "$INVOICE_EXPIRES_AT")"
  bolt11="$(require_json_field "$invoice_json" '.bolt11')"

  cli_json wallet pay bolt11 --data-dir "$PAYER_DATA_DIR" --invoice "$bolt11" --source-ref "$contract_id:$MILESTONE_ID" >/dev/null
  after_payment_count="$(payment_count)"
  expected_after_payment_count="$((before_payment_count + 1))"
  assert_equal "$expected_after_payment_count" "$after_payment_count" \
    "payer payment ledger should increment by one after explicit pay"

  echo "Payment sent successfully."
  echo "invoice_bolt11=$bolt11"
else
  echo "No payment was sent (default safe mode)."
  echo "To settle manually later:"
  echo "  npm run cli -- wallet invoice create --data-dir $WORKER_DATA_DIR --amount-sats $AMOUNT_SATS --memo \"contract:$contract_id:$MILESTONE_ID\""
  echo "  npm run cli -- wallet pay bolt11 --data-dir $PAYER_DATA_DIR --invoice <bolt11> --source-ref \"$contract_id:$MILESTONE_ID\""
fi
