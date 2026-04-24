import React, { useCallback, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import { postJSON } from '../api/client';
import { colors } from '../theme/colors';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface AiChatResponse {
  message: string;
  chatId?: string;
}

const markdownStyles = {
  body: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 22,
  },
  code_inline: {
    backgroundColor: colors.bgTertiary,
    color: colors.accentPurple,
    fontFamily: 'monospace',
    paddingHorizontal: 4,
    borderRadius: 3,
    fontSize: 13,
  },
  fence: {
    backgroundColor: colors.bgTertiary,
    borderRadius: 6,
    padding: 12,
    marginVertical: 8,
  },
  code_block: {
    backgroundColor: colors.bgTertiary,
    borderRadius: 6,
    padding: 12,
    fontFamily: 'monospace',
    fontSize: 12,
  },
  link: {
    color: colors.textLink,
  },
  blockquote: {
    borderLeftColor: colors.accentPurple,
    borderLeftWidth: 3,
    paddingLeft: 10,
    color: colors.textMuted,
  },
  heading1: {
    color: colors.text,
    fontWeight: '700' as const,
    fontSize: 18,
  },
  heading2: {
    color: colors.text,
    fontWeight: '700' as const,
    fontSize: 16,
  },
  heading3: {
    color: colors.text,
    fontWeight: '600' as const,
    fontSize: 15,
  },
};

function MessageBubble({ message }: { message: ChatMessage }): React.ReactElement {
  const isUser = message.role === 'user';

  return (
    <View style={[styles.messageBubbleWrapper, isUser ? styles.userWrapper : styles.aiWrapper]}>
      {!isUser && (
        <View style={styles.aiAvatar}>
          <Text style={styles.aiAvatarText}>✦</Text>
        </View>
      )}
      <View style={[styles.bubble, isUser ? styles.userBubble : styles.aiBubble]}>
        {isUser ? (
          <Text style={styles.userText}>{message.content}</Text>
        ) : (
          <Markdown style={markdownStyles}>{message.content}</Markdown>
        )}
      </View>
    </View>
  );
}

export function AskAIScreen(): React.ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatId, setChatId] = useState<string | undefined>(undefined);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const idCounter = useRef(0);

  const nextId = useCallback(() => {
    idCounter.current += 1;
    return String(idCounter.current);
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    setError(null);
    setInput('');

    const userMessage: ChatMessage = {
      id: nextId(),
      role: 'user',
      content: text,
    };

    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);

    // Scroll to bottom
    setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: true });
    }, 100);

    try {
      const response = await postJSON<AiChatResponse>('/ask', {
        message: text,
        chatId,
      });

      if (response.chatId !== undefined) {
        setChatId(response.chatId);
      }

      const aiMessage: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        content: response.message,
      };

      setMessages((prev) => [...prev, aiMessage]);

      setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: true });
      }, 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI request failed');
      // Put user message back in input on failure
      setInput(text);
      setMessages((prev) => prev.filter((m) => m.id !== userMessage.id));
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, chatId, nextId]);

  const handleClear = useCallback(() => {
    setMessages([]);
    setChatId(undefined);
    setError(null);
  }, []);

  const renderMessage = useCallback(
    ({ item }: { item: ChatMessage }) => <MessageBubble message={item} />,
    [],
  );

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerIcon}>✦</Text>
          <Text style={styles.headerTitle}>Ask AI</Text>
        </View>
        {messages.length > 0 && (
          <TouchableOpacity onPress={handleClear}>
            <Text style={styles.clearText}>New chat</Text>
          </TouchableOpacity>
        )}
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        {/* Messages */}
        {messages.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>✦</Text>
            <Text style={styles.emptyTitle}>Ask anything about your code</Text>
            <Text style={styles.emptySubtitle}>
              Ask about repositories, code reviews, gate failures, or anything Gluecron-related.
            </Text>
            <View style={styles.suggestions}>
              {[
                'Why did my gate check fail?',
                'Review my latest pull request',
                'Summarize recent changes',
              ].map((s) => (
                <TouchableOpacity
                  key={s}
                  style={styles.suggestion}
                  onPress={() => setInput(s)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.suggestionText}>{s}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={keyExtractor}
            renderItem={renderMessage}
            style={styles.messageList}
            contentContainerStyle={styles.messageListContent}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          />
        )}

        {/* Loading indicator */}
        {isLoading && (
          <View style={styles.thinkingRow}>
            <View style={styles.aiAvatar}>
              <Text style={styles.aiAvatarText}>✦</Text>
            </View>
            <View style={styles.thinkingBubble}>
              <ActivityIndicator size="small" color={colors.accentPurple} />
              <Text style={styles.thinkingText}>Thinking...</Text>
            </View>
          </View>
        )}

        {/* Error */}
        {error !== null && (
          <View style={styles.errorRow}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Input area */}
        <View style={styles.inputArea}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="Ask about your code..."
            placeholderTextColor={colors.textMuted}
            multiline
            maxLength={4096}
            returnKeyType="send"
            onSubmitEditing={handleSend}
            blurOnSubmit={false}
          />
          <TouchableOpacity
            style={[styles.sendButton, (!input.trim() || isLoading) && styles.sendButtonDisabled]}
            onPress={handleSend}
            disabled={!input.trim() || isLoading}
            activeOpacity={0.8}
          >
            <Text style={styles.sendIcon}>↑</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: colors.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerIcon: {
    fontSize: 18,
    color: colors.accentPurple,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.accentPurple,
  },
  clearText: {
    fontSize: 13,
    color: colors.textLink,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 12,
  },
  emptyIcon: {
    fontSize: 48,
    color: colors.accentPurple,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
  },
  suggestions: {
    width: '100%',
    gap: 8,
    marginTop: 8,
  },
  suggestion: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.bgSecondary,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  suggestionText: {
    fontSize: 14,
    color: colors.textLink,
    textAlign: 'center',
  },
  messageList: {
    flex: 1,
  },
  messageListContent: {
    paddingVertical: 16,
    paddingHorizontal: 12,
    gap: 12,
  },
  messageBubbleWrapper: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  userWrapper: {
    justifyContent: 'flex-end',
  },
  aiWrapper: {
    justifyContent: 'flex-start',
  },
  aiAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.accentPurple + '33',
    borderWidth: 1,
    borderColor: colors.accentPurple,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  aiAvatarText: {
    fontSize: 13,
    color: colors.accentPurple,
    fontWeight: '700',
  },
  bubble: {
    maxWidth: '80%',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  userBubble: {
    backgroundColor: colors.accentBlue,
    borderBottomRightRadius: 4,
  },
  aiBubble: {
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: 4,
  },
  userText: {
    fontSize: 14,
    color: colors.bg,
    lineHeight: 20,
  },
  thinkingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  thinkingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgSecondary,
    borderRadius: 14,
    borderBottomLeftRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  thinkingText: {
    fontSize: 13,
    color: colors.textMuted,
  },
  errorRow: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 10,
    backgroundColor: colors.bg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.accentRed,
  },
  errorText: {
    fontSize: 13,
    color: colors.accentRed,
  },
  inputArea: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 12,
    backgroundColor: colors.bgSecondary,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 10,
  },
  input: {
    flex: 1,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.text,
    maxHeight: 120,
    minHeight: 44,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accentPurple,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.4,
  },
  sendIcon: {
    fontSize: 20,
    color: colors.text,
    fontWeight: '700',
  },
});
