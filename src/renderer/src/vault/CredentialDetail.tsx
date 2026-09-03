// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import type { CredentialProjection } from '@shared/model/credential.js';
import { Badge, EmptyState } from '../components/Feedback.js';
import { Button } from '../components/Button.js';
import { AttachmentsPanel } from './AttachmentsPanel.js';
import { useCredentials } from './credential-store.js';
import { useSession } from './session-store.js';
import { CompareVersions } from '../history/CompareVersions.js';
import { HistoryTimeline } from '../history/HistoryTimeline.js';
import { PlainField, SecretField } from './SecretField.js';

/**
 * The detail pane for one record.
 *
 * Everything here renders from the safe projection. Secrets appear only through
 * `SecretField`, which fetches one value at a time on an explicit click — see decision
 * D13 and `SecretField`'s own notes.
 */
export function CredentialDetail({
  credential,
}: {
  readonly credential: CredentialProjection;
}): React.JSX.Element {
  const { setEditing, duplicate, trash, restore, purge, busy } = useCredentials();
  const [confirmingPurge, setConfirmingPurge] = useState(false);

  const trashed = credential.trashedAt !== null;

  return (
    <article className="kh-detail">
      <header className="kh-detail__header">
        <span className="kh-detail__mark" aria-hidden="true">
          {credential.icon.kind === 'emoji' && credential.icon.value !== undefined
            ? credential.icon.value
            : (credential.title.trim()[0] ?? '?').toUpperCase()}
        </span>
        <div className="kh-detail__heading">
          <h2 className="kh-detail__title">
            {credential.title === '' ? 'Untitled' : credential.title}
          </h2>
          <div className="kh-detail__badges">
            {credential.favorite && (
              <Badge tone="warning" symbol="★">
                Favourite
              </Badge>
            )}
            {trashed && (
              <Badge tone="danger" symbol="🗑">
                In Trash
              </Badge>
            )}
            {credential.tags.map((tag) => (
              // Tags stay neutral rather than colourful on purpose: the status colours in
              // this app carry the health dashboard's meaning, and decorative colour
              // competing with them would make real warnings stop reading as warnings.
              <Badge key={tag} tone="neutral">
                {tag}
              </Badge>
            ))}
          </div>
        </div>
      </header>

      <div className="kh-detail__actions">
        {trashed ? (
          <>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                void restore(credential.id);
              }}
            >
              Restore
            </Button>
            {confirmingPurge ? (
              <>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    void purge(credential.id);
                  }}
                >
                  Delete permanently
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setConfirmingPurge(false);
                  }}
                >
                  Cancel
                </Button>
                <span className="kh-detail__warning">
                  This cannot be undone. The record and its attachments are gone.
                </span>
              </>
            ) : (
              // The only action in the app with no undo, so the confirmation is up front
              // rather than the regret afterwards.
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setConfirmingPurge(true);
                }}
              >
                Delete permanently…
              </Button>
            )}
          </>
        ) : (
          <>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                setEditing(true);
              }}
            >
              Edit
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                void duplicate(credential.id);
              }}
            >
              Duplicate
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void trash(credential.id, credential.title);
              }}
            >
              Move to Trash
            </Button>
          </>
        )}
      </div>

      <section className="kh-detail__section">
        <PlainField label="Username" value={credential.username} copyable />
        <PlainField label="Email" value={credential.email} copyable />

        <SecretField
          key={`${credential.id}:password`}
          label="Password"
          credentialId={credential.id}
          secretRef={{ kind: 'password', credentialId: credential.id }}
          hasValue={credential.hasPassword}
          length={credential.passwordLength}
        />

        {credential.urls.map((url, index) => (
          <PlainField key={url} label={index === 0 ? 'URL' : `URL ${index + 1}`} value={url} />
        ))}
      </section>

      {credential.securityQuestions.length > 0 && (
        <section className="kh-detail__section">
          <h3 className="kh-detail__heading">Security questions</h3>
          {credential.securityQuestions.map((question) => (
            <SecretField
              key={`${credential.id}:q:${question.id}`}
              // The question is the label because it is a prompt, not a secret — "your
              // first pet's name" reveals nothing. The answer is treated as a password.
              label={question.question}
              credentialId={credential.id}
              secretRef={{
                kind: 'security-answer',
                credentialId: credential.id,
                questionId: question.id,
              }}
              hasValue={question.hasAnswer}
              length={12}
            />
          ))}
        </section>
      )}

      {credential.custom.length > 0 && (
        <section className="kh-detail__section">
          <h3 className="kh-detail__heading">Custom fields</h3>
          {credential.custom.map((field) =>
            field.isSecret ? (
              <SecretField
                key={`${credential.id}:f:${field.id}`}
                label={field.label}
                credentialId={credential.id}
                secretRef={{
                  kind: 'custom-value',
                  credentialId: credential.id,
                  fieldId: field.id,
                }}
                hasValue={field.hasValue}
                length={12}
              />
            ) : (
              // A non-secret custom field arrived with its value in the projection, so it
              // renders without a round trip — which is the whole reason the boundary
              // distinguishes secret types from ordinary ones.
              <PlainField key={field.id} label={field.label} value={field.value ?? ''} copyable />
            )
          )}
        </section>
      )}

      {credential.hasNotes && (
        <section className="kh-detail__section">
          <h3 className="kh-detail__heading">Notes</h3>
          <SecretField
            key={`${credential.id}:notes`}
            label="Notes"
            credentialId={credential.id}
            secretRef={{ kind: 'notes', credentialId: credential.id }}
            hasValue={credential.hasNotes}
            length={Math.min(credential.notesLength, 40)}
            multiline
          />
          <p className="kh-detail__hint">
            Notes are treated as secret. People keep recovery codes and backup phrases in them, so
            they are never sent to the interface until you ask for them.
          </p>
        </section>
      )}

      <section className="kh-detail__section">
        <h3 className="kh-detail__heading">Details</h3>
        <dl className="kh-detail__meta">
          <div>
            <dt>Created</dt>
            <dd>{new Date(credential.meta.createdAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{new Date(credential.meta.updatedAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt>Password changed</dt>
            <dd>{new Date(credential.meta.passwordUpdatedAt).toLocaleDateString()}</dd>
          </div>
          <div>
            <dt>Used</dt>
            <dd>{credential.meta.useCount} times</dd>
          </div>
          <div>
            <dt>History</dt>
            <dd>
              {credential.historyEnabled
                ? `${credential.historyCount} version${credential.historyCount === 1 ? '' : 's'}`
                : 'Not kept'}
            </dd>
          </div>
        </dl>
      </section>

      <AttachmentsPanel
        credentialId={credential.id}
        attachments={credential.attachments}
        readOnly={trashed}
        onChanged={() => {
          // The projection is stale the moment a chunk lands or leaves — the count, the
          // sizes and the list all come from it. Refreshing the session rather than patching
          // the record locally keeps one source of truth for what the vault holds.
          void useSession.getState().refresh();
        }}
      />

      <section className="kh-detail__section">
        <div className="kh-detail__section-head">
          <h3 className="kh-detail__heading">History</h3>
          {credential.historyCount > 0 && (
            <ClearHistoryButton credentialId={credential.id} count={credential.historyCount} />
          )}
        </div>
        {/*
          Above the timeline and collapsed, so the answer people open history for stays where
          they expect it. `kh:history:compare` had been implemented end to end since it was
          written with nothing in the renderer calling it; this is the question that asks it.
        */}
        <CompareVersions credential={credential} />
        <HistoryTimeline credential={credential} />
      </section>
    </article>
  );
}

/**
 * Clearing a record's history.
 *
 * The one action in the timeline that genuinely loses data, so it is the one that asks
 * twice and says what it costs. It exists because an audit trail is the only feature here
 * that can hold something a user wants gone — an old password they now consider burned, a
 * device name from a job they have left. A password manager that cannot forget is not one
 * people hand their whole life to.
 */
function ClearHistoryButton({
  credentialId,
  count,
}: {
  readonly credentialId: string;
  readonly count: number;
}): React.JSX.Element {
  const { clearHistory, busy } = useCredentials();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setConfirming(true);
        }}
      >
        Clear history
      </Button>
    );
  }

  return (
    <span className="kh-detail__confirm">
      <span className="kh-detail__confirm-text">
        Delete {count} recorded version{count === 1 ? '' : 's'}? This cannot be undone.
      </span>
      <Button
        variant="danger"
        size="sm"
        disabled={busy}
        onClick={() => {
          void clearHistory(credentialId).finally(() => {
            setConfirming(false);
          });
        }}
      >
        Delete history
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setConfirming(false);
        }}
      >
        Keep it
      </Button>
    </span>
  );
}

export function NoSelection(): React.JSX.Element {
  const { setEditing, select } = useCredentials();

  return (
    <EmptyState
      icon="🗝"
      title="Nothing selected"
      description="Pick a credential from the list, or add a new one."
      action={
        <Button
          variant="primary"
          onClick={() => {
            select(null);
            setEditing(true);
          }}
        >
          New credential
        </Button>
      }
    />
  );
}
