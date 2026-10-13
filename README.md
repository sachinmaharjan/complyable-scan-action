# ComplyAble accessibility scan

Run [ComplyAble](https://complyable-one.vercel.app) WCAG scans in CI and fail pull requests that introduce accessibility barriers.

It tests every crawled page against the official W3C success criteria for WCAG **2.1 AA** (the DOJ ADA Title II standard), **2.2 AA**, or **2.0 AA**. Coverage:
- axe-core rules
- Keyboard focus walk
- 320px reflow
- Text spacing
- Carousel, media, link, and form checks

Every failure gets a priority: **P1** blocks access, **P2** is a significant barrier, **P3** is minor.

An API key is required. [Contact ComplyAble](https://complyable-one.vercel.app/contact) to get one, then add it as a repository secret named `COMPLYABLE_API_KEY`.

## GitHub Action

Scan every successful preview deployment (Vercel, Netlify, and others that report GitHub deployments):

```yaml
name: Accessibility
on: deployment_status

jobs:
  wcag:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: sachinmaharjan/complyable-scan-action@v1
        with:
          api_key: ${{ secrets.COMPLYABLE_API_KEY }}
          url: ${{ github.event.deployment_status.environment_url || github.event.deployment_status.target_url }}
          standard: "2.1"
          pages: 10
          fail_on: P1
```

The run adds a job summary with the score and top issues, error annotations for failures, and a JUnit report (`complyable-results.xml`) you can upload or feed to a test reporter. Use branch protection to block merges when the check fails.

### Protected previews and logged-in pages

```yaml
        with:
          # Vercel Deployment Protection: Project Settings → Deployment Protection → Protection Bypass for Automation
          headers: |
            x-vercel-protection-bypass: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
            x-vercel-set-bypass-cookie: true
          # Pages behind a login: use a test account's session cookie
          cookies: |
            session=${{ secrets.TEST_SESSION_COOKIE }}
```

Header and cookie values are masked in logs. They are sent only to the scanned site, never stored, and the crawler skips logout, delete, and cancel links.

### Inputs

| Input | Default | Description |
| --- | --- | --- |
| `api_key` | (required) | ComplyAble API key |
| `url` | (required) | URL to scan |
| `standard` | `2.1` | `2.0`, `2.1`, or `2.2` (Level AA) |
| `pages` | `10` | Pages to crawl (1–25, capped by plan) |
| `fail_on` | `P1` | `P1`, `P2`, `P3`, or `none` (report only) |
| `format` | `junit` | Report file format: `junit`, `json`, or `text` |
| `output` | `complyable-results.xml` | Report file path |
| `cookies` | | `name=value` per line |
| `headers` | | `Name: value` per line |

Outputs: `score`, `passed`, `failing`, `report`.

## CLI

No install needed (Node 20+):

```bash
export COMPLYABLE_API_KEY=ca_live_...
npx github:sachinmaharjan/complyable-scan-action scan https://www.example.gov --standard 2.1 --pages 10 --fail-on P1
npx github:sachinmaharjan/complyable-scan-action scan https://staging.example.gov --format junit --output a11y.xml \
  --header "Authorization: Bearer $TOKEN"
```

Exit codes: `0` passed, `1` failures at or above `--fail-on`, `2` usage or service error. Works in any CI system, including GitLab, Azure DevOps, Jenkins, and CircleCI.

## Notes

Only WCAG failures can fail a build. "Needs review" and advisory items appear in the report but never fail it. Automated testing finds a subset of WCAG issues, so pair it with manual review.
