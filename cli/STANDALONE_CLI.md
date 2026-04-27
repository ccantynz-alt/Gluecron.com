# Gluecron CLI (`gc`)

The `gc` CLI replaces `git` + `gh` + GitHub Actions CLI with a single tool that understands your entire development workflow.

## Installation

```bash
# Via Bun
bun install -g gluecron

# Via install script
curl -fsSL https://get.gluecron.com | sh
```

## Configuration

```bash
export GLUECRON_URL=https://your-gluecron-instance.com
export GLUECRON_TOKEN=gc_your_api_token

# Or run once:
gc auth login
```

## Core Commands

### Repository
```bash
gc init                          # Initialise a new Gluecron repo
gc clone owner/repo              # Clone a repo
gc push                          # Push changes (like git push, but smarter)
gc push --draft                  # Push and open a draft PR
```

### Pull Requests
```bash
gc pr create                     # Open a PR (AI generates title + description)
gc pr create --ai-description    # AI writes full PR description from diff
gc pr review                     # Get AI review of the current branch
gc pr review --file src/auth.ts  # AI review focused on a specific file
gc pr merge                      # Merge current PR
gc pr list                       # List open PRs
```

### CI
```bash
gc ci status                     # Show CI status for current branch
gc ci logs                       # Stream CI logs
gc ci rerun                      # Rerun failed CI jobs
```

### Deployment
```bash
gc deploy                        # Trigger deploy for current branch
gc deploy --env production       # Deploy to specific environment
gc logs --env production         # Stream production logs
gc rollback                      # Rollback last deployment
```

### AI Features
```bash
gc ai ask "why is the auth test failing"     # Ask about the codebase
gc ai ask "where do we handle rate limiting"  # Semantic code search via CLI
gc ai review                                  # Full AI code review
gc ai fix                                     # AI suggests fixes for current errors
gc ai docs                                    # Generate docs for changed files
```

### Issues
```bash
gc issue create                  # Create issue (AI suggests labels/assignees)
gc issue list                    # List issues
gc issue close 42                # Close issue
```

## Flywheel Integration

Every `gc ai ask` response includes an implicit feedback mechanism:

```bash
gc ai ask "how does billing work"
# Response displayed...
# Was this helpful? [y/n/e (elaborate)]
```

Ratings feed directly into the Gluecron AI flywheel, improving answer quality for your specific codebase over time.

## Offline Mode

The CLI caches a compressed semantic index of your repo locally. When offline:
- `gc ai ask` works against the local index (last synced at most recent `gc push`)
- Responses are marked `[offline — index from <timestamp>]`
- Full accuracy resumes on next network connection

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GLUECRON_URL` | URL of your Gluecron instance |
| `GLUECRON_TOKEN` | API token for authentication |
| `GLUECRON_OFFLINE` | Set to `1` to force offline mode |
| `GLUECRON_NO_FLYWHEEL` | Set to `1` to disable telemetry (not recommended) |
