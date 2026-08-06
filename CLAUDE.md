Flight OTA prototype

US online travel agency selling flights. We are merchant of record: the traveler pays us, we settle with the airline separately. Built on the Hyperswitch hosted sandbox.

Assignment is in ASSIGNMENT.md. Deliverables: a hosted working prototype, a 3-page architecture and decisions doc, and this session.

Rules

- Hyperswitch facts come from the live docs (docs.hyperswitch.io, api-reference.hyperswitch.io, github.com/juspay/hyperswitch). Do not answer from memory. If you cannot verify an endpoint or field, say so instead of guessing.
- Hosted sandbox only. sandbox.hyperswitch.io, publishable keys start with pk_snd_. No self-hosting, no real PSP credentials.
- The API key is server-side only. The repo is public. Nothing secret reaches the browser.
- Do not add a payment method or connector we cannot actually complete a sandbox payment on. If it needs live credentials,
  it goes in the deferred list, not the build.
- Every payment behaviour decision gets a line in DECISIONS.md: what we chose, what we rejected, why.
- Ask before expanding scope. Three days.

  