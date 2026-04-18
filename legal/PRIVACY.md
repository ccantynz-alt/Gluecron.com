# Gluecron Privacy Policy

**Last updated: April 12, 2026**

## 1. Introduction

This Privacy Policy describes how [YOUR LEGAL ENTITY NAME] ("Company," "we,"
"us") collects, uses, and shares information when you use Gluecron ("Service").

## 2. Information We Collect

### 2.1 Information You Provide
- **Account information:** username, email address, display name, bio
- **Repository content:** code, files, issues, pull requests, comments
- **SSH keys:** public keys for authentication
- **Payment information:** processed by Stripe (we never store card numbers)

### 2.2 Information Collected Automatically
- **Log data:** IP address, browser type, operating system, referring URL,
  pages visited, timestamps
- **Git operations:** push/pull/clone metadata (timestamps, refs, not content)
- **Usage data:** features used, repository interactions, search queries
- **Device information:** device type, screen resolution, time zone

### 2.3 Information from Intelligence Features
- **Code analysis results:** health scores, security scan results, dependency
  graphs (computed on your code, stored as metadata)
- **Auto-repair logs:** which repairs were applied and when
- **Push analysis:** risk scores, breaking change detection results

## 3. How We Use Your Information

We use your information to:
- Provide, maintain, and improve the Service
- Process transactions and send related information
- Send technical notices, updates, and support messages
- Respond to your comments and questions
- Provide and improve Intelligence Features (code analysis, auto-repair)
- Monitor and analyze usage patterns and trends
- Detect, prevent, and address fraud, abuse, and technical issues
- Comply with legal obligations

## 4. How We Share Your Information

We do NOT sell your personal information. We may share information:

- **With your consent:** when you explicitly authorize it
- **Public repositories:** content in public repos is visible to anyone
- **Service providers:** hosting (Crontech infrastructure), database (Neon), payment
  (Stripe), email (for transactional emails only)
- **Integration partners:** GateTest (code scanning), Crontech (deployment)
  — only repository metadata, not source code content, unless you enable
  the integration
- **Legal requirements:** when required by law, subpoena, or court order
- **Business transfers:** in connection with a merger, acquisition, or sale
  of assets (with notice to users)

## 5. Data Security

- Passwords are hashed using bcrypt (never stored in plain text)
- API tokens are hashed using SHA-256
- Sessions use cryptographically random tokens
- All connections use HTTPS/TLS encryption
- Database connections use SSL
- Webhook payloads use HMAC-SHA256 signatures

## 6. Data Retention

- **Account data:** retained until you delete your account
- **Repository data:** retained until you delete the repository
- **Log data:** retained for 90 days
- **Deleted accounts:** data is purged within 30 days of account deletion
- **Backups:** may contain deleted data for up to 90 days

## 7. Your Rights

You have the right to:
- **Access:** request a copy of your personal data
- **Correction:** update inaccurate information via account settings
- **Deletion:** delete your account and all associated data
- **Export:** export your repositories using standard git tools at any time
- **Objection:** object to processing of your data for specific purposes
- **Restriction:** request restriction of processing in certain circumstances

### For EU/EEA Users (GDPR)
- Legal basis for processing: contract performance, legitimate interests,
  and consent where applicable
- You may lodge a complaint with your local supervisory authority
- Data transfers outside the EU are protected by Standard Contractual Clauses

### For California Users (CCPA)
- You have the right to know what personal information we collect
- You have the right to request deletion
- You have the right to opt out of the "sale" of personal information
  (we do not sell personal information)
- We will not discriminate against you for exercising your rights

## 8. Cookies

We use minimal cookies:
- **Session cookie:** required for authentication (httpOnly, secure)
- We do NOT use tracking cookies, advertising cookies, or third-party
  analytics cookies

## 9. Children's Privacy

The Service is not intended for children under 13 (or 16 in the EU).
We do not knowingly collect information from children under these ages.

## 10. International Data Transfers

Your data may be processed in the United States and other countries where
our service providers operate. We ensure appropriate safeguards are in
place for international transfers.

## 11. Changes to This Policy

We may update this Privacy Policy from time to time. We will notify you
of material changes via email or in-app notification at least 30 days
before they take effect.

## 12. Contact Us

For privacy inquiries:
- Email: [PRIVACY EMAIL]
- Address: [COMPANY ADDRESS]

For GDPR inquiries, our Data Protection Contact can be reached at:
[DPO EMAIL]
