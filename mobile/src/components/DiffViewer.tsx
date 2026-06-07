import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import { fontSizes, fonts } from '../theme/typography';

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header';
  content: string;
  lineNo?: number;
}

interface Props {
  diff: string;
}

function parseDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('@@')) {
      lines.push({ type: 'header', content: raw });
    } else if (raw.startsWith('+') && !raw.startsWith('+++')) {
      lines.push({ type: 'add', content: raw.slice(1) });
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      lines.push({ type: 'remove', content: raw.slice(1) });
    } else {
      lines.push({ type: 'context', content: raw.startsWith(' ') ? raw.slice(1) : raw });
    }
  }
  return lines;
}

function lineStyle(type: DiffLine['type']) {
  switch (type) {
    case 'add': return { bg: 'rgba(52,211,153,0.10)', prefix: '+', color: colors.green };
    case 'remove': return { bg: 'rgba(248,113,113,0.10)', prefix: '-', color: colors.red };
    case 'header': return { bg: 'rgba(140,109,255,0.10)', prefix: '', color: colors.accent };
    default: return { bg: 'transparent', prefix: ' ', color: colors.textMuted };
  }
}

export function DiffViewer({ diff }: Props) {
  const lines = parseDiff(diff);

  return (
    <ScrollView horizontal style={styles.scroll} showsHorizontalScrollIndicator={false}>
      <View style={styles.container}>
        {lines.map((line, i) => {
          const s = lineStyle(line.type);
          return (
            <View key={i} style={[styles.line, { backgroundColor: s.bg }]}>
              <Text style={[styles.prefix, { color: s.color }]}>{s.prefix}</Text>
              <Text style={[styles.code, { color: s.color }]}>
                {line.content || ' '}
              </Text>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: colors.bgSecondary,
    borderRadius: 8,
  },
  container: {
    padding: 4,
    minWidth: '100%',
  },
  line: {
    flexDirection: 'row',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 2,
  },
  prefix: {
    fontSize: fontSizes.xs,
    fontFamily: fonts.mono,
    width: 14,
    textAlign: 'center',
  },
  code: {
    fontSize: fontSizes.xs,
    fontFamily: fonts.mono,
    lineHeight: 18,
  },
});
