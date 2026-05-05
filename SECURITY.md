# Security Policy

Please do not open public issues for vulnerabilities or leaked credentials.

Report security concerns privately to the repository owner or maintainer. Include the affected component, reproduction steps, and the minimum detail needed to validate the issue.

Before making the repository public or cutting a release, run:

```powershell
pnpm security:scan -- --history
pnpm security:scan -- --include-ignored
pnpm audit --prod
```

The ignored-file scan is expected to flag real local `.env` or `.dev.vars` values if they exist. Do not commit those files.
