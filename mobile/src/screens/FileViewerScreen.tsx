import React, { useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type RouteProp } from '@react-navigation/native';
import { colors } from '../theme/colors';
import { fontSizes, fonts } from '../theme/typography';
import { useFileContent } from '../hooks/useRepo';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { type MainStackParamList } from '../navigation/MainTabNavigator';

type Props = {
  route: RouteProp<MainStackParamList, 'FileViewer'>;
};

// Minimal keyword syntax highlighting via regex replacement.
// Returns an array of {text, color} segments for a single line.
type Segment = { text: string; color: string };

const KEYWORDS: Record<string, RegExp> = {
  keyword: /\b(const|let|var|function|class|if|else|for|while|return|import|export|default|from|async|await|try|catch|throw|new|typeof|instanceof|void|null|undefined|true|false|extends|implements|interface|type|enum|namespace|module|declare|abstract|public|private|protected|static|readonly|override|def|fn|pub|use|mod|struct|impl|match|where|self|super|trait|yield|in|of|do|switch|case|break|continue|pass|and|or|not|is|as|with|lambda|del|global|nonlocal|assert|finally|raise|except|elif)\b/g,
  string: /(["'`])(?:\\.|(?!\1)[^\\])*\1/g,
  comment: /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g,
  number: /\b(\d+\.?\d*)\b/g,
};

function tokenizeLine(line: string, lang: string): Segment[] {
  // Skip highlighting for binary or very long lines
  if (line.length > 500) return [{ text: line, color: colors.text }];

  // Collect all token ranges
  const ranges: Array<{ start: number; end: number; color: string }> = [];

  function addRanges(regex: RegExp, color: string) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(line)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length, color });
    }
  }

  addRanges(new RegExp(KEYWORDS.comment.source, 'g'), colors.textMuted);
  addRanges(new RegExp(KEYWORDS.string.source, 'g'), colors.green);
  addRanges(new RegExp(KEYWORDS.keyword.source, 'g'), colors.accent);
  addRanges(new RegExp(KEYWORDS.number.source, 'g'), colors.yellow);

  if (ranges.length === 0) return [{ text: line, color: colors.text }];

  // Sort by start, resolve overlaps
  ranges.sort((a, b) => a.start - b.start);

  const segments: Segment[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start < cursor) continue; // overlapping — skip
    if (r.start > cursor) {
      segments.push({ text: line.slice(cursor, r.start), color: colors.text });
    }
    segments.push({ text: line.slice(r.start, r.end), color: r.color });
    cursor = r.end;
  }
  if (cursor < line.length) {
    segments.push({ text: line.slice(cursor), color: colors.text });
  }

  return segments;
}

function getExtension(path: string): string {
  const parts = path.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'c', 'cpp', 'cc', 'h', 'hpp',
  'java', 'kt', 'swift', 'cs', 'php', 'sh', 'bash', 'zsh',
  'toml', 'yaml', 'yml', 'json', 'md', 'sql', 'graphql',
  'css', 'scss', 'sass', 'html', 'xml', 'svelte', 'vue',
]);

export function FileViewerScreen({ route }: Props) {
  const { owner, repo, path, ref } = route.params;
  const { file, loading, error } = useFileContent(owner, repo, path, ref);

  const ext = getExtension(path);
  const isCode = CODE_EXTS.has(ext);

  const content = useMemo(() => {
    if (!file) return '';
    if (file.encoding === 'base64') {
      try {
        return atob(file.content.replace(/\n/g, ''));
      } catch {
        return file.content;
      }
    }
    return file.content;
  }, [file]);

  const lines = useMemo(() => content.split('\n'), [content]);

  if (loading) return <LoadingSpinner fullScreen />;
  if (error || !file) return <ErrorState message={error || 'File not found'} />;

  const isBinary = !isCode && file.size > 0;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      {/* File info bar */}
      <View style={styles.infoBar}>
        <Text style={styles.fileName} numberOfLines={1}>{path.split('/').pop()}</Text>
        <Text style={styles.fileMeta}>{formatSize(file.size)} · {lines.length} lines</Text>
      </View>

      {isBinary ? (
        <View style={styles.binaryWrap}>
          <Text style={styles.binaryText}>Binary file — preview not available</Text>
          <Text style={styles.binarySize}>{formatSize(file.size)}</Text>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator style={styles.hScroll}>
          <ScrollView style={styles.vScroll}>
            <View style={styles.codeWrap}>
              {lines.map((line, idx) => {
                const segments = isCode ? tokenizeLine(line, ext) : [{ text: line, color: colors.text }];
                return (
                  <View key={idx} style={styles.codeLine}>
                    <Text style={styles.lineNo}>{idx + 1}</Text>
                    <Text style={styles.lineContent}>
                      {segments.map((seg, si) => (
                        <Text key={si} style={{ color: seg.color }}>
                          {seg.text}
                        </Text>
                      ))}
                    </Text>
                  </View>
                );
              })}
            </View>
          </ScrollView>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  infoBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bgSecondary,
  },
  fileName: {
    color: colors.text,
    fontSize: fontSizes.sm,
    fontFamily: fonts.mono,
    fontWeight: '600',
    flex: 1,
    marginRight: 12,
  },
  fileMeta: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
  },
  hScroll: {
    flex: 1,
  },
  vScroll: {
    flex: 1,
  },
  codeWrap: {
    padding: 8,
    paddingBottom: 40,
  },
  codeLine: {
    flexDirection: 'row',
    minHeight: 20,
  },
  lineNo: {
    width: 36,
    color: colors.textMuted,
    fontSize: fontSizes.xs,
    fontFamily: fonts.mono,
    textAlign: 'right',
    paddingRight: 12,
    lineHeight: 20,
    userSelect: 'none',
  },
  lineContent: {
    fontSize: fontSizes.xs,
    fontFamily: fonts.mono,
    lineHeight: 20,
    color: colors.text,
  },
  binaryWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  binaryText: {
    color: colors.textMuted,
    fontSize: fontSizes.base,
    marginBottom: 8,
  },
  binarySize: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
  },
});
