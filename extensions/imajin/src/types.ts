/**
 * Imajin channel plugin types.
 */

export type ResolvedImajinAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  nodeUrl?: string;
  did?: string;
  keypairPath?: string;
};

export type ImajinInboundMessage = {
  id: string;
  conversationDid: string;
  fromDid: string;
  content: { type: string; text: string } | string;
  contentType: string;
  replyToMessageId?: string | null;
  replyToDid?: string | null;
  createdAt: string;
  signature?: string | null;
};
