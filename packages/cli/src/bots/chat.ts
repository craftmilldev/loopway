/** Who a chat message is from. */
export type ChatSpeaker = "you" | "manager";

export interface ChatMessage {
  from: ChatSpeaker;
  text: string;
}

/** The chat's state: its transcript, oldest first. No ink here, so a web UI can reuse it. */
export interface Chat {
  messages: ChatMessage[];
}

/** What the manager says until an agent is behind it. */
export const NO_AGENT_REPLY = "No agent is connected yet.";

export const emptyChat = (): Chat => ({ messages: [] });

/**
 * Adds what you wrote and the manager's reply to the transcript. Text that is only whitespace is dropped,
 * and the chat comes back as it was.
 */
export function submitMessage(chat: Chat, text: string): Chat {
  const trimmed = text.trim();
  if (!trimmed) return chat;
  return {
    messages: [...chat.messages, { from: "you", text: trimmed }, { from: "manager", text: NO_AGENT_REPLY }],
  };
}
