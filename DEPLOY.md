# Deploying the case study to Vercel

The case study is a single self-contained page: `Claude Case Study/index.html`.
All fonts, images and icons are inlined as data URIs, and the demo video is
loaded from an absolute `media.githubusercontent.com` URL, so the deployed
output is just that one HTML file plus `Claude Case Study/vercel.json`.
Nothing from `assets/`, `backend/` or `extension/` needs to ship.

Vercel project name: **`claude-groupchats`** (Vercel project names are
lowercase and hyphenated, so "Claude Groupchats" becomes this slug; the
default domain is `claude-groupchats.vercel.app`).

## Option A — non-interactive, with an access token

Create a token at https://vercel.com/account/tokens, then from the repo root:

```bash
npm i -g vercel
export VERCEL_TOKEN='<your-token>'

# Create/link the project, then ship to production.
vercel link   --yes --project claude-groupchats --cwd "Claude Case Study"
vercel deploy --prod --yes --cwd "Claude Case Study"
```

`vercel link` writes `Claude Case Study/.vercel/` (git-ignored). After the
first link, redeploying is just the `vercel deploy` line.

If the account is on a team, add `--team <team-slug>` to the `link` command.

## Option B — interactive login

```bash
npm i -g vercel
vercel login
vercel link   --yes --project claude-groupchats --cwd "Claude Case Study"
vercel deploy --prod --cwd "Claude Case Study"
```

## Option C — Vercel Git integration (no CLI)

Import the repository at https://vercel.com/new and set:

- **Project Name**: `claude-groupchats`
- **Framework Preset**: Other
- **Root Directory**: `Claude Case Study`
- **Build Command**: leave empty
- **Output Directory**: leave empty

Every push to the connected branch then redeploys automatically.
