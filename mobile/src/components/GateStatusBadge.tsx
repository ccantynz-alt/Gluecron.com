import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme/colors';
import type { GateRunStatus } from '../api/gates';

interface GateStatusBadgeProps {
  status: GateRunStatus;
  aiRepaired?: boolean;
  size?: 'small' | 'medium';
}

function statusLabel(status: GateRunStatus): string {
  switch (status) {
    case 'passed': return 'Passed';
    case 'failed': return 'Failed';
    case 'pending': return 'Pending';
    case 'running': return 'Running';
    case 'error': return 'Error';
  }
}

function statusColor(status: GateRunStatus): string {
  switch (status) {
    case 'passed': return colors.accent;
    case 'failed': return colors.accentRed;
    case 'pending': return colors.accentYellow;
    case 'running': return colors.accentBlue;
    case 'error': return colors.accentRed;
  }
}

function statusIcon(status: GateRunStatus): string {
  switch (status) {
    case 'passed': return '✓';
    case 'failed': return '✗';
    case 'pending': return '◌';
    case 'running': return '◌';
    case 'error': return '!';
  }
}

export function GateStatusBadge({
  status,
  aiRepaired = false,
  size = 'medium',
}: GateStatusBadgeProps): React.ReactElement {
  const badgeColor = statusColor(status);
  const isSmall = size === 'small';

  return (
    <View style={styles.wrapper}>
      <View
        style={[
          styles.badge,
          isSmall && styles.badgeSmall,
          { borderColor: badgeColor },
        ]}
      >
        <Text style={[styles.icon, isSmall && styles.iconSmall, { color: badgeColor }]}>
          {statusIcon(status)}
        </Text>
        <Text style={[styles.label, isSmall && styles.labelSmall, { color: badgeColor }]}>
          {statusLabel(status)}
        </Text>
      </View>
      {aiRepaired && (
        <View style={styles.aiBadge}>
          <Text style={styles.aiText}>AI Repaired</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    borderWidth: 1,
    gap: 5,
    backgroundColor: colors.bgSecondary,
  },
  badgeSmall: {
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  icon: {
    fontSize: 13,
    fontWeight: '700',
  },
  iconSmall: {
    fontSize: 11,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
  },
  labelSmall: {
    fontSize: 11,
  },
  aiBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 20,
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.accentPurple,
  },
  aiText: {
    fontSize: 11,
    color: colors.accentPurple,
    fontWeight: '500',
  },
});
