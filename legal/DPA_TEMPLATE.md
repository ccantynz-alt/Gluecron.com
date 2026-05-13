# Data Processing Addendum (DPA)

> **Status: TEMPLATE.** This is a starting point for a Data Processing
> Addendum to be entered into between gluecron (the "Processor") and an
> enterprise customer (the "Controller"). It is structured around GDPR
> Article 28 and references the gluecron Terms of Service and Privacy
> Policy by incorporation.
>
> **DO NOT SIGN THIS WITHOUT LAWYER REVIEW.** This template aims to be
> legally literate but is not legal advice. The first enterprise contract
> must go through a qualified data protection lawyer in the relevant
> jurisdiction(s).

---

## 1. Definitions

Terms used in this DPA have the meaning given in the GDPR (EU Regulation
2016/679) and the UK GDPR. "**Personal Data**" means any information
relating to an identified or identifiable natural person processed under
the Service. "**Processing**" means any operation performed on Personal
Data. "**Customer Data**" means Personal Data that the Controller
uploads to or generates within the Service.

## 2. Scope and roles

- gluecron acts as a **Processor** with respect to Customer Data.
- The Controller is the gluecron customer (a company, organisation, or
  individual) who determines the purposes and means of processing.
- This DPA governs all Customer Data processed by gluecron under the
  Service Agreement.

## 3. Subject matter, duration, nature, and purpose of processing

- **Subject matter.** Provision of source-code hosting, code
  intelligence, CI/CD, project management, and related services
  (the "Service").
- **Duration.** The term of the Service Agreement, plus any post-
  termination retention period set out in §10 below.
- **Nature.** Storage, transmission, computation, indexing, AI-driven
  analysis, backup, and presentation of Customer Data.
- **Purpose.** Delivery of the Service ordered by the Controller.

## 4. Types of personal data and categories of data subjects

- **Categories of data subjects.** The Controller's employees,
  contractors, end-users, and anyone whose data the Controller chooses
  to upload.
- **Types of personal data** routinely processed:
  - Account identifiers (name, email, username)
  - Authentication metadata (hashed passwords, passkey public keys,
    TOTP secrets)
  - Source code content (which may incidentally include personal data
    embedded in comments, fixtures, or test data)
  - Commit metadata (author name, email, timestamps)
  - Audit / activity log entries (IP address truncated by SHA-256, user
    agent, action verb)
  - Email content for notifications sent through the Service
- **Special category data.** None routinely. The Controller MUST NOT
  upload special-category data (Article 9 GDPR) or criminal-offence
  data (Article 10) without first executing a separate written
  amendment to this DPA.

## 5. Processor obligations

gluecron shall:

1. Process Customer Data **only on documented instructions** from the
   Controller. The Service Agreement and the configured product
   settings constitute such instructions.
2. Ensure that **persons authorised to process** Customer Data have
   committed to confidentiality or are under statutory confidentiality
   obligations.
3. Implement **appropriate technical and organisational measures** to
   protect Customer Data, as further described in Annex A.
4. **Engage sub-processors** only as permitted under §8.
5. **Assist the Controller** in responding to data-subject requests
   under Articles 12 – 22 GDPR via the Service's export, deletion, and
   audit-log APIs.
6. **Notify the Controller without undue delay** (and in any case
   within 48 hours of becoming aware) of any Personal Data Breach,
   including the nature of the breach, categories and approximate
   number of data subjects and records affected, likely consequences,
   and measures taken or proposed.
7. **Assist the Controller** with Data Protection Impact Assessments
   (Article 35) and prior consultations with supervisory authorities
   (Article 36), to the extent reasonably required and at the
   Controller's expense beyond commercially reasonable assistance.
8. **Delete or return** all Personal Data at the end of the Service
   Agreement under §10.
9. Make available **all information necessary to demonstrate compliance**
   with Article 28 GDPR and allow for and contribute to audits as set
   out in §9.

## 6. Controller obligations

The Controller represents and warrants that:

1. It has a **lawful basis** under Article 6 GDPR (and, where
   applicable, Article 9) for processing Personal Data using the
   Service;
2. It has provided required **privacy notices** to data subjects;
3. It will not upload data the Service is not designed for (e.g. unique
   patient health records, raw payment card numbers).

## 7. Security measures

gluecron shall maintain the technical and organisational measures
described in **Annex A** (Security Measures). Without limiting Annex A,
gluecron commits to:

- Encryption of Customer Data in transit (TLS 1.2 or higher)
- Encryption of Customer Data at rest where the underlying storage
  layer supports it (Neon Postgres, S3-compatible object stores)
- Bcrypt/Argon2 hashing of user passwords; never stored in cleartext
- Sub-processor list maintained under §8 and Annex B

## 8. Sub-processors

The Controller grants gluecron general written authorisation to engage
sub-processors. gluecron maintains the current sub-processor list at
**Annex B** and shall notify the Controller of any intended changes
giving the Controller the opportunity to object on **reasonable grounds**
within 30 days. Sub-processor commitments shall be no less protective
than those in this DPA.

## 9. Audit rights

Once per year, with at least 30 days' written notice, the Controller
(or a mutually agreed independent auditor under NDA) may audit
gluecron's compliance with this DPA. The Controller shall bear the
cost of such audit except where it identifies material non-compliance.

## 10. Return or deletion of data

Upon termination of the Service Agreement, gluecron shall, at the
Controller's election: (a) return all Customer Data, or (b) delete all
Customer Data and certify deletion in writing. Backups containing
Customer Data shall be deleted in the ordinary course no later than
**90 days** after termination.

## 11. International transfers

Where Customer Data is transferred outside the EEA / UK, gluecron and
the Controller shall enter into the EU Standard Contractual Clauses
(Commission Decision (EU) 2021/914) and the UK International Data
Transfer Addendum where applicable, which are hereby incorporated by
reference.

## 12. Liability

Liability under this DPA is subject to the limitations of liability set
out in the Service Agreement. Nothing in this DPA limits liability that
cannot be limited by law.

## 13. Governing law

This DPA is governed by the law of the **[CUSTOMER’S JURISDICTION]**.
Disputes shall be resolved as set out in the Service Agreement.

---

## Annex A — Security Measures (summary)

gluecron implements, at minimum, the following measures:

- **Access control** — unique user IDs, password complexity, optional
  TOTP / passkeys, OIDC SSO; least-privilege RBAC enforced server-side
- **Network** — TLS 1.2+ for all external traffic; HSTS; defence-in-
  depth at reverse proxy + application layers
- **Application** — input validation, parameterised queries, CSP,
  CSRF protections, rate limiting, request-ID tracing
- **Storage** — encrypted at rest by underlying provider (Neon, S3);
  separation of database and object-store credentials
- **Vulnerability management** — dependency scanning, secret scanning,
  AI-assisted security review on every push, security advisories
- **Backups** — daily Postgres dumps with monthly restore drills (per
  `docs/BACKUP_RESTORE_DRILL.md`); 90-day backup retention
- **Logging** — audit log of write actions (user / action / target),
  application logs with request IDs, error tracking via
  `ERROR_WEBHOOK_URL` / `SENTRY_DSN`
- **Incident response** — documented 48-hour notification commitment;
  AI-assisted incident responder opens an issue on deploy failure

## Annex B — Sub-processor list

_To be completed before signing. Current candidates:_

| Sub-processor | Purpose | Location | Safeguard |
|---|---|---|---|
| Neon | Primary Postgres database | US / EU regions | SCCs + DPA |
| Anthropic | AI model inference (Claude) | US | SCCs + DPA + zero-retention API |
| Vultr | Hosting (bare-metal VPS) | Region selected per customer | SCCs |
| Resend | Transactional email (optional) | US / EU | SCCs |
| Sentry | Error tracking (optional) | US / EU | SCCs |

## Annex C — Contact

- **Data Protection Officer / Privacy contact:** privacy@gluecron.com
- **Security incident reporting:** security@gluecron.com
