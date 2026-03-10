import { type Message, type UserFromGetMe } from "@grammyjs/types";
import { isAbortRequestText } from "../auto-reply/reply/abort.js";
import { resolveTelegramForumThreadId } from "./bot/helpers.js";

export type TelegramSequentialKeyContext = {
  chat?: { id?: number };
  me?: UserFromGetMe;
  message?: Message;
  channelPost?: Message;
  editedChannelPost?: Message;
  update?: {
    message?: Message;
    edited_message?: Message;
    channel_post?: Message;
    edited_channel_post?: Message;
    callback_query?: { message?: Message };
    message_reaction?: { chat?: { id?: number } };
  };
};

function isApprovalRequestText(rawText: string | undefined, botUsername?: string): boolean {
  if (typeof rawText !== "string") {
    return false;
  }
  const trimmed = rawText.trim();
  if (!trimmed.startsWith("/")) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  if (lower === "/approve") {
    return true;
  }
  if (lower.startsWith("/approve ")) {
    return true;
  }
  if (!botUsername) {
    return false;
  }
  const lowerBotUsername = botUsername.trim().toLowerCase();
  if (!lowerBotUsername) {
    return false;
  }
  return (
    lower.startsWith(`/approve@${lowerBotUsername}`) &&
    (lower.length === `/approve@${lowerBotUsername}`.length ||
      /\s/.test(lower.charAt(`/approve@${lowerBotUsername}`.length)))
  );
}

export function getTelegramSequentialKey(ctx: TelegramSequentialKeyContext): string {
  const reaction = ctx.update?.message_reaction;
  if (reaction?.chat?.id) {
    return `telegram:${reaction.chat.id}`;
  }
  const msg =
    ctx.message ??
    ctx.channelPost ??
    ctx.editedChannelPost ??
    ctx.update?.message ??
    ctx.update?.edited_message ??
    ctx.update?.channel_post ??
    ctx.update?.edited_channel_post ??
    ctx.update?.callback_query?.message;
  const chatId = msg?.chat?.id ?? ctx.chat?.id;
  const rawText = msg?.text ?? msg?.caption;
  const botUsername = ctx.me?.username;
  if (
    isAbortRequestText(rawText, botUsername ? { botUsername } : undefined) ||
    isApprovalRequestText(rawText, botUsername)
  ) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:control`;
    }
    return "telegram:control";
  }
  const isGroup = msg?.chat?.type === "group" || msg?.chat?.type === "supergroup";
  const messageThreadId = msg?.message_thread_id;
  const isForum = msg?.chat?.is_forum;
  const threadId = isGroup
    ? resolveTelegramForumThreadId({ isForum, messageThreadId })
    : messageThreadId;
  if (typeof chatId === "number") {
    return threadId != null ? `telegram:${chatId}:topic:${threadId}` : `telegram:${chatId}`;
  }
  return "telegram:unknown";
}
