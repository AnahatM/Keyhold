// SPDX-License-Identifier: GPL-3.0-or-later
import { VaultError } from '../crypto/errors.js';

/**
 * A deliberately small XML reader, for two known schemas and nothing else.
 *
 * Keyhold reads XML in exactly two places: KeePass's plain `.xml` export, and the inner
 * payload of a `.kdbx` file. Both are written by one family of tools, and neither uses
 * namespaces, processing instructions, doctypes or external entities. This reader handles
 * what they do use — elements, attributes, text, CDATA, and the five predefined entities —
 * and **refuses everything else**.
 *
 * That is decision D31, and the refusal is the point rather than a limitation to apologise
 * for. XML's dangerous features are features, and a reader that cannot express them cannot be
 * attacked through them:
 *
 * - **No `DOCTYPE`, no DTD.** Refused outright. The billion-laughs entity expansion is not
 *   mitigated here, it is unimplementable — there is no entity table to poison.
 * - **No external entities.** XXE is the reason "just use an XML parser" is bad advice for
 *   untrusted input. A reader with no entity resolution cannot be made to open a file or a
 *   socket, whatever the document says.
 * - **Bounded depth and node count.** A document nested ten thousand deep cannot exhaust the
 *   stack, because the reader is iterative and refuses past a depth no real export reaches.
 *
 * The precedent is `zip-reader.ts`, which exists for the same reason: `.1pux` needed a ZIP
 * reader, and a small hardened one beat a dependency in the path of an untrusted file. This
 * is the same trade made the same way.
 *
 * **It must never grow into a general parser.** A schema that needs namespaces is a schema
 * Keyhold does not read.
 */

/**
 * Every refusal in this file, worded for a file the user picked rather than for a vault.
 *
 * Not `crypto/errors.ts`'s `malformed`, whose message begins "This vault file is damaged" —
 * true of a `.keep` and alarming nonsense about an export somebody just exported. The code is
 * the same, because a caller's handling should not differ; only the sentence does.
 */
function badXml(detail: string): VaultError {
  return new VaultError('MALFORMED', `This XML could not be read: ${detail}.`);
}

/** Deeper than any real export, shallow enough that a hostile file cannot cost anything. */
export const MAX_XML_DEPTH = 100;

/**
 * A KeePass database of 50,000 entries is roughly 500,000 nodes; this is comfortably past
 * that and still bounded. The cap exists so a malformed or hostile file fails fast instead of
 * allocating until the process dies.
 */
export const MAX_XML_NODES = 2_000_000;

/** Longer than any credential field, and short enough that one value cannot be the whole file. */
export const MAX_XML_TEXT = 1_000_000;

export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /** The element's own text, with CDATA and entities resolved. Empty when it has none. */
  readonly text: string;
}

/** The five XML predefines. Nothing else resolves, by design — see the header. */
const ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/**
 * Resolves the entity references a document is allowed to contain.
 *
 * A named reference outside the five predefines is an **error**, not a passthrough. Leaving
 * `&custom;` in the text would be quietly wrong in a file that declared it, and declaring one
 * requires a DTD, which is refused above — so anything else here means the document is not
 * one this reader claims to handle, and saying so is better than guessing.
 */
function resolveEntities(raw: string, where: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      // Bounded to real Unicode, and surrogates refused: `String.fromCodePoint` throws on
      // both, and a thrown RangeError from deep inside a parse is a worse error message than
      // this one.
      if (!Number.isInteger(code) || code < 0 || code > 0x10_ffff) {
        throw badXml(`${where} contains a character reference outside Unicode`);
      }
      if (code >= 0xd800 && code <= 0xdfff) {
        throw badXml(`${where} contains a lone surrogate character reference`);
      }
      return String.fromCodePoint(code);
    }

    const named = ENTITIES[body];
    if (named === undefined) {
      throw badXml(
        `${where} uses the entity "${whole}", and this reader resolves only the five XML predefines`
      );
    }
    return named;
  });
}

interface Frame {
  readonly name: string;
  readonly attributes: Record<string, string>;
  readonly children: XmlElement[];
  text: string;
}

/**
 * Parses a document into its root element.
 *
 * Iterative rather than recursive: recursion depth would be attacker-controlled, and the
 * stack overflow it produces is not a catchable error in every runtime. The explicit stack
 * below is bounded by `MAX_XML_DEPTH` and fails with a message instead.
 */
export function parseXml(raw: string): XmlElement {
  if (/<!DOCTYPE/i.test(raw)) {
    // Refused before anything else is read. This is the single most important line in the
    // file: no DTD means no entity declarations, which means no expansion attack and no
    // external reference, and it is enforced by not implementing them at all.
    throw badXml('the XML declares a DOCTYPE, which this reader refuses');
  }

  // XML 1.0 §2.11: a conforming processor normalises `\r\n` and a lone `\r` to `\n` before
  // anything else sees them. That is not a nicety here — a KeePass export written on Windows
  // carries CRLF inside every multi-line note, and without this the same file would import
  // with different note text depending on the machine it was exported from.
  const source = raw.includes('\r') ? raw.replace(/\r\n?/g, '\n') : raw;

  const stack: Frame[] = [];
  let root: XmlElement | null = null;
  let nodes = 0;
  let index = 0;

  const text = (chunk: string): void => {
    if (chunk === '') return;
    const frame = stack[stack.length - 1];
    if (frame === undefined) return; // Whitespace outside the root. Ignored, as XML allows.
    if (frame.text.length + chunk.length > MAX_XML_TEXT) {
      throw badXml(`the XML has a value longer than ${String(MAX_XML_TEXT)} characters`);
    }
    frame.text += chunk;
  };

  while (index < source.length) {
    const open = source.indexOf('<', index);
    if (open === -1) {
      text(resolveEntities(source.slice(index), 'the XML'));
      break;
    }

    text(resolveEntities(source.slice(index, open), 'the XML'));

    // ── The things that are not elements ──────────────────────────────────
    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open);
      if (end === -1) throw badXml('the XML has an unterminated CDATA section');
      // CDATA is literal by definition: entities are *not* resolved inside it, which is the
      // whole reason a document uses one.
      text(source.slice(open + 9, end));
      index = end + 3;
      continue;
    }
    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open);
      if (end === -1) throw badXml('the XML has an unterminated comment');
      index = end + 3;
      continue;
    }
    if (source.startsWith('<?', open)) {
      const end = source.indexOf('?>', open);
      if (end === -1) throw badXml('the XML has an unterminated declaration');
      index = end + 2;
      continue;
    }

    const close = source.indexOf('>', open);
    if (close === -1) throw badXml('the XML has an unterminated tag');
    const inner = source.slice(open + 1, close);

    // ── A closing tag ─────────────────────────────────────────────────────
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      const frame = stack.pop();
      if (frame?.name !== name) {
        throw badXml(`the XML closes <${name}> where it did not open one`);
      }
      const element: XmlElement = {
        name: frame.name,
        attributes: frame.attributes,
        children: frame.children,
        text: frame.text,
      };
      const parent = stack[stack.length - 1];
      if (parent === undefined) root = element;
      else parent.children.push(element);
      index = close + 1;
      continue;
    }

    // ── An opening or self-closing tag ────────────────────────────────────
    nodes += 1;
    if (nodes > MAX_XML_NODES) {
      throw badXml(`the XML has more than ${String(MAX_XML_NODES)} elements`);
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameEnd = body.search(/[\s/]/);
    const name = (nameEnd === -1 ? body : body.slice(0, nameEnd)).trim();
    if (name === '') throw badXml('the XML has a tag with no name');

    const attributes: Record<string, string> = {};
    const attrSource = nameEnd === -1 ? '' : body.slice(nameEnd);
    for (const match of attrSource.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const key = match[1];
      const value = match[3] ?? match[4] ?? '';
      if (key !== undefined) attributes[key] = resolveEntities(value, `attribute "${key}"`);
    }

    if (selfClosing) {
      const element: XmlElement = { name, attributes, children: [], text: '' };
      const parent = stack[stack.length - 1];
      if (parent === undefined) root = element;
      else parent.children.push(element);
    } else {
      if (stack.length >= MAX_XML_DEPTH) {
        throw badXml(`the XML nests deeper than ${String(MAX_XML_DEPTH)} elements`);
      }
      stack.push({ name, attributes, children: [], text: '' });
    }
    index = close + 1;
  }

  if (stack.length > 0) {
    throw badXml(`the XML never closes <${stack[stack.length - 1]?.name ?? '?'}>`);
  }
  if (root === null) throw badXml('the XML has no root element');
  return root;
}

// ── Reading a parsed document ────────────────────────────────────────────────
//
// Small helpers rather than a query language. A schema this reader handles is shallow and
// known, so `child(node, 'Group')` says what it means and cannot be given a path that walks
// somewhere unexpected.

/** The first child with this name, or `null`. */
export function child(node: XmlElement, name: string): XmlElement | null {
  return node.children.find((candidate) => candidate.name === name) ?? null;
}

/** Every child with this name, in document order. */
export function children(node: XmlElement, name: string): readonly XmlElement[] {
  return node.children.filter((candidate) => candidate.name === name);
}

/** The text of the first child with this name, or `''` — never `undefined`, so callers do not branch. */
export function childText(node: XmlElement, name: string): string {
  return child(node, name)?.text ?? '';
}
