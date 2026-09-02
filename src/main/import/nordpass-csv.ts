// SPDX-License-Identifier: GPL-3.0-or-later
import { headerContains, readHeaderKeys } from './csv.js';
import { mapCsv, type CsvMappingSpec } from './csv-mapper.js';
import type { ImportParser, ImportResult } from './types.js';

/**
 * NordPass's CSV export.
 *
 * Header:
 * `name,url,username,password,note,cardholdername,cardnumber,cvc,expirydate,zipcode,folder,full_name,phone_number,email,address1,address2,city,country,state`
 *
 * **One file holds three different kinds of item.** A login fills the first columns; a credit
 * card fills the card ones; an identity fills the address ones. There is no type column to
 * branch on — the empty cells are the type — which is why this parser does not branch either.
 * Every populated column becomes a field, and an item that was a card in NordPass arrives as
 * a Keyhold record whose fields are the card's. Nothing is lost, and nothing is invented.
 *
 * The card columns get **secret types deliberately**. `cardnumber` becomes a `password` and
 * `cvc` a `pin`, so neither ever reaches the renderer (decision D13). The type guesser would
 * otherwise see a run of digits and call it a `number`, which would put a live card number in
 * the safe projection — a genuine leak reached by a plausible-looking default.
 */

const SPEC: CsvMappingSpec = {
  targets: {
    name: 'title',
    url: 'url',
    username: 'username',
    password: 'password',
    note: 'notes',
    folder: 'folder',
    email: 'email',
    // NordPass has added a `type` column in some builds; its vocabulary varies by version, so
    // it is accepted and ignored rather than branched on.
    type: 'ignore',
    cardholdername: 'custom',
    cardnumber: 'custom',
    cvc: 'custom',
    expirydate: 'custom',
    zipcode: 'custom',
    full_name: 'custom',
    phone_number: 'custom',
    address1: 'custom',
    address2: 'custom',
    city: 'custom',
    country: 'custom',
    state: 'custom',
  },
  customTypes: {
    cardnumber: 'password',
    cvc: 'pin',
    expirydate: 'date',
    phone_number: 'phone',
    address1: 'address',
    address2: 'address',
  },
  customLabels: {
    cardholdername: 'Cardholder name',
    cardnumber: 'Card number',
    cvc: 'CVC',
    expirydate: 'Expiry date',
    zipcode: 'Postcode',
    full_name: 'Full name',
    phone_number: 'Phone number',
    address1: 'Address',
    address2: 'Address line 2',
    city: 'City',
    country: 'Country',
    state: 'State',
  },
};

export const nordpassCsvParser: ImportParser = {
  id: 'nordpass-csv',
  name: 'NordPass (CSV)',
  extensions: ['.csv'],
  description: 'NordPass’s CSV export — logins, cards and identities in one file.',
  needsMapping: false,

  detect(content: string): boolean {
    const keys = readHeaderKeys(content);
    // `cardnumber` plus `folder` is what separates this from the Chromium export, whose first
    // five columns are identical.
    return headerContains(keys, ['name', 'url', 'username', 'password', 'cardnumber', 'folder']);
  },

  parse(content: string): ImportResult {
    return mapCsv(content, SPEC);
  },
};
