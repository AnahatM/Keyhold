// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VaultError } from '../crypto/errors.js';
import { MAX_XML_DEPTH, MAX_XML_TEXT, child, childText, children, parseXml } from './xml-reader.js';

/**
 * The XML reader, and mostly what it refuses.
 *
 * This parses a file somebody else wrote, so the interesting tests are the ones about hostile
 * input rather than the ones about valid documents. The refusals below are not defensive
 * tidiness — each corresponds to a named attack that has repeatedly worked against real XML
 * parsers, and the reason this reader is small is that it cannot express any of them.
 */

describe('reading a document', () => {
  it('reads elements, attributes and text', () => {
    const root = parseXml('<Root a="1"><Child>hello</Child></Root>');

    expect(root.name).toBe('Root');
    expect(root.attributes.a).toBe('1');
    expect(childText(root, 'Child')).toBe('hello');
  });

  it('keeps siblings in document order', () => {
    // KeePass groups nest and repeat, so order is not cosmetic — it is the folder tree.
    const root = parseXml('<G><E>1</E><E>2</E><E>3</E></G>');
    expect(children(root, 'E').map((node) => node.text)).toEqual(['1', '2', '3']);
  });

  it('handles a self-closing element', () => {
    const root = parseXml('<Root><Empty /><After>x</After></Root>');
    expect(child(root, 'Empty')?.children).toEqual([]);
    expect(childText(root, 'After')).toBe('x');
  });

  it('resolves the five predefined entities', () => {
    const root = parseXml('<V>&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;</V>');
    expect(root.text).toBe(`<a> & "b" 'c'`);
  });

  it('resolves numeric character references, decimal and hex', () => {
    expect(parseXml('<V>&#65;&#x42;</V>').text).toBe('AB');
  });

  it('takes CDATA literally, which is the whole reason a document uses it', () => {
    // A password containing `<` is exactly why KeePass writes CDATA, and resolving entities
    // inside one would corrupt the value it exists to protect.
    const root = parseXml('<V><![CDATA[a<b & c &amp; d]]></V>');
    expect(root.text).toBe('a<b & c &amp; d');
  });

  it('normalises CRLF and a lone CR to LF, as XML 1.0 §2.11 requires', () => {
    // Not pedantry about the spec. A KeePass database exported on Windows carries CRLF inside
    // every multi-line note, and without this the same file would import with different note
    // text depending on which machine it was exported from — a difference that survives into
    // the vault and shows up as a diff nobody can explain.
    //
    // Injected by deleting the normalisation: the parser contract's BOM/CRLF case passed
    // anyway, because the KeePass fixture had no multi-line value in it at the time. The
    // fixture gained one and this case was written; both now fail without the line.
    expect(parseXml('<n>one\r\ntwo\rthree</n>').text).toBe('one\ntwo\nthree');
  });

  it('skips comments and the XML declaration', () => {
    const root = parseXml('<?xml version="1.0"?><!-- note --><Root>x</Root>');
    expect(root.text).toBe('x');
  });

  it('reads an attribute in single quotes', () => {
    expect(parseXml("<Root a='1' />").attributes.a).toBe('1');
  });
});

describe('what it refuses, and why each one matters', () => {
  it('refuses a bare DOCTYPE, on its own account', () => {
    // Deliberately a document that would otherwise parse perfectly: no entity reference, no
    // malformed anything. It is refused *only* because of the DOCTYPE check, which is what
    // makes this the test that proves that line exists.
    //
    // Asserted on the **message**, not just the type, and that is not fussiness. Fault
    // injection twice showed a throw arriving from somewhere else: with the DOCTYPE check
    // deleted, `<!DOCTYPE r>` is read as a tag named `!DOCTYPE` that never closes, so the
    // parse still fails and a `toThrow(VaultError)` still passes. Naming the reason is the
    // only way to pin which guard fired — and the message is part of the contract anyway,
    // since the user reads it.
    // The *refusal's* wording, not just the word DOCTYPE: with the check deleted, the
    // fallback message is "never closes <!DOCTYPE>", which contains the word and matched a
    // looser pattern. Three attempts to write this test, each caught by injecting the bug it
    // is supposed to catch — which is the whole argument for injecting before trusting.
    expect(() => parseXml('<!DOCTYPE r><r>ok</r>')).toThrow(/declares a DOCTYPE/);
  });

  it('refuses the billion laughs, at two independent points', () => {
    // Caught by the DOCTYPE refusal, and caught again by the unknown-entity rule if that ever
    // went away. Two guards for one attack is not redundancy here — the second one is what
    // holds if somebody ever decides a DOCTYPE should be skipped rather than refused.
    const bomb =
      '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><lolz>&lol2;</lolz>';
    expect(() => parseXml(bomb)).toThrow(/declares a DOCTYPE/);
    expect(() => parseXml('<lolz>&lol2;</lolz>')).toThrow(/predefines/);
  });

  it('refuses an external entity, which is what XXE is', () => {
    // The reason "just use an XML parser" is bad advice for untrusted input: a parser that
    // resolves this opens a file, or a socket, on the attacker's say-so.
    const xxe = '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>';
    expect(() => parseXml(xxe)).toThrow(/declares a DOCTYPE/);
  });

  it('refuses an entity it does not know, rather than passing it through', () => {
    // Passing `&custom;` through would be quietly wrong in a file that declared it, and
    // declaring one needs a DTD, which is already refused — so this can only be a document
    // the reader does not handle, and saying so beats guessing.
    expect(() => parseXml('<r>&custom;</r>')).toThrow(VaultError);
  });

  it('refuses a character reference outside Unicode', () => {
    expect(() => parseXml('<r>&#x110000;</r>')).toThrow(VaultError);
  });

  it('refuses a lone surrogate', () => {
    // `String.fromCodePoint` throws on one anyway; catching it here means a readable message
    // instead of a RangeError from inside a parse.
    expect(() => parseXml('<r>&#xD800;</r>')).toThrow(VaultError);
  });

  it('refuses nesting past the depth cap without exhausting the stack', () => {
    // The reason the reader is iterative. A recursive one would blow the stack here, and a
    // stack overflow is not a catchable error in every runtime — so the failure mode would be
    // the process dying rather than an import being refused.
    const deep = '<a>'.repeat(MAX_XML_DEPTH + 50) + '</a>'.repeat(MAX_XML_DEPTH + 50);
    expect(() => parseXml(deep)).toThrow(VaultError);
  });

  it('refuses a single value longer than the text cap', () => {
    expect(() => parseXml(`<r>${'x'.repeat(MAX_XML_TEXT + 1)}</r>`)).toThrow(VaultError);
  });

  it.each([
    ['an unterminated tag', '<Root'],
    ['an unterminated CDATA section', '<r><![CDATA[oops</r>'],
    ['an unterminated comment', '<r><!-- oops</r>'],
    ['a mismatched closing tag', '<a></b>'],
    ['a closing tag with nothing open', '</a>'],
    ['an unclosed element', '<a><b></b>'],
    ['no root element at all', 'just text'],
    ['a nameless tag', '< >'],
  ])('refuses %s', (_label, source) => {
    expect(() => parseXml(source)).toThrow(VaultError);
  });

  it('never quotes a value back in a refusal', () => {
    // These messages reach a banner and a bug report. A file that fails to parse is still a
    // file full of passwords, and the one thing an error about it must not do is repeat one.
    const secret = 'a-very-distinctive-password-value';
    const error = (() => {
      try {
        parseXml(`<r><Password>${secret}</Password>`);
        return null;
      } catch (thrown: unknown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(VaultError);
    expect(String(error)).not.toContain(secret);
  });
});
