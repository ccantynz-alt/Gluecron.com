import React, { useEffect, useState, useCallback } from 'react';
import {
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { getFileContent, getTree } from '../api/repos';
import type { TreeEntry } from '../api/repos';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { colors } from '../theme/colors';
import type { RepoStackParamList } from '../navigation/AppNavigator';

type Props = NativeStackScreenProps<RepoStackParamList, 'FileViewer'>;

function isTextFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const textExts = new Set([
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
    'json', 'yaml', 'yml', 'toml', 'env',
    'md', 'mdx', 'txt', 'rst',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
    'c', 'cpp', 'h', 'hpp', 'cs',
    'html', 'htm', 'css', 'scss', 'sass', 'less',
    'sh', 'bash', 'zsh', 'fish',
    'sql', 'graphql', 'proto',
    'xml', 'svg', 'gitignore', 'dockerignore',
  ]);
  return textExts.has(ext);
}

function isImageFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'].includes(ext);
}

export function FileViewerScreen({ route, navigation }: Props): React.ReactElement {
  const { owner, repo, ref, path } = route.params;

  const [content, setContent] = useState<string | null>(null);
  const [dirEntries, setDirEntries] = useState<TreeEntry[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'file' | 'dir'>('file');

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setContent(null);
    setDirEntries(null);

    // Try directory first, then file
    getTree(owner, repo, ref, path)
      .then((entries) => {
        if (!cancelled) {
          if (entries.length > 0 && entries[0].path !== path) {
            // It's a directory listing
            setMode('dir');
            setDirEntries(entries);
          } else {
            // It's a file — fetch content
            setMode('file');
            return getFileContent(owner, repo, ref, path).then((c) => {
              if (!cancelled) setContent(c);
            });
          }
        }
      })
      .catch(() => {
        // Fallback: treat as file
        getFileContent(owner, repo, ref, path)
          .then((c) => {
            if (!cancelled) {
              setMode('file');
              setContent(c);
            }
          })
          .catch((err) => {
            if (!cancelled) {
              setError(err instanceof Error ? err.message : 'Failed to load file');
            }
          });
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [owner, repo, ref, path]);

  const retry = useCallback(() => {
    setIsLoading(true);
    setError(null);
  }, []);

  const handleEntryPress = useCallback(
    (entry: TreeEntry) => {
      navigation.push('FileViewer', {
        owner,
        repo,
        ref,
        path: entry.path,
      });
    },
    [navigation, owner, repo, ref],
  );

  const renderEntry = useCallback(
    ({ item }: { item: TreeEntry }) => (
      <TouchableOpacity
        style={styles.fileRow}
        onPress={() => handleEntryPress(item)}
        activeOpacity={0.75}
      >
        <Text style={styles.fileIcon}>{item.type === 'tree' ? '📁' : '📄'}</Text>
        <Text style={styles.fileName} numberOfLines={1}>
          {item.name}
        </Text>
        {item.type === 'tree' && <Text style={styles.chevron}>›</Text>}
      </TouchableOpacity>
    ),
    [handleEntryPress],
  );

  const keyExtractor = useCallback((item: TreeEntry) => item.path, []);

  if (isLoading) return <LoadingSpinner fullScreen />;

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      {/* Breadcrumb */}
      <View style={styles.breadcrumb}>
        <Text style={styles.breadcrumbText} numberOfLines={1}>
          {owner}/{repo}/{path}
        </Text>
      </View>

      {error !== null && <ErrorBanner message={error} onRetry={retry} />}

      {mode === 'dir' && dirEntries !== null && (
        <FlatList
          data={dirEntries}
          keyExtractor={keyExtractor}
          renderItem={renderEntry}
          style={styles.dirList}
        />
      )}

      {mode === 'file' && content !== null && (
        <ScrollView style={styles.fileScroll} horizontal={false}>
          <ScrollView horizontal showsHorizontalScrollIndicator>
            {isImageFile(path) ? (
              <View style={styles.unsupported}>
                <Text style={styles.unsupportedText}>Image preview not available</Text>
              </View>
            ) : isTextFile(path) ? (
              <View style={styles.codeContainer}>
                <Text style={styles.codeText} selectable>
                  {content}
                </Text>
              </View>
            ) : (
              <View style={styles.unsupported}>
                <Text style={styles.unsupportedText}>
                  Binary file — {path.split('.').pop()?.toUpperCase()} cannot be previewed
                </Text>
              </View>
            )}
          </ScrollView>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  breadcrumb: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  breadcrumbText: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: colors.textMuted,
  },
  dirList: {
    flex: 1,
    backgroundColor: colors.bgSecondary,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 10,
  },
  fileIcon: {
    fontSize: 15,
  },
  fileName: {
    flex: 1,
    fontSize: 14,
    color: colors.textLink,
  },
  chevron: {
    fontSize: 18,
    color: colors.textMuted,
  },
  fileScroll: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  codeContainer: {
    padding: 16,
    minWidth: '100%',
  },
  codeText: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: colors.text,
    lineHeight: 18,
  },
  unsupported: {
    flex: 1,
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unsupportedText: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
