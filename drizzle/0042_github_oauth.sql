-- Gluecron migration 0042: GitHub OAuth sign-in (Block L6).
--
-- L6 — "Sign in with GitHub" as a one-click sign-in option for the broadest
-- developer audience. GitHub speaks OAuth 2.0 (not strict OIDC) — no
-- id_token, no /userinfo endpoint — but the auth-code shape is close enough
-- that we reuse the existing `sso_config` schema and keep a second singleton
-- row keyed by id='github' alongside the enterprise IdP at id='default'.
--
-- The pure network protocol differences are handled in
-- src/lib/github-oauth.ts; the route + linkage live in
-- src/routes/github-oauth.ts and a new findOrCreateUserFromGithub helper in
-- src/lib/sso.ts. `sso_user_links.subject` is prefixed with "github:" so
-- multiple IdPs can coexist without ID collisions.
--
-- Strictly additive: no new tables, no column changes — just a seed row.

--> statement-breakpoint
INSERT INTO "sso_config" (
  "id",
  "provider_name",
  "issuer",
  "authorization_endpoint",
  "token_endpoint",
  "userinfo_endpoint",
  "scopes",
  "enabled",
  "auto_create_users"
) VALUES (
  'github',
  'GitHub',
  'https://github.com',
  'https://github.com/login/oauth/authorize',
  'https://github.com/login/oauth/access_token',
  'https://api.github.com/user',
  'read:user user:email',
  false,
  true
)
ON CONFLICT ("id") DO NOTHING;
