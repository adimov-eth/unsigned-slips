# p2p-slip-verifier

Working TypeScript verifier for bank PDF slips. Built for a P2P desk: traders receive a file that says they paid.

The verifier asks whether the file matches what that bank’s generator emits — not whether it was edited. RSHB (JasperReports + OpenPDF) is the only profile. The fingerprint is deterministic: binary marker, font graph, zlib, punctuation as glyph escapes. Sloppy forgeries break it. The checks catch them.

The same working verifier is the proof an unsigned slip can be forged undetectably. There is no issuer key. A slip written to the fingerprint is as “real” as a bank one to this class of checker.

Not a product.

## What it catches

- deleted font objects
- dates that cannot exist together
- raw ASCII where authentic streams use glyph escapes
- a from-scratch file from the wrong generator

## What it cannot catch

A slip written to the fingerprint. Files are not signed. There is no seal.

## Commands

```bash
bun install
bun run verify path/to/slip.pdf
bun run extract path/to/slip.pdf ./data/artifacts
bun run compare ./data/artifacts/a.json ./data/artifacts/b.json
```

Slips stay off this repo.

Boris Adimov
