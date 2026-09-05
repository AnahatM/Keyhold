# 04 · Vault format

The KEEP container — the on-disk shape of a Keyhold vault.

| Page                                                 | What it covers                                                                                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`00-KEEP-Format-Spec.md`](./00-KEEP-Format-Spec.md) | The complete, publishable specification: byte layout, header schema and key ordering, key derivation bounds, envelope encryption, AAD rules, compression, the required read order, versioning, and the durability requirements |

**This spec is written to be implementable by someone who has never seen Keyhold's
source.** That is the anti-lock-in guarantee (goal G3) made concrete: if this project
disappears, the format does not take anyone's data with it.

**Related:** [`../02-Security/`](../02-Security/_INDEX.md) covers the cryptographic design
and why each primitive was chosen. The frozen founding rationale is in
[`../specs/2026-09-02-keyhold-product-spec.md`](../specs/2026-09-02-keyhold-product-spec.md) §5.4.
