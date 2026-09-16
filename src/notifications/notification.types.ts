export type NotifKind =
  | 'KNOWLEDGE_GAP'
  | 'CREDENTIAL_REVEAL'
  | 'AGREEMENT_SIGNED'
  | 'RATE_LIMIT'
  | 'SYSTEM';

export interface NotificationRequest {
  kind: NotifKind;
  title: string;
  body: string;
  /** Where in the app this notification points, e.g. `/dashboard#gap-abc`. */
  linkPath?: string;
  /**
   * Whether this is worth interrupting the Client for.
   *
   * It does NOT mean "important" — it means "something has stopped and is
   * waiting for you". A paused application in ASK_FIRST mode is urgent; the
   * same question answered by a best guess in GUESS_AND_PROCEED is not, even
   * though both concern the same application. Channels use it to decide
   * whether to fire at all, which is the entire defence against the Client
   * muting notifications because the app cried wolf.
   */
  urgent: boolean;
}

export interface NotificationView {
  id: string;
  kind: NotifKind;
  title: string;
  body: string;
  linkPath: string | null;
  readAt: Date | null;
  createdAt: Date;
}
