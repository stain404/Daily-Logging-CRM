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
DOMAIN="yourcompany.com"                        # the sending domain you own
APP_URL="https://your-service.onrender.com"     # exact Render URL, no trailing slash
# ─────────────────────────────────────────────────────────────────────

IAM_USER="taskflow-app"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

command -v aws >/dev/null || { echo "aws CLI not found. Install it first."; exit 1; }
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
aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration "file://$TMP/cors.json"
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
  --policy-name taskflow-s3-ses --policy-document "file://$TMP/policy.json"
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
