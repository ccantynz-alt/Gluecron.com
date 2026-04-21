# Gluecron Data Processing Agreement (Template)

**Last updated: April 21, 2026**

> **Disclaimer:** This template is a starting point and not legal advice. Have
> your counsel review and sign before relying on it. Square-bracketed fields
> (`[LIKE THIS]`) must be filled in by the parties.

## 1. Parties

This Data Processing Agreement ("DPA") is entered into between:

- **Controller:** `[CUSTOMER LEGAL ENTITY NAME]` ("Customer"), the party that
  determines the purposes and means of processing personal data.
- **Processor:** `[GLUECRON LEGAL ENTITY NAME]` ("Gluecron"), the party that
  processes personal data on the Customer's behalf.

It supplements the Gluecron Terms of Service and takes effect on the date of
the last signature below.

## 2. Subject Matter and Duration

Gluecron processes personal data in order to provide git hosting, code
intelligence, continuous integration, and related developer tools to the
Customer ("Services"). Processing continues for the term of the underlying
subscription and for up to thirty (30) days after termination, during which
Customer may export data. After that, Gluecron deletes Customer data per the
Privacy Policy's retention schedule.

## 3. Nature and Purpose of Processing

Gluecron processes personal data solely to:

- Host, store, transmit, and display Customer repositories and related content.
- Authenticate users and maintain sessions.
- Run code intelligence features (analysis, auto-repair, push risk review)
  where the Customer has enabled them.
- Send transactional email (account, security, and activity notifications).
- Diagnose abuse, fraud, and operational issues.

Gluecron will not process personal data for its own marketing, advertising, or
model-training purposes.

## 4. Types of Personal Data

- **Account information:** username, email address, display name, bio.
- **Authentication data:** hashed passwords, session tokens, SSH public keys,
  API tokens (hashed).
- **Commit metadata:** author name and email, commit timestamps, refs.
- **Git content:** any personal data embedded in source code, commit messages,
  issues, pull requests, or comments that Customer chooses to upload.
- **Operational logs:** IP address, user agent, request timestamps (retained
  90 days).

## 5. Categories of Data Subjects

- Customer employees and contractors with Gluecron accounts.
- External contributors who interact with Customer repositories (issues,
  pull requests, comments).
- Individuals named in commit history or repository content.

## 6. Sub-processors

Customer authorises the following sub-processors. Gluecron will give at least
30 days' notice of any additions or replacements.

| Sub-processor | Purpose | DPA |
| --- | --- | --- |
| Neon (Databricks) | Managed PostgreSQL hosting | https://neon.tech/dpa |
| Fly.io | Application hosting and container compute | https://fly.io/legal/dpa |
| Anthropic | Code intelligence and AI review features | https://www.anthropic.com/legal/commercial-terms |
| Voyage AI | Embeddings for semantic code search | https://www.voyageai.com/terms-of-service |
| Resend | Transactional email delivery | https://resend.com/legal/dpa |

## 7. Security Measures

- **In transit:** all client and sub-processor traffic is encrypted with TLS.
- **At rest:** database storage is encrypted by Neon; bare git repositories
  reside on encrypted host volumes.
- **Secrets:** passwords are hashed with bcrypt; API tokens and callback
  secrets are hashed with SHA-256; webhook payloads are signed with
  HMAC-SHA256.
- **Access control:** production access is limited to named personnel, scoped
  to least privilege, and logged.
- **Audit logging:** authentication, repository access, and administrative
  actions are logged and retained alongside operational logs.
- **Backups:** routine encrypted backups with documented restore procedures.

## 8. Personal Data Breach Notification

Gluecron will notify the Customer without undue delay and in any case within
**72 hours** of becoming aware of a personal data breach affecting Customer
data. Notice will include the nature of the breach, categories and approximate
number of data subjects affected, likely consequences, and mitigation taken or
proposed.

## 9. Data Subject Rights Requests

Gluecron will assist Customer in responding to access, rectification, erasure,
restriction, portability, and objection requests from data subjects. Customers
should route requests to `privacy@[CUSTOMER DOMAIN]`; Gluecron staff contacted
directly by a data subject will refer the individual to the Customer.

## 10. International Transfers

Where personal data is transferred outside the EEA, UK, or Switzerland to a
jurisdiction without an adequacy decision, the parties rely on the European
Commission's Standard Contractual Clauses (2021/914), with the UK Addendum
where applicable, which are incorporated into this DPA by reference.

## 11. Return or Deletion

On termination of the Services, Gluecron will, at Customer's election, return
or delete Customer personal data within 30 days, except where retention is
required by law.

## 12. Sign-off

**Customer (Controller):**

- Entity: `[CUSTOMER LEGAL ENTITY NAME]`
- Signatory: ______________________________
- Title: __________________________________
- Date: ___________________________________

**Gluecron (Processor):**

- Entity: `[GLUECRON LEGAL ENTITY NAME]`
- Signatory: ______________________________
- Title: __________________________________
- Date: ___________________________________
