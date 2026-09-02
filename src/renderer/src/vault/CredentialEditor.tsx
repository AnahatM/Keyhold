// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import type { CustomFieldInput } from '@shared/ipc/api.js';
import {
  CUSTOM_FIELD_TYPES,
  SECRET_CUSTOM_FIELD_TYPES,
  type CredentialProjection,
  type CustomFieldType,
} from '@shared/model/credential.js';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { useCredentials } from './credential-store.js';

/**
 * The create / edit form.
 *
 * ## The awkward part, and why it works this way
 *
 * The detail view never receives secrets — that is the whole architecture. But an *edit*
 * form has to show the current value, or "edit" means "retype from memory".
 *
 * So on opening for edit, this component fetches each secret **once**, explicitly, through
 * the same one-at-a-time reveal path the detail view uses. Nothing is bulk-loaded and
 * nothing is cached beyond this component's lifetime: closing the form drops every value.
 *
 * That is a real widening of the boundary and it is stated rather than hidden. It is also
 * bounded — the values are in memory for exactly as long as a form is open, on a screen
 * the user deliberately opened, rather than for the whole session as they would be in a
 * conventional design.
 */

interface QuestionDraft {
  id: string;
  question: string;
  answer: string;
}

/** Ids for new rows. Not security-relevant — these are labels, not keys — but they must be unique. */
let draftCounter = 0;
const draftId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${++draftCounter}`;

export function CredentialEditor({
  credential,
}: {
  /** `null` when creating. */
  readonly credential: CredentialProjection | null;
}): React.JSX.Element {
  const { create, update, setEditing, select, reveal, busy } = useCredentials();

  const [title, setTitle] = useState(credential?.title ?? '');
  const [username, setUsername] = useState(credential?.username ?? '');
  const [email, setEmail] = useState(credential?.email ?? '');
  const [password, setPassword] = useState('');
  const [notes, setNotes] = useState('');
  const [urls, setUrls] = useState<string[]>(credential?.urls.length ? [...credential.urls] : ['']);
  const [tags, setTags] = useState(credential?.tags.join(', ') ?? '');
  const [favorite, setFavorite] = useState(credential?.favorite ?? false);
  const [historyEnabled, setHistoryEnabled] = useState(credential?.historyEnabled ?? true);
  const [questions, setQuestions] = useState<QuestionDraft[]>([]);
  const [custom, setCustom] = useState<CustomFieldInput[]>([]);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(credential === null);
  const [dirty, setDirty] = useState(false);

  /*
   * Fetch the existing secrets, once, on open.
   *
   * Sequential rather than parallel: the broker rate-limits reveals to catch a loop
   * harvesting the vault, and firing twenty at once from a record with many custom fields
   * would look exactly like that loop.
   */
  // A ref rather than a local `let`: TypeScript narrows a local assigned `false` to
  // literally `false` and then reports every check of it as dead code, because its control
  // flow analysis cannot see the mutation inside the cleanup closure.
  const active = useRef(true);

  useEffect(() => {
    if (credential === null) return;
    active.current = true;

    void (async () => {
      try {
        const nextPassword = credential.hasPassword
          ? ((await reveal({ kind: 'password', credentialId: credential.id })) ?? '')
          : '';
        const nextNotes = credential.hasNotes
          ? ((await reveal({ kind: 'notes', credentialId: credential.id })) ?? '')
          : '';

        const nextQuestions: QuestionDraft[] = [];
        for (const question of credential.securityQuestions) {
          const answer = question.hasAnswer
            ? ((await reveal({
                kind: 'security-answer',
                credentialId: credential.id,
                questionId: question.id,
              })) ?? '')
            : '';
          nextQuestions.push({ id: question.id, question: question.question, answer });
        }

        const nextCustom: CustomFieldInput[] = [];
        for (const field of credential.custom) {
          const value = field.isSecret
            ? field.hasValue
              ? ((await reveal({
                  kind: 'custom-value',
                  credentialId: credential.id,
                  fieldId: field.id,
                })) ?? '')
              : ''
            : (field.value ?? '');
          nextCustom.push({
            id: field.id,
            label: field.label,
            type: field.type,
            value,
            hidden: field.hidden,
            order: field.order,
          });
        }

        if (!active.current) return;
        setPassword(nextPassword);
        setNotes(nextNotes);
        setQuestions(nextQuestions);
        setCustom(nextCustom);
        setLoaded(true);
      } catch (error) {
        if (!active.current) return;
        setRevealError(
          error instanceof Error ? error.message : 'Could not load this record for editing.'
        );
        setLoaded(true);
      }
    })();

    return () => {
      active.current = false;
    };
  }, [credential, reveal]);

  const touch = (): void => {
    setDirty(true);
  };

  /*
   * Warn before the window closes with unsaved work.
   *
   * `beforeunload` is the only hook that catches a window close, and the browser ignores
   * any custom message — so this is a generic prompt by necessity, not by choice.
   */
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [dirty]);

  const cancel = (): void => {
    if (dirty && !window.confirm('Discard your changes to this credential?')) return;
    setEditing(false);
    if (credential === null) select(null);
  };

  const submit = (): void => {
    const payload = {
      title: title.trim(),
      username,
      email,
      password,
      notes,
      urls: urls.map((url) => url.trim()).filter((url) => url !== ''),
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag !== ''),
      favorite,
      securityQuestions: questions.filter((question) => question.question.trim() !== ''),
      custom: custom.filter((field) => field.label.trim() !== ''),
    };

    if (credential === null) {
      void create(payload).then(() => {
        setDirty(false);
      });
    } else {
      void update(credential.id, { ...payload, historyEnabled }).then(() => {
        setDirty(false);
      });
    }
  };

  if (!loaded) {
    return (
      <div className="kh-detail">
        <p className="kh-detail__hint" aria-live="polite">
          Loading this record…
        </p>
      </div>
    );
  }

  return (
    <form
      className="kh-detail"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <header className="kh-detail__header">
        <div className="kh-detail__heading">
          <h2 className="kh-detail__title">
            {credential === null ? 'New credential' : `Editing ${credential.title}`}
          </h2>
        </div>
      </header>

      {revealError !== null && (
        <p className="kh-screen__error" role="alert">
          {revealError}
        </p>
      )}

      <section className="kh-detail__section kh-editor">
        <Input
          label="Title"
          value={title}
          autoFocus
          required
          onChange={(event) => {
            setTitle(event.target.value);
            touch();
          }}
          hint="What you will search for. A site name usually works best."
        />
        <Input
          label="Username"
          value={username}
          autoComplete="off"
          onChange={(event) => {
            setUsername(event.target.value);
            touch();
          }}
        />
        <Input
          label="Email"
          type="email"
          value={email}
          autoComplete="off"
          onChange={(event) => {
            setEmail(event.target.value);
            touch();
          }}
        />
        <Input
          label="Password"
          type="text"
          value={password}
          secret
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setPassword(event.target.value);
            touch();
          }}
          hint="Shown rather than masked while editing — you cannot check a value you cannot see."
        />
      </section>

      <section className="kh-detail__section kh-editor">
        <h3 className="kh-detail__heading">URLs</h3>
        {urls.map((url, index) => (
          <div key={index} className="kh-editor__row">
            <Input
              label={index === 0 ? 'URL' : `URL ${index + 1}`}
              labelHidden={index > 0}
              value={url}
              placeholder="https://example.com"
              onChange={(event) => {
                const next = [...urls];
                next[index] = event.target.value;
                setUrls(next);
                touch();
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnlyLabel={`Remove URL ${index + 1}`}
              onClick={() => {
                setUrls(urls.filter((_, i) => i !== index));
                touch();
              }}
            >
              ✕
            </Button>
          </div>
        ))}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setUrls([...urls, '']);
          }}
        >
          Add URL
        </Button>
      </section>

      <section className="kh-detail__section kh-editor">
        <h3 className="kh-detail__heading">Security questions</h3>
        <p className="kh-detail__hint">
          First-class fields, not free text buried in a note — so each answer can be revealed,
          copied and versioned on its own. Answers are treated as passwords.
        </p>
        {questions.map((question, index) => (
          <div key={question.id} className="kh-editor__group">
            <Input
              label="Question"
              value={question.question}
              onChange={(event) => {
                const next = [...questions];
                next[index] = { ...question, question: event.target.value };
                setQuestions(next);
                touch();
              }}
            />
            <div className="kh-editor__row">
              <Input
                label="Answer"
                value={question.answer}
                secret
                autoComplete="off"
                onChange={(event) => {
                  const next = [...questions];
                  next[index] = { ...question, answer: event.target.value };
                  setQuestions(next);
                  touch();
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                iconOnlyLabel="Remove this question"
                onClick={() => {
                  setQuestions(questions.filter((_, i) => i !== index));
                  touch();
                }}
              >
                ✕
              </Button>
            </div>
          </div>
        ))}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setQuestions([...questions, { id: draftId('q'), question: '', answer: '' }]);
          }}
        >
          Add question
        </Button>
      </section>

      <section className="kh-detail__section kh-editor">
        <h3 className="kh-detail__heading">Custom fields</h3>
        <p className="kh-detail__hint">
          The type decides whether a value is treated as a secret. Password, PIN and one-time-code
          fields always are; anything else can be marked hidden to make it so.
        </p>
        {custom.map((field, index) => (
          <div key={field.id} className="kh-editor__group">
            <div className="kh-editor__row">
              <Input
                label="Label"
                value={field.label}
                onChange={(event) => {
                  const next = [...custom];
                  next[index] = { ...field, label: event.target.value };
                  setCustom(next);
                  touch();
                }}
              />
              <label className="kh-editor__type">
                <span className="kh-visually-hidden">Field type</span>
                <select
                  value={field.type}
                  onChange={(event) => {
                    const next = [...custom];
                    next[index] = { ...field, type: event.target.value as CustomFieldType };
                    setCustom(next);
                    touch();
                  }}
                >
                  {CUSTOM_FIELD_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant="ghost"
                size="sm"
                iconOnlyLabel={`Remove ${field.label || 'this field'}`}
                onClick={() => {
                  setCustom(custom.filter((_, i) => i !== index));
                  touch();
                }}
              >
                ✕
              </Button>
            </div>
            <Input
              label="Value"
              value={field.value}
              secret={SECRET_CUSTOM_FIELD_TYPES.includes(field.type) || field.hidden}
              autoComplete="off"
              onChange={(event) => {
                const next = [...custom];
                next[index] = { ...field, value: event.target.value };
                setCustom(next);
                touch();
              }}
            />
            <label className="kh-checkbox">
              <input
                type="checkbox"
                checked={field.hidden || SECRET_CUSTOM_FIELD_TYPES.includes(field.type)}
                disabled={SECRET_CUSTOM_FIELD_TYPES.includes(field.type)}
                onChange={(event) => {
                  const next = [...custom];
                  next[index] = { ...field, hidden: event.target.checked };
                  setCustom(next);
                  touch();
                }}
              />
              <span>
                Treat as sensitive
                <small>
                  {SECRET_CUSTOM_FIELD_TYPES.includes(field.type)
                    ? 'Always on for this field type.'
                    : 'Keeps the value out of the interface until you ask for it.'}
                </small>
              </span>
            </label>
          </div>
        ))}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setCustom([
              ...custom,
              {
                id: draftId('f'),
                label: '',
                type: 'text',
                value: '',
                hidden: false,
                order: custom.length,
              },
            ]);
          }}
        >
          Add field
        </Button>
      </section>

      <section className="kh-detail__section kh-editor">
        <h3 className="kh-detail__heading">Notes</h3>
        <label className="kh-field">
          <span className="kh-visually-hidden">Notes</span>
          <textarea
            className="kh-textarea"
            rows={6}
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value);
              touch();
            }}
            placeholder="Recovery codes, account details, anything else."
          />
        </label>
        <p className="kh-detail__hint">
          Notes are treated as secret, because people keep recovery codes and backup phrases in
          them.
        </p>
      </section>

      <section className="kh-detail__section kh-editor">
        <Input
          label="Tags"
          value={tags}
          placeholder="work, email, personal"
          onChange={(event) => {
            setTags(event.target.value);
            touch();
          }}
          hint="Comma-separated."
        />

        <label className="kh-checkbox">
          <input
            type="checkbox"
            checked={favorite}
            onChange={(event) => {
              setFavorite(event.target.checked);
              touch();
            }}
          />
          <span>Favourite</span>
        </label>

        {credential !== null && (
          <label className="kh-checkbox">
            <input
              type="checkbox"
              checked={historyEnabled}
              onChange={(event) => {
                setHistoryEnabled(event.target.checked);
                touch();
              }}
            />
            <span>
              Keep past versions of this credential
              <small>
                Records what changed, when, and from which device — per record, so you can keep
                history for the accounts that matter and not for the rest.
              </small>
            </span>
          </label>
        )}
      </section>

      <div className="kh-detail__actions">
        <Button
          variant="primary"
          type="submit"
          disabled={busy || title.trim() === ''}
          loading={busy}
        >
          {credential === null ? 'Create' : 'Save changes'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={cancel}>
          Cancel
        </Button>
        {dirty && <span className="kh-detail__hint">Unsaved changes</span>}
      </div>
    </form>
  );
}
