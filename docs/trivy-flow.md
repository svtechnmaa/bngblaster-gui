# CI and required security workflow

This diagram treats `test_secret_scan.yml` as the required security workflow.
A push to a branch with an open PR targeting `main` runs both workflows below.
A push directly to `main` runs the build workflow; the security workflow is PR-only.

```mermaid
flowchart TD
    Dev[Developer pushes code] --> Event{Push destination}
    Event -->|Branch with an open PR to main| PR[PR opened or updated]
    Event -->|main| BuildStart
    Event -->|Branch without an open PR| NoRun[Neither workflow is triggered]

    subgraph Required[Required workflow - test_secret_scan.yml]
        Policy[Read org variable IGNORE_FINDINGS<br/>Look up current repository name]
        FS[trivy-fs-scan action<br/>Copy changed files into .trivy-scope<br/>Scan secrets, misconfigurations, vulnerabilities]
        Collect[Collect report.json and meta.json]
        R1[trivy-report action<br/>One Summary and email artifact<br/>Evaluate merge gate]
        M1[Separate trivy-mail job and action<br/>Download artifact and send one email if needed]
        Policy --> FS --> Collect --> R1 --> M1
    end

    subgraph Build[Build workflow - main.yml]
        BuildStart[Checkout and check commit flags<br/>no-ci skips build and scan work]
        Compose[Docker Compose<br/>Build and start backend and frontend<br/>Tag images with commit SHA]
        DF[trivy-dockerfile-scan action x2<br/>Scan backend and frontend build contexts<br/>Check Dockerfile configuration plus vuln and secret]
        Images[trivy-image-scan action x2<br/>Scan backend:SHA and frontend:SHA]
        R2[trivy-report action<br/>Combine collected scans<br/>One Summary, email artifact, and gate]
        Push[Gate passes: check services<br/>Push images to GHCR]
        M2[Separate notify_trivy job<br/>trivy-mail action sends one email if needed]
        Release[release job after successful build<br/>semantic-release action<br/>Publish release tags and update charts if released]
        Check[check_job_results action<br/>Check build, release, and notification outcomes]
        BuildStart --> Compose --> DF --> Images --> R2
        R2 -->|Pass| Push --> Release
        R2 -->|After build job finishes, including gate failure| M2
        Release --> Check
        M2 --> Check
    end

    PR --> Policy
    PR --> BuildStart
```

- Both workflows run independently. Each has its own report and email; they do not combine reports across workflows.
- The required workflow scans only changed files, with image scanning disabled. Its `IGNORE_FINDINGS` mapping controls `ignore_finding`; a missing entry defaults to `false`.
- The build workflow explicitly uses `ignore_finding: false` and does not read `IGNORE_FINDINGS`. A required-workflow exception therefore does not bypass its build gate.
- In the updated `trivy-report` action, secrets and scan failures always fail. `ignore_finding: true` allows vulnerabilities and misconfigurations while keeping them in the report and email.
- Scans select HIGH/CRITICAL findings and exclude vulnerabilities without fixes. No findings or scan failures means a Summary with no email.
- Scan steps collect results; the report action prepares email files before evaluating the gate. Mail jobs use `always()` with `send_mail=true`, so blocking findings can still produce an email.
- `no-ci:` does not bypass the required workflow. `no-scan:` skips Trivy scan work in the build workflow. The Robot test job is currently commented out.
- The diagram assumes `test_secret_scan.yml` is required; it does not change the organization ruleset. That file currently contains no Betterleaks trailer-check job. Issue creation is not implemented.
