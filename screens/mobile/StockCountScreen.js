import React from 'react';
import { View, RefreshControl, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { StockCounts } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { formatDateTime } from '../../utils/datetime';
import { confirmAction, showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import QtyBox from '../../components/mobile/QtyBox';
import Badge from '../../components/mobile/Badge';
import ProgressBar from '../../components/mobile/ProgressBar';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 26 — Physical stock count against the ledger.
 *
 * The system figure is shown, which is a deliberate trade: a blind count is more
 * honest but nobody finishes one, and a counter who cannot see the target cannot
 * tell a miscount from a genuine loss while still standing at the rack. The
 * variance column is what gets reviewed.
 *
 * Posting writes one `adjustment` movement per varied line. Nothing is edited —
 * the count that found the loss and the loss itself both stay in the ledger.
 *
 * Counts are held locally and saved on post, for the same reason the picker
 * holds its own: the godown has no signal worth a request per keystroke.
 */
export default function StockCountScreen({ role, nav }) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, gap: 11 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  varied: { backgroundColor: COLORS.warningRow },
  body: { flex: 1 },
  meta: { marginTop: 3 },
  badge: { marginTop: 6 },
}), [COLORS]);
  const list = useApi(() => StockCounts.list(), []);
  const open = (list.data?.counts || []).find((c) => c.status === 'open');

  const sheet = useApi(() => (open ? StockCounts.get(open.id) : Promise.resolve(null)), [open?.id], {
    enabled: Boolean(open),
  });

  const [counts, setCounts] = React.useState({});

  React.useEffect(() => {
    if (!sheet.data?.lines) return;
    setCounts(
      Object.fromEntries(
        sheet.data.lines.map((l) => [l.item_id, l.counted_qty === null ? '' : String(Number(l.counted_qty))])
      )
    );
  }, [sheet.data]);

  const rows = (sheet.data?.lines || []).map((line) => {
    const raw = counts[line.item_id] ?? '';
    const blank = raw === '';
    const counted = Number(raw);
    return { ...line, raw, blank, counted, variance: blank ? 0 : counted - Number(line.system_qty) };
  });

  const counted = rows.filter((r) => !r.blank).length;
  const varied = rows.filter((r) => !r.blank && r.variance !== 0);
  const complete = rows.length > 0 && counted === rows.length;

  const start = useAction(() => StockCounts.open({ godown: 'Main godown' }), {
    onDone: () => {
      showAlert('Count opened', 'Walk the racks and enter what you find.');
      list.reload();
    },
    onFail: (message) => showAlert('Could not open a count', message),
  });

  const post = useAction(
    async () => {
      await StockCounts.saveLines(
        open.id,
        rows.map((r) => ({ item_id: r.item_id, counted_qty: Number(r.raw) }))
      );
      return StockCounts.post(open.id);
    },
    {
      onDone: (result) => {
        showAlert(
          'Count posted',
          result.adjustments
            ? `${result.adjustments} adjustment(s) written to the ledger.`
            : 'Everything matched. Nothing was adjusted.'
        );
        list.reload();
        setCounts({});
      },
      onFail: (message) => showAlert('Could not post', message),
    }
  );

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Stock Count"
          subtitle={open ? open.godown || 'Godown' : 'No count open'}
          badge={open ? `${counted}/${rows.length}` : 'Idle'}
          badgeTone={complete ? 'success' : open ? 'pending' : 'onBrand'}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} tintColor={COLORS.brand} />
      }
      footer={
        open ? (
          <ActionButton
            label={
              complete
                ? `Post count${varied.length ? ` · ${varied.length} variance` : ''}`
                : `${rows.length - counted} line(s) uncounted`
            }
            tone={complete && !varied.length ? 'approve' : 'brand'}
            disabled={!complete}
            loading={post.busy}
            loadingLabel="Posting"
            onPress={() =>
              confirmAction(
                varied.length ? 'Post with variances?' : 'Post this count?',
                varied.length
                  ? `${varied.length} line(s) differ from the ledger. An adjustment is written for each.`
                  : 'Every line matches the ledger. Nothing will be adjusted.',
                post.run
              )
            }
          />
        ) : (
          <ActionButton
            label="Start a count"
            tone="brand"
            loading={start.busy}
            onPress={start.run}
          />
        )
      }
    >
      <AsyncBoundary
        loading={list.loading || sheet.loading}
        error={list.error || sheet.error}
        onRetry={() => {
          list.reload();
          sheet.reload();
        }}
        empty={!open}
        emptyGlyph="📋"
        emptyText="No count is open. Start one to reconcile the racks against the ledger."
      >
        <Card title={open ? `Progress · started ${formatDateTime(open.started_at)}` : 'Progress'}>
          <ProgressBar value={counted} total={rows.length || 1} />
        </Card>

        <Card title="Lines" flush>
          {rows.map((row, index) => (
            <View
              key={row.item_id}
              style={[
                styles.row,
                index ? styles.ruled : null,
                !row.blank && row.variance !== 0 ? styles.varied : null,
              ]}
            >
              <View style={styles.body}>
                <AppText weight="bold" size="sm">{row.item_name}</AppText>
                <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                  {`${row.rack ? `📍 Rack ${row.rack} · ` : ''}ledger says ${Number(row.system_qty)}`}
                </AppText>
                {!row.blank && row.variance !== 0 ? (
                  <Badge tone={row.variance < 0 ? 'danger' : 'warning'} style={styles.badge}>
                    {`${row.variance > 0 ? '+' : ''}${row.variance}`}
                  </Badge>
                ) : null}
              </View>

              <QtyBox
                label="Counted"
                value={row.raw}
                onChangeText={(next) =>
                  setCounts((prev) => ({ ...prev, [row.item_id]: next.replace(/[^0-9]/g, '') }))
                }
                tone={row.blank ? 'neutral' : row.variance === 0 ? 'success' : 'danger'}
              />
            </View>
          ))}
        </Card>

        {varied.length ? (
          <NoticeBar tone="warning">
            {`${varied.length} line${varied.length > 1 ? 's differ' : ' differs'} from the ledger. Each posts an adjustment; no existing movement is edited.`}
          </NoticeBar>
        ) : (
          <NoticeBar tone="info" glyph="📋">
            A variance posts an adjustment to the stock ledger. It never edits an existing movement.
          </NoticeBar>
        )}
      </AsyncBoundary>
    </Screen>
  );
}

