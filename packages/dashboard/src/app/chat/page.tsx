"use client";

import { useState, useRef, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MessageSquare, Send, Loader2, Bot, User } from "lucide-react";
import { getMotionDelayClass } from "@/lib/motion-utils";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
}

interface ChatResponse {
  response: string;
  userMessageId: string;
  assistantMessageId: string;
  conversationId: string;
  history: ChatMessage[];
}

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.height = `${inputRef.current.scrollHeight}px`;
    }
  }, [input]);

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    setError(null);
    setInput("");

    // Optimistic UI: add user message immediately
    const tempUserMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: "user",
      content: trimmed,
    };
    setMessages((prev) => [...prev, tempUserMsg]);
    setIsLoading(true);

    try {
      const result = await apiFetch<ChatResponse>("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          message: trimmed,
          conversationId,
        }),
      });

      setConversationId(result.conversationId);

      // Replace temp message with actual + add assistant response
      setMessages((prev) => {
        const withoutTemp = prev.filter((m) => m.id !== tempUserMsg.id);
        return [
          ...withoutTemp,
          { id: result.userMessageId, role: "user" as const, content: trimmed },
          { id: result.assistantMessageId, role: "assistant" as const, content: result.response },
        ];
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
      // Remove optimistic message on error
      setMessages((prev) => prev.filter((m) => m.id !== tempUserMsg.id));
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="motion-page-enter flex h-[calc(100dvh-5rem)] min-h-[calc(100dvh-5rem)] flex-col">
      {/* Header */}
      <div className="motion-rise-in space-y-2 pb-2 sm:pb-3 md:pb-4">
        <p className="text-label-md uppercase tracking-wider text-on-surface-variant/50 dark:text-dark-on-surface-variant/50">
          Assistant
        </p>
        <h1 className="text-display-md font-bold text-on-surface dark:text-dark-on-surface">
          Chat
        </h1>
        <p className="text-on-surface-variant dark:text-dark-on-surface-variant">
          Ask your AI assistant about emails, deadlines, calendar, and more.
        </p>
      </div>

      {/* Messages Area */}
      <Card
        className={`motion-rise-in-soft flex flex-1 flex-col overflow-hidden ${getMotionDelayClass(1)}`}
      >
        <div className="flex-1 space-y-3 sm:space-y-4 overflow-y-auto p-3 sm:p-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-4">
              <div className="rounded-full bg-surface-low dark:bg-dark-surface-low p-4">
                <MessageSquare className="h-8 w-8 text-on-surface-variant/50 dark:text-dark-on-surface-variant/50" />
              </div>
              <div className="space-y-2">
                <p className="text-title-md font-medium text-on-surface dark:text-dark-on-surface">
                  Start a conversation
                </p>
                <p className="text-body-md text-on-surface-variant dark:text-dark-on-surface-variant max-w-md">
                  Ask about your inbox, upcoming deadlines, calendar events, or pending actions.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2 pt-2">
                {[
                  "What's urgent today?",
                  "Show my calendar for this week",
                  "Any pending actions?",
                  "Summarize my unread emails",
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => setInput(suggestion)}
                    className="motion-interactive rounded-full px-3 py-1.5 text-label-md text-on-surface-variant hover:bg-surface-high dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-high ghost-border transition-colors"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              {msg.role === "assistant" && (
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 dark:bg-dark-primary/10 flex items-center justify-center">
                  <Bot className="h-4 w-4 text-primary dark:text-dark-primary" />
                </div>
              )}
              <div
                className={`max-w-[86%] rounded-twelve px-4 py-3 sm:max-w-[75%] ${
                  msg.role === "user"
                    ? "bg-primary text-on-primary dark:bg-dark-primary dark:text-dark-on-primary"
                    : "bg-surface-low dark:bg-dark-surface-low text-on-surface dark:text-dark-on-surface"
                }`}
              >
                <p className="text-body-md whitespace-pre-wrap">{msg.content}</p>
              </div>
              {msg.role === "user" && (
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-surface-high dark:bg-dark-surface-high flex items-center justify-center">
                  <User className="h-4 w-4 text-on-surface-variant dark:text-dark-on-surface-variant" />
                </div>
              )}
            </div>
          ))}

          {isLoading && (
            <div className="flex gap-3 justify-start">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 dark:bg-dark-primary/10 flex items-center justify-center">
                <Bot className="h-4 w-4 text-primary dark:text-dark-primary" />
              </div>
              <div className="bg-surface-low dark:bg-dark-surface-low rounded-twelve px-4 py-3">
                <Loader2 className="h-4 w-4 animate-spin text-on-surface-variant dark:text-dark-on-surface-variant" />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 pb-2">
            <p className="text-label-md text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        {/* Input Area */}
        <div className="border-t border-outline-variant/20 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] dark:border-dark-outline-variant/20 sm:p-4 sm:pb-4">
          <div className="flex items-end gap-2 sm:gap-3">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about your inbox, deadlines, calendar..."
              rows={1}
              className="flex-1 resize-none rounded-eight bg-surface-low dark:bg-dark-surface-low px-4 py-3 text-body-md text-on-surface dark:text-dark-on-surface placeholder:text-on-surface-variant/50 dark:placeholder:text-dark-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/50 dark:focus:ring-dark-primary/50 max-h-32"
            />
            <Button
              onClick={handleSend}
              disabled={!input.trim() || isLoading}
              size="icon"
              variant="primary"
              className="flex-shrink-0"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
          <p className="mt-2 text-label-sm text-on-surface-variant/40 dark:text-dark-on-surface-variant/40">
            Press Enter to send, Shift+Enter for new line
          </p>
        </div>
      </Card>
    </div>
  );
}
