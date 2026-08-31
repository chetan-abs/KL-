import React from 'react';
import { View, TouchableOpacity, RefreshControl, StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { Alerts } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { relativeTime } from '../../utils/datetime';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Badge from '../../components/mobile/Badge';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 27 — Alerts.
 *
 * Unread rows are tinted by severity and carry a dot; read ones go plain. The
 * tint is by *consequence*, not by source — a bounced cheque and a verify
 * mismatch are both red because both cost money today, while an approval is blue
 * because it is only news.
 *
 * Tapping marks read on the server. Nothing deletes: these rows are the record
 * of what the business was told and when, and a swipe-to-dismiss that loses that
 * is worse than a long list.
 *
 * A broadcast (user_id NULL) reaches everyone; a targeted alert reaches one
 * person. Both arrive here — the server's WHERE clause decides which.
 */
const TONES = {
  danger: { row: COLORS.errorRow, badge: 'danger' },
  warning: { row: COLORS.warningRow, badge: 'pending' },
  info: { row: COLORS.infoRow, badge: 'info' },
  success: { row: COLORS.successRow, badge: 'success' },
};

export default function NotificationsScreen({ role, nav, onRefreshBadge }) {
  const { data, loading, error, refreshing, reload, refresh, setData } = useApi(
    () => Alerts.list({ limit: 60 }),
    []
  );

  const rows = data?.notifications || [];
  const unread = rows.filter((n) => !n.is_read).length;

  /** Marked locally as well as remotely so the row settles under the finger. */
  const markRead = useAction((id) => Alerts.markRead(id), { onDone: onRefreshBadge });
  const markAll = useAction(() => Alerts.markAllRead(), {
    onDone: () => {
      reload();
      onRefreshBadge?.();
    },
  });

  function tap(note) {
    if (note.is_read) return;
    setData((prev) => ({
      ...prev,
      notifications: prev.notifications.map((n) => (n.id === note.id ? { ...n, is_read: 1 } : n)),
    }));
    markRead.run(note.id);
  }

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Alerts"
          subtitle={loading ? 'Loading…' : unread ? `${unread} unread` : 'All caught up'}
          badge={unread ? String(unread) : '✓'}
          badgeTone={unread ? 'violet' : 'onBrand'}
          action={unread ? { label: 'Mark all read', onPress: markAll.run } : null}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.brand} />
      }
    >
      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!rows.length}
        emptyGlyph="🔔"
        emptyText="Nothing has been raised yet."
      >
        <Card title="Recent" flush>
          {rows.map((note, index) => {
            const isUnread = !note.is_read;
            const look = TONES[note.tone] || TONES.info;

            return (
              <TouchableOpacity
                key={note.id}
                style={[
                  styles.row,
                  index ? styles.ruled : null,
                  isUnread ? { backgroundColor: look.row } : null,
                ]}
                onPress={() => tap(note)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`${note.title}. ${note.body || ''}${isUnread ? '. Unread' : ''}`}
              >
                <View style={[styles.dot, isUnread ? null : styles.dotRead]} />

                <View style={styles.body}>
                  <View style={styles.head}>
                    <AppText
                      weight={isUnread ? 'bold' : 'medium'}
                      size="sm"
                      color={isUnread ? COLORS.text : COLORS.textSecondary}
                      style={styles.flex}
                      numberOfLines={1}
                    >
                      {note.title}
                    </AppText>
                    <AppText size="xs" color={COLORS.textMuted}>
                      {relativeTime(note.created_at)}
                    </AppText>
                  </View>

                  {note.body ? (
                    <AppText
                      size="xs"
                      color={isUnread ? COLORS.textSecondary : COLORS.textMuted}
                      style={styles.meta}
                    >
                      {note.body}
                    </AppText>
                  ) : null}

                  {note.actor ? (
                    <Badge tone={isUnread ? look.badge : 'neutral'} style={styles.badge}>
                      {note.actor}
                    </Badge>
                  ) : null}
                </View>
              </TouchableOpacity>
            );
          })}
        </Card>
      </AsyncBoundary>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', paddingVertical: 13, paddingHorizontal: 14 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.primary, marginTop: 6 },
  dotRead: { backgroundColor: COLORS.transparent },
  body: { flex: 1, paddingLeft: 11 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  meta: { marginTop: 3, lineHeight: 18 },
  badge: { marginTop: 8 },
});
