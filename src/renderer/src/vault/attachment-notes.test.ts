// SPDX-License-Identifier: GPL-3.0-or-later
import type { AttachmentAddView } from '@shared/model/attachment.js';
import { describe, expect, it } from 'vitest';
import { addNotes } from './attachment-notes.js';

/**
 * Guard: what the engine found, the user is told.
 *
 * `addAttachment` sniffs the bytes, sanitises the filename and detects a disguised second
 * extension — and until this panel existed, every one of those findings was computed,
 * returned across IPC, and thrown away. A check nobody sees is a check that may as well not
 * run, so these assert the *reporting*, which is the half that was missing.
 *
 * Worded assertions rather than "returns two notes": a count passes while the sentences say
 * the wrong thing, and the sentences are the entire product here.
 */

function view(overrides: Partial<AttachmentAddView> = {}): AttachmentAddView {
  return {
    meta: {
      id: 'a'.repeat(32),
      name: 'scan.png',
      mime: 'image/png',
      size: 1024,
      sha256: 'b'.repeat(64),
      addedAt: 1_800_000_000_000,
    },
    deduped: false,
    mime: {
      claimed: 'image/png',
      detected: 'image/png',
      status: 'confirmed',
      stored: 'image/png',
      kind: 'image',
    },
    name: { sanitised: 'scan.png', changed: false, executable: false, disguised: false },
    warnLarge: false,
    ...overrides,
  };
}

const joined = (input: AttachmentAddView): string => addNotes(input).join(' ');

describe('addNotes', () => {
  it('says nothing about an ordinary file', () => {
    // The other half of every assertion below. A function that always has something to say
    // trains people to stop reading it.
    expect(addNotes(view())).toEqual([]);
  });

  it('says the file was already in the vault', () => {
    // Without this the user picks a file, the vault does not grow, and the silence reads as
    // the attach having failed.
    expect(joined(view({ deduped: true }))).toMatch(/already in the vault/i);
  });

  it('names the sanitised filename when it changed', () => {
    const notes = joined(
      view({
        name: { sanitised: 'report.pdf', changed: true, executable: false, disguised: false },
      })
    );
    expect(notes).toContain('report.pdf');
  });

  it('warns about a disguised second extension', () => {
    // `invoice.pdf.exe`. The engine deliberately does not rename it into something harmless,
    // because that would hide what it is — which makes this sentence the only place a user
    // can find out.
    const notes = joined(
      view({
        name: { sanitised: 'invoice.pdf.exe', changed: false, executable: true, disguised: true },
      })
    );
    expect(notes).toMatch(/hides a second extension/i);
    expect(notes).toMatch(/untrusted/i);
  });

  it('does not also call a disguised file merely executable', () => {
    // Both are true of `invoice.pdf.exe`, and saying the milder one alongside the sharper
    // one dilutes it. The disguise is the finding that matters.
    const notes = addNotes(
      view({
        name: { sanitised: 'invoice.pdf.exe', changed: false, executable: true, disguised: true },
      })
    );
    expect(notes.filter((note) => /executable/i.test(note))).toEqual([]);
  });

  it('says a plain executable is stored but never run', () => {
    const notes = joined(
      view({
        name: { sanitised: 'setup.exe', changed: false, executable: true, disguised: false },
      })
    );
    expect(notes).toMatch(/never run it/i);
  });

  it('reports a type that disagrees with the bytes, naming both', () => {
    const notes = joined(
      view({
        mime: {
          claimed: 'application/pdf',
          detected: 'image/png',
          status: 'mismatch',
          stored: 'image/png',
          kind: 'image',
        },
      })
    );
    expect(notes).toContain('application/pdf');
    expect(notes).toContain('image/png');
  });

  it('handles a mismatch where nothing was recognised', () => {
    // `detected: null` is the common case for an unknown format, and interpolating it raw
    // would print "is actually null" at a user.
    const notes = joined(
      view({
        mime: {
          claimed: 'application/pdf',
          detected: null,
          status: 'mismatch',
          stored: 'application/octet-stream',
          kind: 'other',
        },
      })
    );
    expect(notes).toMatch(/unrecognised/i);
    expect(notes).not.toContain('null');
  });

  it('warns about a large file in terms of what it costs', () => {
    // "Large" alone is not actionable. What it costs — a slower open and save — is.
    expect(joined(view({ warnLarge: true }))).toMatch(/longer to open and save/i);
  });

  it('reports every finding when a file trips all of them', () => {
    const notes = addNotes(
      view({
        deduped: true,
        warnLarge: true,
        name: { sanitised: 'x.pdf.exe', changed: true, executable: true, disguised: true },
        mime: {
          claimed: 'application/pdf',
          detected: 'application/x-msdownload',
          status: 'mismatch',
          stored: 'application/x-msdownload',
          kind: 'other',
        },
      })
    );
    // Four: deduped, renamed, disguised, mismatch, large — with `executable` suppressed by
    // the disguise. Asserted as a set of matched sentences rather than a length, so adding a
    // finding does not silently break this into a number nobody re-derives.
    expect(notes.some((n) => /already in the vault/i.test(n))).toBe(true);
    expect(notes.some((n) => n.includes('x.pdf.exe'))).toBe(true);
    expect(notes.some((n) => /hides a second extension/i.test(n))).toBe(true);
    expect(notes.some((n) => n.includes('application/pdf'))).toBe(true);
    expect(notes.some((n) => /longer to open and save/i.test(n))).toBe(true);
  });

  it('never repeats the file s own contents, only facts about it', () => {
    // These sentences go into a toast and are the kind of thing people screenshot. Names and
    // types are already in the safe projection; nothing else about the file may appear here.
    const notes = joined(view({ deduped: true, warnLarge: true }));
    expect(notes).not.toContain('sha256');
    expect(notes).not.toContain('b'.repeat(64));
  });
});
