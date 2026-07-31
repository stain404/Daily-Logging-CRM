#!/usr/bin/env bash
#
# One-shot AWS setup for TaskFlow: private S3 bucket for attachments, an SES
# domain identity for transactional email, and a single IAM user scoped to
# exactly those two things.
#
# Run once, from anywhere, with admin credentials already configured
# (`aws configure`). Safe to re-run: every step tolerates already existing.
#
#   bash infra/aws-setup.sh
#
# It does NOT request SES production access — that is a support-case form with
# no API. The script prints the link when it finishes.

set -euo pipefail

# ── Edit these four ──────────────────────────────────────────────────
BUCKET="alquba-crm-files"                       # must be globally unique
REGION="us-east-1"                              # same region for S3 and SES
DOMAIN="alqubainvestment.com"                        # the sending domain you own
APP_URL="https://daily-logging-crm.onrender.com/"     # exact Render URL, no trailing slash
# ─────────────────────────────────────────────────────────────────────

# Refuse to run against the placeholders. Creating an SES identity for a
# domain you do not control leaves junk that can never verify.
case "$DOMAIN" in
  yourcompany.com|"") echo "Edit DOMAIN above — it is still the placeholder." >&2; exit 1;;
esac
case "$APP_URL" in
  https://your-service.onrender.com|"") echo "Edit APP_URL above — it is still the placeholder." >&2; exit 1;;
esac

# A browser's Origin header never carries a trailing slash, so an
# AllowedOrigins entry with one matches nothing and every upload fails CORS.
APP_URL="${APP_URL%/}"

IAM_USER="taskflow-app"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# The AWS CLI on Windows is a native .exe and cannot resolve Git Bash's POSIX
# paths — file:///tmp/... is meaningless to it, since /tmp only exists inside
# MSYS. cygpath -m converts to a Windows path with forward slashes, which is
# what a file:// URL needs. On Linux/macOS there is no cygpath and the path is
# already correct, so this passes through untouched.
winpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

# ── Find the AWS CLI ─────────────────────────────────────────────────
# Two Windows traps this walks around:
#
#   1. A shell opened BEFORE the CLI was installed holds a stale copy of PATH
#      and will never see it, however many times you reinstall. So if `aws` is
#      not on PATH we look in the standard install location before giving up.
#
#   2. `bash` from cmd.exe is usually WSL's bash (C:\Windows\System32\bash.exe),
#      a separate Linux environment that mounts your drive at /mnt/c and cannot
#      run Windows .exe files at all. No amount of PATH fixing helps there —
#      you need Git Bash. Detected and named explicitly, because the symptom
#      ("aws CLI not found") otherwise looks identical to trap 1.
if ! command -v aws >/dev/null 2>&1; then
  for candidate in \
    "/c/Program Files/Amazon/AWSCLIV2" \
    "/c/Program Files (x86)/Amazon/AWSCLIV2" \
    "$LOCALAPPDATA/Programs/Amazon/AWSCLIV2"
  do
    if [ -x "$candidate/aws" ] || [ -x "$candidate/aws.exe" ]; then
      PATH="$PATH:$candidate"; export PATH
      echo "note: found the AWS CLI at $candidate (it was not on PATH)"
      break
    fi
  done
fi

if ! command -v aws >/dev/null 2>&1; then
  if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
    cat <<'WSL' >&2
This is WSL's bash, which cannot run the Windows AWS CLI.

Use Git Bash instead: right-click the taskflow folder in Explorer and
choose "Git Bash Here", then run this script again.

(In cmd.exe, `bash` resolves to C:\Windows\System32\bash.exe — that is WSL,
not Git Bash.)
WSL
  else
    cat <<'NOAWS' >&2
aws CLI not found.

If you have already installed it, this shell was opened beforehand and is
holding a stale PATH — close it and open a new one.

Otherwise:  winget install Amazon.AWSCLI
NOAWS
  fi
  exit 1
fi
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
say "Account $ACCOUNT · region $REGION"

# ── 1. Bucket ────────────────────────────────────────────────────────
say "1/5  Bucket: $BUCKET"
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "     already exists"
else
  # us-east-1 is the one region that must NOT be given a LocationConstraint.
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  echo "     created"
fi

# ── 2. Keep it private ───────────────────────────────────────────────
# Presigned URLs are authenticated requests and work fine against a fully
# private bucket. Nothing here should ever be publicly readable.
say "2/5  Blocking all public access"
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
echo "     done"

# ── 3. CORS ──────────────────────────────────────────────────────────
# The browser POSTs the file straight to S3, so without this every upload
# fails with an opaque CORS error. AllowedOrigins must match exactly.
say "3/5  CORS for $APP_URL"
cat > "$TMP/cors.json" <<JSON
{
  "CORSRules": [{
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["POST", "GET"],
    "AllowedOrigins": ["$APP_URL", "http://localhost:5000"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }]
}
JSON
aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration "file://$(winpath "$TMP/cors.json")"
echo "     done (localhost:5000 included so local dev works too)"

# ── 4. IAM user ──────────────────────────────────────────────────────
# Scoped deliberately: object-level S3 on this one bucket, and ses:SendEmail.
# No bucket-level permissions, no wildcard resources beyond what SES requires.
say "4/5  IAM user: $IAM_USER"
aws iam get-user --user-name "$IAM_USER" >/dev/null 2>&1 || {
  aws iam create-user --user-name "$IAM_USER" >/dev/null
  echo "     created"
}

cat > "$TMP/policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Attachments",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::$BUCKET/*"
    },
    {
      "Sid": "TransactionalEmail",
      "Effect": "Allow",
      "Action": ["ses:SendEmail"],
      "Resource": "*"
    }
  ]
}
JSON
aws iam put-user-policy --user-name "$IAM_USER" \
  --policy-name taskflow-s3-ses --policy-document "file://$(winpath "$TMP/policy.json")"
echo "     policy attached"

# An access key is only readable at creation. If one already exists, this
# reports it rather than silently making a second (the limit is two).
EXISTING="$(aws iam list-access-keys --user-name "$IAM_USER" \
  --query 'AccessKeyMetadata[].AccessKeyId' --output text)"
if [ -n "$EXISTING" ]; then
  echo "     access key already exists: $EXISTING (secret cannot be re-read)"
  echo "     to rotate: aws iam delete-access-key --user-name $IAM_USER --access-key-id $EXISTING"
  KEY_ID="$EXISTING"; KEY_SECRET="<existing — rotate to get a new one>"
else
  read -r KEY_ID KEY_SECRET <<<"$(aws iam create-access-key --user-name "$IAM_USER" \
    --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)"
  echo "     access key created"
fi

# ── 5. SES domain identity ───────────────────────────────────────────
say "5/5  SES identity: $DOMAIN"
aws sesv2 get-email-identity --email-identity "$DOMAIN" --region "$REGION" >/dev/null 2>&1 || {
  aws sesv2 create-email-identity --email-identity "$DOMAIN" --region "$REGION" \
    --dkim-signing-attributes NextSigningKeyLength=RSA_2048_BIT >/dev/null
  echo "     created"
}
TOKENS="$(aws sesv2 get-email-identity --email-identity "$DOMAIN" --region "$REGION" \
  --query 'DkimAttributes.Tokens' --output text)"

say "DNS — add these 3 CNAME records at your registrar"
for t in $TOKENS; do
  printf '  %s._domainkey.%s   CNAME   %s.dkim.amazonses.com\n' "$t" "$DOMAIN" "$t"
done

say "Render environment variables"
cat <<ENV
  S3_BUCKET=$BUCKET
  MAX_UPLOAD_MB=25
  AWS_REGION=$REGION
  AWS_ACCESS_KEY_ID=$KEY_ID
  AWS_SECRET_ACCESS_KEY=$KEY_SECRET
  MAIL_FROM=no-reply@$DOMAIN
  MAIL_FROM_NAME=Al Quba
  MAIL_BRAND_NAME=Al Quba
  APP_URL=$APP_URL
  EMAIL_ENABLED=false
ENV

say "Remaining manual steps"
cat <<NEXT
  1. Add the 3 CNAME records above. Verification takes minutes to a few hours.
     Check with: aws sesv2 get-email-identity --email-identity $DOMAIN --region $REGION \\
                   --query 'DkimAttributes.Status'
  2. Request SES production access (console only — no API for it):
     https://console.aws.amazon.com/ses/home?region=$REGION#/account
     Until granted you can only send to verified addresses, capped at 200/day.
  3. Set the variables above in Render, and only then flip EMAIL_ENABLED=true.
NEXT
