// SPDX-License-Identifier: GPL-3.0-or-later
import { MERGE_NOTE_KINDS, type MergeNote, type MergeNoteKind } from '@shared/model/sync.js';

/**
 * Everything the merge decided on its own, said out loud.
 *
 * A note is not a conflict — nothing is pending and nothing is provisional. It exists because
 * "the merge silently did the right thing" and "the merge silently did something" are
 * indistinguishable to a user staring at a vault that changed, and the entire premise of a merge
 * report is that a merge is never silent.
 *
 * Which means these must not be a collapsed footnote nobody opens. Two of them are load-bearing:
 * `'attachment-needed'` is the caller's instruction to copy chunks across or leave records
 * pointing at files that will not open, and `'record-kept-unmatched'` is the sentence that
 * answers "did this delete anything?" for every two-way merge. Those two get {@link
 * NOTE_SEVERITY} `'attention'` and sort to the top.
 *
 * The copy over the counts is this module's other job. `MergeNote.count` is a number precisely so
 * the engine does not have to pluralise, and this is where that debt is paid.
 */

export type MergeNoteSeverity = 'attention' | 'notice';

interface NoteCopy {
  /** The heading for a group of these. Plural, because a group is what is shown. */
  readonly label: string;
  /** One sentence on what it means for the user's data. */
  readonly description: string;
  readonly severity: MergeNoteSeverity;
  /** Never colour alone — a shape that survives greyscale. */
  readonly symbol: string;
  /** How to read `MergeNote.count` for this kind, when it has one. */
  readonly countNoun: string | null;
}

/**
 * The words for each note kind.
 *
 * A `Record` over the closed union rather than a lookup with a fallback: adding a note kind to
 * the engine and forgetting the copy here is then a **type error**, instead of a note rendering
 * as its own raw identifier in front of a user.
 */
const NOTE_COPY: Readonly<Record<MergeNoteKind, NoteCopy>> = {
  'attachment-needed': {
    label: 'Attachments that still live in the other file',
    description:
      'These records point at attachments whose contents are in the other vault. Keyhold copies them across as part of applying the merge.',
    severity: 'attention',
    symbol: '⇩',
    countNoun: null,
  },
  'record-kept-unmatched': {
    label: 'Records kept rather than deleted',
    description:
      'Present in only one of the two files. Keyhold kept them, because without shared history it cannot tell a deletion from a record that was never there.',
    severity: 'attention',
    symbol: '⊕',
    countNoun: null,
  },
  'record-purged': {
    label: 'Records dropped',
    description: 'Gone from both files since they last agreed — both devices had deleted them.',
    severity: 'attention',
    symbol: '✕',
    countNoun: null,
  },
  'tombstone-preserved': {
    label: 'Deletions honoured',
    description:
      'One file had deleted these and the other still held them. The deletion was kept, because a tombstone is a decision and an old copy is not.',
    severity: 'attention',
    symbol: '⌫',
    countNoun: null,
  },
  'history-truncated': {
    label: 'History trimmed to fit',
    description:
      'Combining two timelines went past the record’s retention limit, so the oldest versions were dropped. Raise the limit on the record to keep more.',
    severity: 'attention',
    symbol: '⇥',
    countNoun: 'version',
  },
  'folder-cycle-broken': {
    label: 'Folder loops untangled',
    description:
      'The merged folder tree pointed at itself. One link was cut so the tree makes sense again — check these folders sit where you expect.',
    severity: 'attention',
    symbol: '⟲',
    countNoun: null,
  },
  'record-unfiled': {
    label: 'Records moved to the top level',
    description: 'Their folder exists in neither file, so they were moved out rather than lost.',
    severity: 'attention',
    symbol: '↥',
    countNoun: null,
  },
  'folder-reparented': {
    label: 'Folders moved to the top level',
    description: 'Their parent folder did not survive the merge, so they were moved out.',
    severity: 'attention',
    symbol: '↥',
    countNoun: null,
  },
  'record-added': {
    label: 'Records brought in',
    description: 'These exist only in the other file, and are now in yours too.',
    severity: 'notice',
    symbol: '+',
    countNoun: null,
  },
  'record-restored': {
    label: 'Records taken out of the trash',
    description: 'The other file had restored these, so they are live again here.',
    severity: 'notice',
    symbol: '↺',
    countNoun: null,
  },
  'history-renumbered': {
    label: 'Version numbers reassigned',
    description:
      'Two timelines were interleaved, so versions were renumbered to stay in order. Nothing was lost.',
    severity: 'notice',
    symbol: '#',
    countNoun: 'version',
  },
  'folder-added': {
    label: 'Folders brought in',
    description: 'These exist only in the other file, and are now in yours too.',
    severity: 'notice',
    symbol: '+',
    countNoun: null,
  },
  'folder-kept-unmatched': {
    label: 'Folders kept rather than deleted',
    description: 'Present in only one of the two files, and kept for the same reason records are.',
    severity: 'notice',
    symbol: '⊕',
    countNoun: null,
  },
  'folder-resurrected': {
    label: 'Folders kept because something is still in them',
    description:
      'One file had deleted these, but a surviving record still lives in them, so they were kept.',
    severity: 'notice',
    symbol: '⊕',
    countNoun: null,
  },
  'saved-search-added': {
    label: 'Saved searches brought in',
    description: 'These exist only in the other file, and are now in yours too.',
    severity: 'notice',
    symbol: '+',
    countNoun: null,
  },
  'saved-search-kept-unmatched': {
    label: 'Saved searches kept rather than deleted',
    description:
      'Present in the shared ancestor and in only one of the two files. Absence alone never deletes, so they were kept.',
    severity: 'notice',
    symbol: '=',
    countNoun: null,
  },
  'tag-added': {
    label: 'Tags brought in',
    description: 'These exist only in the other file, and are now in yours too.',
    severity: 'notice',
    symbol: '+',
    countNoun: null,
  },
  'tag-kept-unmatched': {
    label: 'Tags kept rather than deleted',
    description: 'Present in only one of the two files, and kept for the same reason records are.',
    severity: 'notice',
    symbol: '⊕',
    countNoun: null,
  },
};

/**
 * Display order: everything needing attention, then everything else.
 *
 * Derived from `MERGE_NOTE_KINDS` filtered by severity rather than written out again, so a note
 * kind added to the engine cannot silently fail to appear here (hard rule 8).
 */
const NOTE_ORDER: readonly MergeNoteKind[] = [
  ...MERGE_NOTE_KINDS.filter((kind) => NOTE_COPY[kind].severity === 'attention'),
  ...MERGE_NOTE_KINDS.filter((kind) => NOTE_COPY[kind].severity === 'notice'),
];

export interface MergeNoteGroup {
  readonly kind: MergeNoteKind;
  readonly label: string;
  readonly description: string;
  readonly severity: MergeNoteSeverity;
  readonly symbol: string;
  /** How many notes of this kind. */
  readonly count: number;
  /** The sum of `MergeNote.count` across the group, when the kind counts something. */
  readonly total: number | null;
  readonly notes: readonly MergeNote[];
}

/**
 * Notes grouped by kind, in display order, with nothing filtered and nothing truncated.
 *
 * Every note the engine produced appears in exactly one group — asserted beside this file,
 * because a merge report that quietly dropped the tail of its own note list is worse than one
 * with no notes at all: the user has been told there is nothing more to see.
 */
export function groupNotes(notes: readonly MergeNote[]): readonly MergeNoteGroup[] {
  const byKind = new Map<MergeNoteKind, MergeNote[]>();
  for (const note of notes) {
    const existing = byKind.get(note.kind);
    if (existing === undefined) byKind.set(note.kind, [note]);
    else existing.push(note);
  }

  const groups: MergeNoteGroup[] = [];
  for (const kind of NOTE_ORDER) {
    const kindNotes = byKind.get(kind);
    if (kindNotes === undefined || kindNotes.length === 0) continue;
    const copy = NOTE_COPY[kind];
    const counted = kindNotes.filter((note) => note.count !== null);
    groups.push({
      kind,
      label: copy.label,
      description: copy.description,
      severity: copy.severity,
      symbol: copy.symbol,
      count: kindNotes.length,
      total:
        copy.countNoun === null || counted.length === 0
          ? null
          : counted.reduce((sum, note) => sum + (note.count ?? 0), 0),
      notes: kindNotes,
    });
  }
  return groups;
}

/** The count noun for a kind, so a group can say "41 versions" rather than "41". */
export function noteCountNoun(kind: MergeNoteKind): string | null {
  return NOTE_COPY[kind].countNoun;
}

/** Notes across every group. Must equal the input length — nothing is dropped. */
export function totalNotes(groups: readonly MergeNoteGroup[]): number {
  return groups.reduce((total, group) => total + group.count, 0);
}

/**
 * The line at the top of the notes panel.
 *
 * Leads with the attention count when there is one, because "8 notes" and "3 things worth
 * looking at, and 5 notes besides" are the same number and completely different sentences.
 */
export function notesHeadline(groups: readonly MergeNoteGroup[]): string {
  const total = totalNotes(groups);
  if (total === 0) return 'The merge made no decisions of its own.';
  const attention = groups
    .filter((group) => group.severity === 'attention')
    .reduce((sum, group) => sum + group.count, 0);
  const rest = total - attention;
  if (attention === 0) return `${plural(rest, 'decision')} Keyhold made for you.`;
  if (rest === 0) return `${plural(attention, 'thing')} worth looking at.`;
  return `${plural(attention, 'thing')} worth looking at, and ${plural(rest, 'other decision')} besides.`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
