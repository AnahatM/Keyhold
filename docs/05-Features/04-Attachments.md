# Attachments

> Files inside the vault, and the three decisions that shape the whole design.
> Current reference. Implemented by `src/main/attachments/`.
>
> **Status: the engine is built and tested. Reading files from disk, the IPC channels, the
> preview components and the drag-and-drop are not.** See §7.

---

## 1. The chunk id is random, and deliberately not the digest

Content-addressed storage usually names a blob by its hash. Here that would be a genuine
disclosure, and it is the most important decision in the module.

Chunk ids are written **in plaintext** before each encrypted chunk — the reader needs them
as additional authenticated data, so they cannot be inside the encryption. A content-derived
id would therefore publish a fingerprint of every attachment to anyone holding the _locked_
file: "is this person storing this document?" becomes a lookup against an encrypted vault,
no password required.

So the id stays random, and deduplication matches on `sha256 + size` over the **metadata**,
which lives inside the encrypted body. Same benefit, no leak. Digest _and_ size, as belt and
braces against a mis-recorded digest capturing an unrelated file.

---

## 2. Reference counting, and the bug it already prevented

A chunk survives while any record still points at it. **Trashed records still count** —
trash is restorable, so dropping their chunks is data loss on a delay; only a permanent
purge removes a reference.

Getting this wrong is not hypothetical. `VaultService.purgeCredential` deleted every chunk
the purged record listed:

```ts
const orphaned = new Set(existing.attachments.map((a) => a.id)); // wrong once chunks are shared
```

With dedupe in place that deletes files other records still display. It now computes the
orphan set from the whole document (`chunkIdsOrphanedBy`), which is the only place that can
answer the question.

Within a single record a chunk id appears at most once, because `AttachmentMeta.id` _is_ the
chunk id and reveal, download and remove all address by it — the same class of bug as
duplicate custom-field ids, where the wrong value comes back rather than an error.
Re-attaching a file already on the record returns the existing metadata rather than a second
entry, and keeps its name: re-attaching is not a rename.

---

## 3. The limits come from how the vault is read, not from a guess

25 MiB per file, 5 MiB warning, 128 MiB per vault across distinct chunks, 64 per record.

The real constraint is that `readContainer` decrypts **every** chunk on unlock and
`writeContainer` concatenates the whole file on save, so peak resident memory is roughly
three times the total. 128 MiB keeps that under about 400 MB; 256 MiB would push it past
750 MB on a machine that also has a browser open.

All four are settings (decision D10), and all four are validated against the container's own
ceiling — a per-file cap above `MAX_CHUNK_BYTES` would write a chunk this app's reader
refuses, and `readContainer` throws before returning anything, so **the whole vault would
stop opening**. A deduplicated add is not charged against the vault total, because the bytes
are already there.

---

## 4. The claimed type is checked, and the detected one is stored

Sniffing reads at most 16 bytes and never parses, decodes or decompresses anything. PNG,
JPEG, GIF, WebP, BMP, TIFF, PDF and the ZIP family are recognised from one registry that
also drives the preview kind, so detection and presentation cannot disagree.

A mismatch is **reported, not refused** — refusing loses a file the user deliberately kept.
But the _stored_ type picks the viewer, and that decision must not belong to whoever supplied
the file. `text/plain` is the only claim that still earns a preview when nothing matches:
text renders as text and executes nothing. `image/svg+xml` and `text/html` are deliberately
absent from the registry.

`evil.pdf.exe` is **flagged, not renamed**. Stripping a second extension would corrupt
`archive.tar.gz`, and a filename is not what makes a file run — _opening_ it is, and Keyhold
never opens an attachment. The disguise check requires a document extension in front of the
runnable one, so the warning stays credible rather than firing on every `.zip`.

Filenames are reduced to a basename, with both separators handled always (a Windows path
arriving on macOS is still a path), control characters and illegal punctuation replaced,
trailing dots and spaces stripped — Windows drops them silently, which turns two different
names into one file — and reserved device names escaped, because `NUL.pdf` writes to the null
device. Truncation happens on code-point boundaries under both the 255-character and 255-byte
limits, keeping the extension. The module returns **names, never paths**.

---

## 5. Orphans are reported, never repaired

Both directions are real after a merge or a partial restore: a chunk nothing references, and
metadata whose chunk is missing. Neither has a correct automatic fix, and repairing destroys
the evidence of which cause it was — a crash, a bad merge, a failing disk, or a bug here.
`pruneUnreferencedChunks` exists and is separate, so removing data is always something a
caller asked for by name.

Errors and audit findings carry ids, sizes and limits only — never a name, a path, a byte or
a digest. An attachment can be a photo of a passport.

---

## 6. Tests

80 tests. **Nine fault injections, all caught**, including the reference boundary in both
directions, the vault total being charged for a deduplicated add, the claimed type being
stored instead of the detected one, and a filename reaching an audit message.

One honest finding worth keeping: removing the path-stripping did **not** fail the "never
produces a name containing a separator" property test, because the illegal-character pass
turns `/` into `_` and the invariant still holds. That is defence in depth working — but it
means the property test alone would not catch the loss of traversal semantics, and the
explicit "keeps only the last component" test is what does. Worth knowing before anyone trims
it as redundant.

---

## 7. Not built

- Reading a file from disk, the IPC channels, drag-and-drop, the save-to-disk flow and its
  plaintext warning, the preview components and the image lightbox.
- `VaultSettings` does not yet carry the attachment caps, so the defaults are in force rather
  than the vault's own choice (hard rule 7 wants them travelling with the file).
- Orphan cleanup on save, and digest verification on read, are implemented but not yet called
  from the vault service.
- **Compression** — the KEEP spec says chunks are deliberately uncompressed.
- Archive introspection to tell `.docx` from `.zip`: it would mean decompressing
  attacker-supplied data to answer a cosmetic question.
